import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";
import { encode } from "./msgpack";
import { createSharedInputRing, DEFAULT_SHARED_INPUT_BYTES, SharedInputRing } from "./sharedInput";
import { defaultRuntimePath, defaultWasmPath } from "./paths";

export type StatusEmitter = (text: string, warn?: boolean) => void;

export type MonacoNeovimOptions = {
  worker?: Worker | null;
  workerUrl?: URL;
  useMessagePort?: boolean;
  sharedInputBytes?: number;
  cols?: number;
  rows?: number;
  status?: StatusEmitter;
  seedLines?: string[];
  visualThemeName?: string;
  rpcTimeoutMs?: number;
  onModeChange?: (mode: string) => void;
};

type MonacoNeovimResolvedOptions = {
  worker: Worker | null;
  workerUrl: URL;
  sharedInputBytes: number;
  cols: number;
  rows: number;
  status: StatusEmitter;
  seedLines: string[];
  visualThemeName: string;
  rpcTimeoutMs: number;
  onModeChange?: (mode: string) => void;
};

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  ts: number;
};

type RpcNotify = {
  type: "rpc-notify";
  method: string;
  params?: unknown[];
};

type RpcResponse = {
  type: "rpc-response";
  msgid: number;
  error: unknown;
  result: unknown;
};

type RpcRequest = {
  type: "rpc-request";
  msgid: number;
  method: string;
  params?: unknown[];
};

type WorkerMessages =
  | RpcNotify
  | RpcResponse
  | RpcRequest
  | { type: "clipboard-copy"; lines: string[]; regtype: string }
  | { type: "clipboard-paste"; msgid: number }
  | { type: "start-error"; message?: string }
  | { type: "stderr"; message?: string }
  | { type: "exit"; code: number; lastStderr?: string };

const DEFAULT_SEED = [
  "-- Monaco + Neovim (WASM)",
  "-- Click into the editor, press i, and start typing.",
  "",
  "local function greet(name)",
  "  return 'hello ' .. name",
  "end",
  "",
  "print(greet('monaco'))",
];

const VISUAL_SELECTION_LUA = `
local api, fn = vim.api, vim.fn

local function virtcol2byte(winid, lnum, virtcol)
  local byte_idx = fn.virtcol2col(winid, lnum, virtcol) - 1
  if fn.has("nvim-0.10.0") == 0 then
    return byte_idx
  end
  local buf = api.nvim_win_get_buf(winid)
  local line = api.nvim_buf_get_lines(buf, lnum - 1, lnum, false)[1] or ""
  local char_idx = fn.charidx(line, byte_idx)
  local prefix = fn.strcharpart(line, 0, char_idx + 1)
  return #prefix
end

local function get_selections(win)
  win = win or api.nvim_get_current_win()
  local buf = api.nvim_win_get_buf(win)
  local mode = api.nvim_get_mode().mode or ""
  local is_visual = mode:match("[vV\\22sS\\19]")

  if not is_visual then
    local cur = api.nvim_win_get_cursor(win)
    local line0 = (cur[1] or 1) - 1
    local col0 = cur[2] or 0
    return { { start = { line = line0, col = col0 }, ["end"] = { line = line0, col = col0 }, inclusive = false } }
  end

  local sline = fn.line('v') - 1
  local scol = fn.col('v') - 1
  local eline = fn.line('.') - 1
  local ecol = fn.col('.') - 1

  if mode:lower() == "v" then
    local start_left = true
    if sline > eline or (sline == eline and scol > ecol) then
      start_left = false
      sline, eline = eline, sline
      scol, ecol = ecol, scol
    end
    if mode == "V" then
      scol = 0
      local line = api.nvim_buf_get_lines(buf, eline, eline + 1, false)[1] or ""
      ecol = #line
    end
    local range = {
      start = { line = sline, col = scol },
      ["end"] = { line = eline, col = ecol },
      inclusive = (vim.o.selection or "inclusive") == "inclusive",
    }
    if not start_left then
      range = { start = range["end"], ["end"] = range.start, inclusive = range.inclusive }
    end
    return { range }
  end

  local ranges = {}
  local start_vcol, end_vcol = fn.virtcol("v"), fn.virtcol(".")
  local top, bot = math.min(sline, eline), math.max(sline, eline)
  for lnum = top, bot do
    local line = api.nvim_buf_get_lines(buf, lnum, lnum + 1, false)[1] or ""
    local disp = fn.strdisplaywidth(line)
    if start_vcol > disp and end_vcol > disp then
      local chars = ({ vim.str_utfindex(line) })[2]
      table.insert(ranges, { start = { line = lnum, col = chars }, ["end"] = { line = lnum, col = chars }, inclusive = true })
    else
      local col_a = virtcol2byte(win, lnum + 1, math.min(start_vcol, end_vcol))
      local col_b = virtcol2byte(win, lnum + 1, math.max(start_vcol, end_vcol))
      table.insert(ranges, { start = { line = lnum, col = col_a }, ["end"] = { line = lnum, col = col_b }, inclusive = true })
    end
  end

  if #ranges == 0 then
    local cur = api.nvim_win_get_cursor(win)
    local line0 = (cur[1] or 1) - 1
    local col0 = cur[2] or 0
    return { { start = { line = line0, col = col0 }, ["end"] = { line = line0, col = col0 }, inclusive = false } }
  end

  return ranges
end

return get_selections(...)
`;

export class MonacoNeovimClient {
  private readonly editor: MonacoEditor.IStandaloneCodeEditor;
  private readonly opts: MonacoNeovimResolvedOptions;
  private readonly wasmPath = defaultWasmPath;
  private readonly runtimePath = defaultRuntimePath;
  private worker: Worker | null = null;
  private reqId = 1;
  private workerExited = false;
  private workerExitCode: number | null = null;
  private bufHandle: number | null = null;
  private sharedInput: SharedInputRing | null = null;
  private readonly pending = new Map<number, PendingEntry>();
  private primeSent = false;
  private lastCursorPos: monaco.Position | null = null;
  private suppressCursorSync = false;
  private lastMode = "";
  private visualSelectionToken = 0;
  private visualSelectionActive = false;
  private cursorRefreshTimer: number | null = null;
  private cursorRefreshInFlight = false;
  private cursorRefreshPending = false;
  private disposables: monaco.IDisposable[] = [];
  private lastCursorStyle: MonacoEditor.IStandaloneEditorConstructionOptions["cursorStyle"] | null = null;
  private lastCursorBlink: MonacoEditor.IStandaloneEditorConstructionOptions["cursorBlinking"] | null = null;
  private lastCursorWidth: number | null = null;
  private initialCursorWidth = 0;
  private typicalFullWidth = 2;
  private nextSeedLines: string[] | null = null;

  constructor(editor: MonacoEditor.IStandaloneCodeEditor, options: MonacoNeovimOptions = {}) {
    this.editor = editor;
    this.opts = {
      worker: options.worker ?? null,
      workerUrl: options.workerUrl ?? new URL("./nvimWorker.js", import.meta.url),
      sharedInputBytes: options.sharedInputBytes ?? DEFAULT_SHARED_INPUT_BYTES,
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      status: options.status ?? (() => {}),
      seedLines: options.seedLines ?? DEFAULT_SEED,
      visualThemeName: options.visualThemeName ?? "nvim-visual",
      rpcTimeoutMs: options.rpcTimeoutMs ?? 8000,
      onModeChange: options.onModeChange,
    };
  }

  async start(seedLines?: string[]): Promise<void> {
    this.stop(true);
    this.nextSeedLines = seedLines ?? null;
    if (!isSharedArrayBufferAvailable()) {
      const msg = "SharedArrayBuffer is required; serve with COOP/COEP so crossOriginIsolated is true.";
      this.opts.status(msg, true);
      throw new Error(msg);
    }

    try {
      this.sharedInput = createSharedInputRing(this.opts.sharedInputBytes);
      this.attachEditorListeners();
      this.workerExited = false;
      this.workerExitCode = null;

      this.worker = this.opts.worker ?? new Worker(this.opts.workerUrl, { type: "module" });
      this.worker.onmessage = (event: MessageEvent<WorkerMessages>) => this.handleWorkerMessage(event.data);
      const startMsg: Record<string, unknown> = {
        type: "start",
        cols: this.opts.cols,
        rows: this.opts.rows,
        wasmPath: this.wasmPath,
        runtimePath: this.runtimePath,
        inputBuffer: this.sharedInput?.buffer,
      };
      const transfers: Transferable[] = [];
      try {
        this.worker.postMessage(startMsg, transfers);
      } catch (_) {
        this.worker.postMessage({
          type: "start",
          cols: this.opts.cols,
          rows: this.opts.rows,
          wasmPath: this.wasmPath,
          runtimePath: this.runtimePath,
          inputBuffer: this.sharedInput?.buffer,
        });
      }
      this.opts.status("starting...");
      this.primeSent = false;
      setTimeout(() => { if (!this.primeSent) void this.primeSession(); }, 300);
      await this.waitForApi();
      await this.primeSession();
    } catch (err) {
      const msg = (err as { message?: string })?.message || String(err);
      this.opts.status(`start failed: ${msg}`, true);
      this.stop(true);
      throw err;
    }
  }

  stop(silent = false): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.sharedInput = null;
    this.workerExited = false;
    this.workerExitCode = null;
    this.pending.clear();
    this.bufHandle = null;
    this.primeSent = false;
    this.visualSelectionActive = false;
    if (this.cursorRefreshTimer) {
      clearTimeout(this.cursorRefreshTimer);
      this.cursorRefreshTimer = null;
    }
    this.cursorRefreshPending = false;
    this.cursorRefreshInFlight = false;
    if (!silent) this.opts.status("stopped", true);
    this.disposeEditorListeners();
  }

  dispose(): void {
    this.stop(true);
  }

  private attachEditorListeners(): void {
    this.disposeEditorListeners();
    const EditorOption = monaco.editor.EditorOption;
    try {
      const fontInfo = this.editor.getOption(EditorOption.fontInfo);
      this.initialCursorWidth = this.editor.getOption(EditorOption.cursorWidth) || 0;
      this.typicalFullWidth = fontInfo?.typicalFullwidthCharacterWidth || 2;
    } catch (_) {
      this.initialCursorWidth = 0;
      this.typicalFullWidth = 2;
    }

    this.editor.updateOptions({
      readOnly: false,
      contextmenu: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      padding: { top: 12, bottom: 12 },
      cursorSmoothCaretAnimation: "on",
    });

    this.disposables.push(
      this.editor.onKeyDown((ev) => this.handleKey(ev)),
      this.editor.onMouseDown((ev) => this.handleMouse(ev)),
      this.editor.onDidChangeCursorPosition((ev) => {
        if (this.suppressCursorSync || !this.lastCursorPos) return;
        if (ev.source === "keyboard") {
          this.suppressCursorSync = true;
          this.editor.setPosition(this.lastCursorPos);
          this.suppressCursorSync = false;
        }
      }),
    );
  }

  private disposeEditorListeners(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  private async primeSession(): Promise<void> {
    if (this.bufHandle) return;
    this.primeSent = true;
    try {
      this.sendRpc("nvim_command", ["set noswapfile signcolumn=no number norelativenumber"]);
      this.sendRpc("nvim_command", ["set nowrap laststatus=0 cmdheight=1"]);
      this.sendRpc("nvim_command", ["set shortmess+=F"]);
      this.sendRpc("nvim_command", ["set clipboard=unnamedplus"]);
      const buf = await this.rpcCall("nvim_get_current_buf", []);
      const id = extractBufId(buf) ?? 1;
      this.bufHandle = id;
      const attached = await this.rpcCall("nvim_buf_attach", [id, true, {}]);
      if (attached !== true) throw new Error("nvim_buf_attach failed");
      const lines = await this.rpcCall("nvim_buf_get_lines", [id, 0, -1, false]);
      this.applyBuffer(Array.isArray(lines) ? lines as string[] : [""]);
      const seeded = await this.seedBuffer(id, this.nextSeedLines);
      this.nextSeedLines = null;
      if (seeded && seeded.length) this.applyBuffer(seeded);
      await this.refreshCursorMode();
      await this.syncVisualSelectionColor();
      if (!this.lastMode) this.lastMode = "n";
      this.opts.status("ready");
      // Ensure the editor is focused and mode indicator is populated immediately after startup.
      this.editor.focus();
      if (this.opts.onModeChange) this.opts.onModeChange(this.lastMode);
    } catch (err) {
      this.opts.status(`failed to attach: ${(err as Error)?.message ?? err}`, true);
    }
  }

  private handleWorkerMessage(message: WorkerMessages): void {
    const type = message?.type;
    if (type === "rpc-response") {
      const { msgid, error, result } = message as RpcResponse;
      const entry = this.pending.get(msgid);
      if (!entry) return;
      this.pending.delete(msgid);
      if (error) entry.reject(new Error(String(error)));
      else entry.resolve(result);
    } else if (type === "rpc-notify") {
      const { method, params } = message as RpcNotify;
      void this.handleNotify(method, params ?? []);
    } else if (type === "rpc-request") {
      const { msgid, method, params } = message as RpcRequest;
      this.handleRequest(msgid, method, params ?? []);
    } else if (type === "clipboard-copy") {
      const { lines = [] } = message as { lines: string[] };
      const text = lines.join("\n");
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
    } else if (type === "clipboard-paste") {
      const { msgid } = message as { msgid: number };
      this.doClipboardPaste(msgid);
    } else if (type === "stderr") {
      const payload = message as { message?: string };
      const text = payload?.message;
      if (text) {
        console.error("[nvim stderr]", text);
      }
    } else if (type === "start-error") {
      const payload = message as { message?: string };
      this.opts.status(`start failed: ${payload?.message ?? "unknown"}`, true);
    } else if (type === "exit") {
      const payload = message as { code: number; lastStderr?: string };
      const code = payload.code;
      const lastStderr = payload.lastStderr;
      // If Neovim exited before we attached, avoid cascading RPC timeouts and surface the exit code.
      this.workerExited = true;
      this.workerExitCode = code;
      const suffix = lastStderr ? `: ${lastStderr.trim()}` : "";
      this.opts.status(`nvim exited (${code})${suffix}`, code !== 0);
      if (code !== 0) {
        this.pending.forEach((entry) => entry.reject(new Error(`nvim exited (${code})${suffix}`)));
        this.pending.clear();
      }
    }
  }

  private handleRequest(msgid: number, method: string, params: unknown[]): void {
    if (method === "wasm-clipboard-paste") {
      this.doClipboardPaste(msgid);
    } else {
      this.sendRpcResponse(msgid, null, null);
    }
  }

  private async handleNotify(method: string, params: unknown[]): Promise<void> {
    if (method === "nvim_buf_lines_event") {
      const [buf] = params;
      const id = extractBufId(buf);
      if (this.bufHandle != null && id === this.bufHandle) {
        try {
          const allLines = await this.rpcCall("nvim_buf_get_lines", [id, 0, -1, false]);
          this.applyBuffer(Array.isArray(allLines) ? (allLines as string[]) : [""]);
        } catch (_) {
          // ignore
        }
        await this.refreshCursorMode();
      }
    } else if (method === "nvim_buf_detach_event") {
      this.bufHandle = null;
    }
  }

  private applyBuffer(lines: string[] = [""]): void {
    const model = this.editor.getModel();
    if (!model) return;
    const joined = (lines && lines.length ? lines : [""]).join("\n");
    if (model.getValue() === joined) return;
    const pos = this.lastCursorPos ?? this.editor.getPosition() ?? new monaco.Position(1, 1);
    this.suppressCursorSync = true;
    model.setValue(joined);
    if (pos) this.editor.setPosition(pos);
    this.suppressCursorSync = false;
  }

  private handleKey(ev: monaco.IKeyboardEvent): void {
    const key = translateKey(ev.browserEvent as KeyboardEvent);
    if (!key) return;
    ev.preventDefault();
    this.sendInput(key);
  }

  private handleMouse(ev: monaco.editor.IEditorMouseEvent): void {
    if (!this.bufHandle || !ev.target?.position) return;
    const { lineNumber, column } = ev.target.position;
    this.sendRpc("nvim_win_set_cursor", [0, [lineNumber, column]]);
  }

  private sendInput(keys: string): void {
    this.sendRpc("nvim_input", [keys]);
    this.scheduleCursorRefresh();
  }

  private sendRpc(method: string, params: unknown[] = []): void {
    const msg = encode([0, this.reqId++, method, params] as any);
    this.postInput(msg);
  }

  private sendRpcResponse(msgid: number, error: unknown, result: unknown): void {
    const msg = encode([1, msgid, error, result] as any);
    this.postInput(msg);
  }

  private rpcCall(method: string, params: unknown[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.worker) { reject(new Error("session not started")); return; }
      if (this.workerExited) {
        const code = this.workerExitCode;
        reject(new Error(code != null ? `nvim exited (${code})` : "nvim exited"));
        return;
      }
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject, ts: Date.now() });
      const msg = encode([0, id, method, params] as any);
      this.postInput(msg);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(this.workerExited
            ? (this.workerExitCode != null ? `nvim exited (${this.workerExitCode})` : "nvim exited")
            : `rpc timeout: ${method}`));
        }
      }, this.opts.rpcTimeoutMs);
    });
  }

  private postInput(data: Uint8Array): void {
    if (!data || !data.buffer) return;
    const payload = normalizeTransfer(data);
    if (this.sharedInput) this.sharedInput.push(payload);
  }

  private doClipboardPaste(msgid: number): void {
    const fallback = (text: string | null | undefined) => {
      const lines = (text || "").split(/\r?\n/);
      this.sendRpcResponse(msgid, null, [lines, "v"]);
    };
    if (!navigator.clipboard?.readText) {
      const manual = window.prompt("Paste text");
      fallback(manual || "");
      return;
    }
    navigator.clipboard.readText()
      .then((text) => fallback(text || ""))
      .catch(() => fallback(""));
  }

  private updateCursor(line: number, col: number): void {
    const pos = clampCursor(this.editor, line, col - 1);
    const ln = pos.line;
    const cl = pos.col;
    this.lastCursorPos = new monaco.Position(ln, cl);
    if (!this.visualSelectionActive) {
      const current = this.editor.getPosition();
      const same = current && current.lineNumber === ln && current.column === cl;
      if (!same) {
        this.suppressCursorSync = true;
        this.editor.setPosition(this.lastCursorPos);
        this.editor.revealPositionInCenterIfOutsideViewport(this.lastCursorPos);
        this.suppressCursorSync = false;
      }
    }
  }

  private scheduleCursorRefresh(): void {
    if (this.cursorRefreshTimer) return;
    this.cursorRefreshTimer = window.setTimeout(() => {
      this.cursorRefreshTimer = null;
      void this.refreshCursorMode();
    }, 30);
  }

  private async refreshCursorMode(): Promise<void> {
    if (this.cursorRefreshInFlight) {
      this.cursorRefreshPending = true;
      return;
    }
    this.cursorRefreshInFlight = true;
    try {
      const [cursor, mode] = await Promise.all([
        this.rpcCall("nvim_win_get_cursor", [0]),
        this.rpcCall("nvim_get_mode", []),
      ]);
      if (Array.isArray(cursor) && cursor.length >= 2) {
        const ln = Number(cursor[0]);
        const col0 = Number(cursor[1]);
        const clamped = clampCursor(this.editor, ln, col0);
        this.updateCursor(clamped.line, clamped.col);
      }
      if (mode && typeof (mode as { mode?: string }).mode === "string") {
        const m = (mode as { mode: string }).mode;
        this.lastMode = m;
        this.applyCursorStyle(m);
        if (this.opts.onModeChange) this.opts.onModeChange(m);
      }
      await this.updateVisualSelection(this.lastMode);
    } catch (err) {
      // Surface once for debugging input freeze issues.
      // eslint-disable-next-line no-console
      console.error("[nvim rpc] refreshCursorMode failed", err);
    } finally {
      this.cursorRefreshInFlight = false;
      if (this.cursorRefreshPending) {
        this.cursorRefreshPending = false;
        void this.refreshCursorMode();
      }
    }
  }

  private applyCursorStyle(mode: string): void {
    const m = typeof mode === "string" ? mode : "";
    const isInsert = m.startsWith("i") || m.startsWith("R");
    const style: MonacoEditor.IStandaloneEditorConstructionOptions["cursorStyle"] = isInsert ? "line" : "block";
    const blink: MonacoEditor.IStandaloneEditorConstructionOptions["cursorBlinking"] = isInsert ? "blink" : "solid";
    const width = isInsert ? (this.initialCursorWidth || 1) : this.typicalFullWidth;
    if (style === this.lastCursorStyle && blink === this.lastCursorBlink && width === this.lastCursorWidth) return;
    this.editor.updateOptions({ cursorStyle: style, cursorBlinking: blink, cursorWidth: width });
    this.lastCursorStyle = style;
    this.lastCursorBlink = blink;
    this.lastCursorWidth = width;
  }

  private async updateVisualSelection(mode: string): Promise<void> {
    const visual = isVisualMode(mode);
    const token = ++this.visualSelectionToken;
    if (!visual) {
      if (this.visualSelectionActive) {
        const pos = this.editor.getPosition() || this.lastCursorPos || new monaco.Position(1, 1);
        this.editor.setSelection(new monaco.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column));
        this.visualSelectionActive = false;
      }
      return;
    }
    try {
      const selections = await this.fetchVisualRanges();
      if (token !== this.visualSelectionToken) return;
      if (!selections.length) return;
      if (selections.length === 1) this.editor.setSelection(selections[0]);
      else this.editor.setSelections(selections);
      this.visualSelectionActive = true;
    } catch (_) {
      // ignore selection fetch failures
    }
  }

  private async fetchVisualRanges(): Promise<monaco.Selection[]> {
    const res = await this.rpcCall("nvim_exec_lua", [VISUAL_SELECTION_LUA, []]);
    if (!Array.isArray(res)) return [];
    const selections = (res as any[])
      .map(byteRangeToSelection(this.editor))
      .filter((s): s is monaco.Selection => Boolean(s));
    return selections;
  }

  private async syncVisualSelectionColor(): Promise<void> {
    try {
      const hex = await this.fetchVisualBg();
      const base = hex || "#3e4451";
      const main = withAlpha(base, 0.45);
      const highlight = withAlpha(base, 0.3);
      monaco.editor.defineTheme(this.opts.visualThemeName, {
        base: "vs-dark",
        inherit: true,
        rules: [],
        colors: {
          "editor.selectionBackground": main,
          "editor.selectionHighlightBackground": highlight,
        },
      });
      this.editor.updateOptions({ theme: this.opts.visualThemeName });
    } catch (_) {
      // ignore theme sync errors
    }
  }

  private async fetchVisualBg(): Promise<string | null> {
    try {
      const hl = await this.rpcCall("nvim_get_hl", [0, { name: "Visual", link: false }]);
      const bg = normalizeHlBg(hl);
      if (bg) return bg;
    } catch (_) {
      // ignore
    }
    try {
      const hl = await this.rpcCall("nvim_get_hl_by_name", ["Visual", true]);
      const bg = normalizeHlBg(hl);
      if (bg) return bg;
    } catch (_) {
      // ignore
    }
    return null;
  }

  private async seedBuffer(bufHandle: number, seedOverride?: string[] | null): Promise<string[] | null> {
    const buf = extractBufId(bufHandle);
    if (!buf || buf <= 0) return null;
    const seed = seedOverride ?? this.opts.seedLines;
    if (!seed || !seed.length) return null;
    try {
      await this.rpcCall("nvim_buf_set_lines", [buf, 0, -1, false, seed]);
      await this.rpcCall("nvim_buf_set_option", [buf, "modifiable", true]);
      await this.rpcCall("nvim_buf_set_option", [buf, "modified", true]);
      await this.rpcCall("nvim_buf_set_option", [buf, "buftype", ""]);
      await this.rpcCall("nvim_buf_set_option", [buf, "filetype", "lua"]);
      await this.rpcCall("nvim_buf_set_name", [buf, "monaco-demo.lua"]);
      return seed;
    } catch (_) {
      return null;
    }
  }

  private async waitForApi(): Promise<void> {
    // Allow more startup time on slower machines; base it on rpc timeout and cap at ~15s.
    const delay = 300;
    const maxMs = Math.min(Math.max(this.opts.rpcTimeoutMs * 2, 10_000), 15_000);
    const retries = Math.ceil(maxMs / delay);
    for (let i = 0; i < retries; i += 1) {
      try {
        await this.rpcCall("nvim_get_api_info", []);
        return;
      } catch (_) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error("nvim_get_api_info timed out");
  }
}

export function createMonacoNeovim(
  editor: MonacoEditor.IStandaloneCodeEditor,
  options: MonacoNeovimOptions = {},
): MonacoNeovimClient {
  return new MonacoNeovimClient(editor, options);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampCursor(editor: MonacoEditor.IStandaloneCodeEditor, ln: number, col0: number) {
  const fallbackLine = Math.max(1, Number(ln) || 1);
  const fallbackCol = Math.max(1, (Number(col0) || 0) + 1);
  const model = editor.getModel();
  if (!model) {
    return { line: fallbackLine, col: fallbackCol };
  }
  const lineCount = model.getLineCount();
  const line = clamp(fallbackLine, 1, lineCount);
  const text = model.getLineContent(line) ?? "";
  const maxColumn = model.getLineMaxColumn(line);
  const byteCol = Math.max(0, Number(col0) || 0);
  const charIndex = byteIndexToCharIndex(text, byteCol);
  const col = clamp(charIndex + 1, 1, maxColumn);
  return { line, col };
}

function translateKey(ev: KeyboardEvent): string | null {
  const key = ev.key;
  const isCtrl = ev.ctrlKey || ev.metaKey;
  const isAlt = ev.altKey;
  switch (key) {
    case "Backspace": return "<BS>";
    case "Enter": return "<CR>";
    case "Escape": return "<Esc>";
    case "Tab": return "<Tab>";
    case "ArrowUp": return "<Up>";
    case "ArrowDown": return "<Down>";
    case "ArrowLeft": return "<Left>";
    case "ArrowRight": return "<Right>";
    case "Delete": return "<Del>";
    case "Home": return "<Home>";
    case "End": return "<End>";
    case "PageUp": return "<PageUp>";
    case "PageDown": return "<PageDown>";
    case "Insert": return "<Insert>";
    default: break;
  }
  if (key.length === 1) {
    const char = ev.shiftKey ? key : key.toLowerCase();
    if (!isCtrl && !isAlt) return char;
    let mod = "";
    if (isCtrl) mod += "C-";
    if (isAlt) mod += "A-";
    return `<${mod}${char}>`;
  }
  return null;
}

function decodeHandleId(data: Uint8Array): number | null {
  if (!data || data.length === 0) return null;
  const t = data[0];
  if (data.length === 1) {
    return t <= 0x7f ? t : (t - 0x100);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (t) {
    case 0xcc: return view.getUint8(1);
    case 0xcd: return view.getUint16(1);
    case 0xce: return view.getUint32(1);
    case 0xcf: return Number(view.getBigUint64(1));
    case 0xd0: return view.getInt8(1);
    case 0xd1: return view.getInt16(1);
    case 0xd2: return view.getInt32(1);
    case 0xd3: return Number(view.getBigInt64(1));
    default: return t;
  }
}

function toUint8(data: any): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(data);
  if (Number.isInteger(data)) return new Uint8Array([data & 0xff]);
  if (data && data.type === "Buffer" && Array.isArray(data.data)) return new Uint8Array(data.data);
  return null;
}

function extractBufId(val: unknown): number | null {
  if (val && typeof val === "object" && typeof (val as { type?: number }).type === "number") {
    const data = toUint8((val as { data?: unknown }).data);
    if (data) {
      const id = decodeHandleId(data);
      if (id != null && id > 0) return id;
    }
  }
  const num = Number(val);
  if (Number.isInteger(num) && num > 0) return num;
  return null;
}

function byteIndexToCharIndex(text: string, byteIndex: number): number {
  let totalBytes = 0;
  let charIndex = 0;
  const target = Math.max(0, Number(byteIndex) || 0);
  while (totalBytes < target) {
    if (charIndex >= text.length) {
      return charIndex + (target - totalBytes);
    }
    const code = text.codePointAt(charIndex);
    const bytes = utf8ByteLength(code ?? 0);
    totalBytes += bytes;
    charIndex += bytes === 4 ? 2 : 1;
  }
  return charIndex;
}

function utf8ByteLength(point: number): number {
  if (point == null) return 0;
  if (point <= 0x7f) return 1;
  if (point <= 0x7ff) return 2;
  if (point >= 0xd800 && point <= 0xdfff) return 4;
  if (point < 0xffff) return 3;
  return 4;
}

function byteRangeToSelection(editor: MonacoEditor.IStandaloneCodeEditor) {
  return (range: any) => {
    if (!range || !range.start || !range.end) return null;
    const start = toMonacoBytePos(editor, range.start, false);
    const end = toMonacoBytePos(editor, range.end, !!range.inclusive);
    if (!start || !end) return null;
    return new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column);
  };
}

function toMonacoBytePos(
  editor: MonacoEditor.IStandaloneCodeEditor,
  pos: { line?: number; col?: number },
  inclusiveEnd: boolean,
) {
  if (!pos || typeof pos.line !== "number" || typeof pos.col !== "number") return null;
  const model = editor.getModel();
  const lineNumber = clamp(pos.line + 1, 1, model?.getLineCount() || Infinity);
  if (!model) {
    const baseCol = Math.max(1, pos.col + 1);
    return { lineNumber, column: baseCol + (inclusiveEnd ? 1 : 0) };
  }
  const text = model.getLineContent(lineNumber) ?? "";
  const byte = Math.max(0, Number(pos.col) || 0);
  let endByte = byte;
  if (inclusiveEnd) {
    const charIndex = byteIndexToCharIndex(text, byte);
    const cp = text.codePointAt(charIndex);
    endByte = byte + utf8ByteLength(cp || 0);
  }
  const column = byteIndexToCharIndex(text, endByte) + 1;
  const maxColumn = model.getLineMaxColumn(lineNumber);
  return { lineNumber, column: clamp(column, 1, maxColumn) };
}

function isVisualMode(mode: string): boolean {
  const m = typeof mode === "string" ? mode : "";
  return m.startsWith("v") || m.startsWith("V") || m === "\u0016" || m.startsWith("s") || m.startsWith("S") || m === "\u0013";
}

function withAlpha(hex: string, alpha: number): string {
  const clean = (hex || "").replace("#", "");
  if (clean.length !== 6) return hex;
  const a = Math.round(clamp(alpha, 0, 1) * 255);
  return `#${clean}${a.toString(16).padStart(2, "0")}`;
}

function normalizeHlBg(hl: unknown): string | null {
  if (!hl || typeof hl !== "object") return null;
  const obj = hl as Record<string, unknown>;
  const num = (obj.background as number | undefined) ?? (obj.bg as number | undefined);
  if (typeof num === "number" && num >= 0) {
    return toHex(num);
  }
  if (typeof obj.background === "string" && (obj.background as string).startsWith("#")) {
    return obj.background as string;
  }
  if (typeof obj.bg === "string" && (obj.bg as string).startsWith("#")) {
    return obj.bg as string;
  }
  return null;
}

function toHex(n: number): string {
  const v = Number(n >>> 0);
  return `#${v.toString(16).padStart(6, "0").slice(-6)}`;
}

function normalizeTransfer(data: Uint8Array): Uint8Array {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data;
  return data.slice();
}

function isSharedArrayBufferAvailable(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
}

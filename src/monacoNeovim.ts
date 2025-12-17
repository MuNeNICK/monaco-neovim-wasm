import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";
import { DEFAULT_SHARED_INPUT_BYTES } from "./sharedInput";
import { defaultRuntimePath, defaultWasmPath } from "./paths";
import { NeovimWasmSession } from "./neovimWasmSession";
import motionOverridesVim from "./overrides/motion.vim?raw";
import scrollingOverridesVim from "./overrides/scrolling.vim?raw";

export type StatusEmitter = (text: string, warn?: boolean) => void;
export type ClipboardAdapter = {
  readText?: () => Promise<string>;
  writeText?: (text: string) => Promise<void>;
};

export type MonacoNeovimOptions = {
  worker?: Worker | null;
  workerUrl?: URL;
  reuseWorker?: boolean;
  wasmPath?: string;
  runtimePath?: string;
  env?: Record<string, string>;
  files?: Array<{ path: string; data: Uint8Array | string }>;
  sharedInputBytes?: number;
  cols?: number;
  rows?: number;
  minCols?: number;
  minRows?: number;
  autoResize?: boolean;
  resizeDebounceMs?: number;
  syncWrap?: boolean;
  wrapStrategy?: "simple" | "advanced";
  syncTabstop?: boolean;
  wrappedLineMotions?: boolean;
  scrollMotions?: boolean;
  status?: StatusEmitter;
  seedLines?: string[];
  seedName?: string;
  seedFiletype?: string;
  uiAttach?: boolean;
  uiAttachOptions?: {
    ext_cmdline?: boolean;
    ext_messages?: boolean;
    ext_popupmenu?: boolean;
    rgb?: boolean;
  };
  startupCommands?: string[];
  startupLua?: string;
  visualThemeName?: string;
  rpcTimeoutMs?: number;
  clipboard?: ClipboardAdapter | null;
  onStderr?: (text: string) => void;
  onStartError?: (message?: string) => void;
  onExit?: (code: number, lastStderr?: string) => void;
  onWarning?: (message: string) => void;
  onModeChange?: (mode: string) => void;
  onCmdline?: (text: string | null) => void;
  onMessage?: (text: string | null) => void;
  onPopupmenu?: (items: PopupMenuItem[] | null, selected: number) => void;
  cmdlineContainer?: HTMLElement | null;
  shouldHandleKey?: (ev: KeyboardEvent) => boolean;
  translateKey?: (ev: KeyboardEvent) => string | null;
};

export type PopupMenuItem = { word: string; kind?: string; menu?: string; info?: string };

type MonacoNeovimResolvedOptions = {
  worker: Worker | null;
  workerUrl: URL;
  reuseWorker: boolean;
  wasmPath: string;
  runtimePath: string;
  env?: Record<string, string>;
  files?: Array<{ path: string; data: Uint8Array | string }>;
  sharedInputBytes: number;
  cols: number;
  rows: number;
  minCols: number;
  minRows: number;
  autoResize: boolean;
  resizeDebounceMs: number;
  syncWrap: boolean;
  wrapStrategy: "simple" | "advanced";
  syncTabstop: boolean;
  wrappedLineMotions: boolean;
  scrollMotions: boolean;
  status: StatusEmitter;
  seedLines: string[];
  seedName: string;
  seedFiletype: string;
  uiAttach: boolean;
  uiAttachOptions: {
    ext_cmdline: boolean;
    ext_messages: boolean;
    ext_popupmenu: boolean;
    rgb: boolean;
  };
  startupCommands: string[];
  startupLua: string;
  visualThemeName: string;
  rpcTimeoutMs: number;
  clipboard?: ClipboardAdapter | null;
  onStderr?: (text: string) => void;
  onStartError?: (message?: string) => void;
  onExit?: (code: number, lastStderr?: string) => void;
  onWarning?: (message: string) => void;
  onModeChange?: (mode: string) => void;
  onCmdline?: (text: string | null) => void;
  onMessage?: (text: string | null) => void;
  onPopupmenu?: (items: PopupMenuItem[] | null, selected: number) => void;
  cmdlineContainer?: HTMLElement | null;
  shouldHandleKey: (ev: KeyboardEvent) => boolean;
  translateKey: (ev: KeyboardEvent) => string | null;
};

type PendingBufSetText = {
  startRow: number;
  startColByte: number;
  endRow: number;
  endColByte: number;
  lines: string[];
};

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
  local full_mode = api.nvim_get_mode().mode or ""
  local mode = full_mode:sub(-1)
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

  if mode == "v" or mode == "V" then
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
  private session: NeovimWasmSession | null = null;
  private bufHandle: number | null = null;
  private uiCols = 0;
  private uiRows = 0;
  private resizeTimer: number | null = null;
  private wrapColumnApplied: number | null = null;
  private wrapStrategyApplied: "simple" | "advanced" | null = null;
  private primeSent = false;
  private lastCursorPos: monaco.Position | null = null;
  private suppressCursorSync = false;
  private lastMode = "";
  private visualSelectionToken = 0;
  private visualSelectionActive = false;
  private visualDecorationIds: string[] = [];
  private visualStyleEl: HTMLStyleElement | null = null;
  private visualBgCss = "rgba(62, 68, 81, 0.45)";
  private cursorRefreshTimer: number | null = null;
  private cursorRefreshInFlight = false;
  private cursorRefreshPending = false;
  private disposables: monaco.IDisposable[] = [];
  private nvimChannelId: number | null = null;
  private hostAutocmdInstalled = false;
  private visualSelectionRefreshTimer: number | null = null;
  private lastCursorStyle: MonacoEditor.IStandaloneEditorConstructionOptions["cursorStyle"] | null = null;
  private lastCursorBlink: MonacoEditor.IStandaloneEditorConstructionOptions["cursorBlinking"] | null = null;
  private lastCursorWidth: number | null = null;
  private initialCursorWidth = 0;
  private typicalFullWidth = 2;
  private nextSeedLines: string[] | null = null;
  private cmdlineEl: HTMLDivElement | null = null;
  private cmdlineVisible = false;
  private messageEl: HTMLDivElement | null = null;
  private messageTimer: number | null = null;
  private popupEl: HTMLDivElement | null = null;
  private popupItems: PopupMenuItem[] = [];
  private popupSelected = -1;
  private preeditEl: HTMLDivElement | null = null;
  private preeditVisible = false;
  private compositionActive = false;
  private pendingResyncAfterComposition = false;
  private ignoreNextInputEvent = false;
  private ignoreTextKeydownUntil = 0;
  private optimisticCursorUntil = 0;
  private optimisticCursorPos: monaco.Position | null = null;
  private optimisticCursorPrevPos: monaco.Position | null = null;
  private delegateInsertToMonaco = false;
  private applyingFromNvim = false;
  private shadowLines: string[] | null = null;
  private pendingBufEdits: PendingBufSetText[] = [];
  private pendingFullSync = false;
  private pendingCursorSync = false;
  private cursorSyncTimer: number | null = null;
  private originalOptions: Partial<MonacoEditor.IStandaloneEditorConstructionOptions> | null = null;
  private resyncTimer: number | null = null;

  constructor(editor: MonacoEditor.IStandaloneCodeEditor, options: MonacoNeovimOptions = {}) {
    this.editor = editor;
    this.opts = {
      worker: options.worker ?? null,
      workerUrl: options.workerUrl ?? new URL("./nvimWorker.js", import.meta.url),
      reuseWorker: options.reuseWorker ?? false,
      wasmPath: options.wasmPath ?? defaultWasmPath,
      runtimePath: options.runtimePath ?? defaultRuntimePath,
      env: options.env,
      files: options.files,
      sharedInputBytes: options.sharedInputBytes ?? DEFAULT_SHARED_INPUT_BYTES,
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      minCols: options.minCols ?? 20,
      minRows: options.minRows ?? 5,
      autoResize: options.autoResize ?? true,
      resizeDebounceMs: options.resizeDebounceMs ?? 50,
      syncWrap: options.syncWrap ?? false,
      wrapStrategy: options.wrapStrategy ?? "simple",
      syncTabstop: options.syncTabstop ?? true,
      wrappedLineMotions: options.wrappedLineMotions ?? (options.syncWrap ?? false),
      scrollMotions: options.scrollMotions ?? false,
      status: options.status ?? (() => {}),
      seedLines: options.seedLines ?? DEFAULT_SEED,
      seedName: options.seedName ?? "monaco-demo.lua",
      seedFiletype: options.seedFiletype ?? "lua",
      uiAttach: options.uiAttach ?? true,
      uiAttachOptions: {
        ext_cmdline: options.uiAttachOptions?.ext_cmdline ?? true,
        ext_messages: options.uiAttachOptions?.ext_messages ?? true,
        ext_popupmenu: options.uiAttachOptions?.ext_popupmenu ?? true,
        rgb: options.uiAttachOptions?.rgb ?? true,
      },
      startupCommands: options.startupCommands ?? [
        "set noswapfile signcolumn=no number norelativenumber",
        "set nowrap laststatus=0 cmdheight=1",
        "set shortmess+=F",
        "set clipboard=unnamedplus",
      ],
      startupLua: options.startupLua ?? "",
      visualThemeName: options.visualThemeName ?? "nvim-visual",
      rpcTimeoutMs: options.rpcTimeoutMs ?? 8000,
      clipboard: options.clipboard,
      onStderr: options.onStderr,
      onStartError: options.onStartError,
      onExit: options.onExit,
      onWarning: options.onWarning,
      onModeChange: options.onModeChange,
      onCmdline: options.onCmdline,
      onMessage: options.onMessage,
      onPopupmenu: options.onPopupmenu,
      cmdlineContainer: options.cmdlineContainer,
      shouldHandleKey: options.shouldHandleKey ?? (() => true),
      translateKey: options.translateKey ?? translateKey,
    };
  }

  async start(seedLines?: string[]): Promise<void> {
    this.stop(true);
    this.nextSeedLines = seedLines ?? null;

    try {
      const initialSize = this.opts.autoResize ? this.computeGridSize() : { cols: this.opts.cols, rows: this.opts.rows };
      this.uiCols = initialSize.cols;
      this.uiRows = initialSize.rows;
      this.attachEditorListeners();
      const handlers = {
        onNotify: (method: string, params: unknown[]) => { void this.handleNotify(method, params); },
        onRequest: (msgid: number, method: string, params: unknown[]) => { this.handleRequest(msgid, method, params); },
        onClipboardCopy: (lines: string[], _regtype: string) => { void this.handleClipboardCopy(lines); },
        onClipboardPaste: (msgid: number) => { this.doClipboardPaste(msgid); },
        onStderr: (message?: string) => {
          const text = message == null ? "" : String(message);
          try { this.opts.onStderr?.(text); } catch (_) {}
        },
        onStartError: (message?: string) => {
          try { this.opts.onStartError?.(message); } catch (_) {}
          this.opts.status(`start failed: ${message ?? "unknown"}`, true);
        },
        onExit: (code: number, lastStderr?: string) => {
          const suffix = lastStderr ? `: ${lastStderr.trim()}` : "";
          this.opts.status(`nvim exited (${code})${suffix}`, code !== 0);
          try { this.opts.onExit?.(code, lastStderr); } catch (_) {}
        },
        onWarning: (message: string) => {
          try { this.opts.onWarning?.(message); } catch (_) {}
          this.opts.status(message, true);
        },
      };

      if (!this.session || !this.opts.reuseWorker) {
        this.session = new NeovimWasmSession({
          worker: this.opts.worker,
          workerUrl: this.opts.workerUrl,
          sharedInputBytes: this.opts.sharedInputBytes,
          rpcTimeoutMs: this.opts.rpcTimeoutMs,
          reuseWorker: this.opts.reuseWorker,
          handlers,
        });
      } else {
        this.session.setHandlers(handlers);
      }
      await this.session.start({
        cols: this.uiCols,
        rows: this.uiRows,
        wasmPath: this.opts.wasmPath,
        runtimePath: this.opts.runtimePath,
        env: this.opts.env,
        files: normalizeSessionFiles(mergeSessionFiles(
          this.opts.files,
          this.opts.wrappedLineMotions || this.opts.scrollMotions
            ? [
              { path: "home/.config/nvim/monaco-neovim-wasm/motion.vim", data: motionOverridesVim },
              { path: "home/.config/nvim/monaco-neovim-wasm/scrolling.vim", data: scrollingOverridesVim },
            ]
            : [],
        )),
      });
      this.opts.status("starting...");
      this.primeSent = false;
      setTimeout(() => { if (!this.primeSent) void this.primeSession(); }, 300);
      await this.session.waitForApi();
      await this.primeSession();
    } catch (err) {
      const msg = (err as { message?: string })?.message || String(err);
      this.opts.status(`start failed: ${msg}`, true);
      this.stop(true);
      throw err;
    }
  }

  stop(silent = false): void {
    if (this.session) {
      if (this.opts.reuseWorker) {
        this.session.stop({ terminate: false, silent: true });
      } else {
        this.session.dispose();
        this.session = null;
      }
    }
    this.bufHandle = null;
    this.primeSent = false;
    this.visualSelectionActive = false;
    this.delegateInsertToMonaco = false;
    this.applyingFromNvim = false;
    this.shadowLines = null;
    this.pendingBufEdits = [];
    this.pendingCursorSync = false;
    if (this.cursorSyncTimer) {
      clearTimeout(this.cursorSyncTimer);
      this.cursorSyncTimer = null;
    }
    this.nvimChannelId = null;
    this.hostAutocmdInstalled = false;
    if (this.visualSelectionRefreshTimer) {
      clearTimeout(this.visualSelectionRefreshTimer);
      this.visualSelectionRefreshTimer = null;
    }
    if (this.cursorRefreshTimer) {
      clearTimeout(this.cursorRefreshTimer);
      this.cursorRefreshTimer = null;
    }
    this.cursorRefreshPending = false;
    this.cursorRefreshInFlight = false;
    this.setCmdline(null);
    this.setMessage(null);
    this.setPopupmenu(null, -1);
    if (this.resyncTimer) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (!silent) this.opts.status("stopped", true);
    this.disposeEditorListeners();
  }

  dispose(): void {
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
    this.stop(true);
  }

  notify(method: string, params: unknown[] = []): void {
    this.sendNotify(method, params);
  }

  call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return this.rpcCall(method, params) as Promise<T>;
  }

  command(cmd: string): void {
    this.sendNotify("nvim_command", [String(cmd ?? "")]);
  }

  input(keys: string): void {
    this.sendNotify("nvim_input", [String(keys ?? "")]);
  }

  paste(text: string): void {
    this.pasteText(text);
  }

  execLua<T = unknown>(code: string, args: unknown[] = []): Promise<T> {
    return this.rpcCall("nvim_exec_lua", [String(code ?? ""), Array.isArray(args) ? args : []]) as Promise<T>;
  }

  getSession(): NeovimWasmSession | null {
    return this.session;
  }

  resize(cols: number, rows: number): void {
    const c = Math.max(this.opts.minCols, Number(cols) || 0);
    const r = Math.max(this.opts.minRows, Number(rows) || 0);
    if (!Number.isFinite(c) || !Number.isFinite(r) || c <= 0 || r <= 0) return;
    if (this.opts.syncWrap) this.applyMonacoWrap(c);
    this.uiCols = c;
    this.uiRows = r;
    if (!this.session || !this.session.isRunning()) return;
    if (!this.primeSent) return;
    void this.rpcCall("nvim_ui_try_resize", [c, r]).catch(() => {});
  }

  resizeToEditor(): void {
    const { cols, rows } = this.computeGridSize();
    this.resize(cols, rows);
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

    if (this.originalOptions == null) {
      try {
        this.originalOptions = {
          readOnly: this.editor.getOption(EditorOption.readOnly),
          domReadOnly: this.editor.getOption(EditorOption.domReadOnly) as any,
          contextmenu: this.editor.getOption(EditorOption.contextmenu),
          minimap: this.editor.getOption(EditorOption.minimap),
          scrollBeyondLastLine: this.editor.getOption(EditorOption.scrollBeyondLastLine),
          smoothScrolling: this.editor.getOption(EditorOption.smoothScrolling),
          padding: this.editor.getOption(EditorOption.padding),
          cursorSmoothCaretAnimation: this.editor.getOption(EditorOption.cursorSmoothCaretAnimation),
          cursorStyle: this.editor.getOption(EditorOption.cursorStyle) as any,
          cursorBlinking: this.editor.getOption(EditorOption.cursorBlinking) as any,
          cursorWidth: this.editor.getOption(EditorOption.cursorWidth),
          wordWrap: this.editor.getOption(EditorOption.wordWrap) as any,
          wordWrapColumn: this.editor.getOption(EditorOption.wordWrapColumn) as any,
          wrappingStrategy: this.editor.getOption(EditorOption.wrappingStrategy) as any,
        };
      } catch (_) {
        this.originalOptions = null;
      }
    }

    // Keep the editor writable so IME composition works correctly. We still
    // prevent most keydown-driven edits and rely on Neovim as the source of truth.
    this.editor.updateOptions({ readOnly: false, domReadOnly: false });
    if (this.opts.syncWrap) {
      const col = this.uiCols || this.opts.cols;
      if (col > 0) this.applyMonacoWrap(col);
    }

    const model = this.editor.getModel();
    if (model) {
      this.disposables.push(
        model.onDidChangeContent((ev) => this.handleMonacoModelChange(ev)),
      );
    }

    this.disposables.push(
      this.editor.onKeyDown((ev) => this.handleKey(ev)),
      this.editor.onMouseDown((ev) => this.handleMouse(ev)),
      this.editor.onDidChangeCursorPosition((ev) => {
        const cur = this.editor.getPosition();
        if (cur) this.lastCursorPos = cur;
        if (this.delegateInsertToMonaco) {
          if (this.compositionActive) this.positionPreedit();
          this.scheduleCursorSyncToNvim();
          return;
        }
        // During IME composition, Monaco moves its internal cursor/selection.
        // Don't fight it, otherwise the view can glitch until composition ends.
        if (this.compositionActive) {
          this.positionPreedit();
          return;
        }
        if (this.suppressCursorSync || !this.lastCursorPos) return;
        if (ev.source === "keyboard") {
          this.suppressCursorSync = true;
          this.editor.setPosition(this.lastCursorPos);
          this.suppressCursorSync = false;
        }
      }),
      this.editor.onDidScrollChange(() => {
        if (!this.compositionActive) return;
        this.positionPreedit();
      }),
    );
    if (this.opts.autoResize) {
      this.disposables.push(
        this.editor.onDidLayoutChange(() => this.scheduleResizeToEditor()),
        this.editor.onDidChangeConfiguration((e) => {
          if (
            e.hasChanged(EditorOption.fontInfo)
            || e.hasChanged(EditorOption.lineHeight)
            || e.hasChanged(EditorOption.fontSize)
            || e.hasChanged(EditorOption.fontFamily)
          ) {
            this.scheduleResizeToEditor();
          }
        }),
      );
    }
    this.initCmdlineUi();
    this.initTextInputListeners();
  }

  private computeGridSize(): { cols: number; rows: number } {
    try {
      const layout = this.editor.getLayoutInfo() as any;
      const contentWidth = Math.max(0, Number(layout?.contentWidth ?? layout?.width ?? 0) || 0);
      const contentHeight = Math.max(0, Number(layout?.contentHeight ?? layout?.height ?? 0) || 0);

      const fontInfo = this.editor.getOption(monaco.editor.EditorOption.fontInfo) as any;
      const charWidth = Math.max(1, Number(fontInfo?.typicalHalfwidthCharacterWidth ?? fontInfo?.maxDigitWidth ?? 0) || 0);
      const lineHeight = Math.max(1, Number(fontInfo?.lineHeight ?? 0) || 0);

      const cols = Math.max(this.opts.minCols, Math.floor(contentWidth / charWidth));
      const rows = Math.max(this.opts.minRows, Math.floor(contentHeight / lineHeight));
      if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) return { cols, rows };
    } catch (_) {
    }
    return { cols: this.opts.cols, rows: this.opts.rows };
  }

  private scheduleResizeToEditor(): void {
    if (!this.opts.autoResize) return;
    if (this.resizeTimer) return;
    const delay = Math.max(0, Number(this.opts.resizeDebounceMs) || 0);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      this.resizeToEditor();
    }, delay);
  }

  private ensurePreeditUi(): void {
    if (this.preeditEl) return;
    const container = this.opts.cmdlineContainer ?? this.editor.getDomNode();
    if (!container) return;
    try {
      const style = window.getComputedStyle(container);
      if (style.position === "static") {
        (container as HTMLElement).style.position = "relative";
      }
    } catch (_) {
    }
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.display = "none";
    el.style.pointerEvents = "none";
    el.style.zIndex = "40";
    el.style.whiteSpace = "pre";
    el.style.padding = "0 1px";
    el.style.background = "rgba(0, 0, 0, 0.15)";
    el.style.borderBottom = "1px solid rgba(255, 255, 255, 0.6)";
    el.style.borderRadius = "2px";
    try {
      const fontInfo = this.editor.getOption(monaco.editor.EditorOption.fontInfo);
      if (fontInfo?.fontFamily) el.style.fontFamily = fontInfo.fontFamily;
      if (fontInfo?.fontSize) el.style.fontSize = `${fontInfo.fontSize}px`;
      if (fontInfo?.lineHeight) el.style.lineHeight = `${fontInfo.lineHeight}px`;
    } catch (_) {
    }
    container.appendChild(el);
    this.preeditEl = el;
  }

  private setPreedit(text: string | null): void {
    this.ensurePreeditUi();
    if (!this.preeditEl) return;
    const t = text == null ? "" : String(text);
    const nextVisible = t.length > 0;
    if (!nextVisible) {
      if (this.preeditVisible) {
        this.preeditEl.style.display = "none";
        this.preeditVisible = false;
      }
      this.preeditEl.textContent = "";
      return;
    }
    this.preeditEl.textContent = t;
    if (!this.preeditVisible) {
      this.preeditEl.style.display = "block";
      this.preeditVisible = true;
    }
    this.positionPreedit();
  }

  private applyOptimisticInsert(text: string): void {
    if (!text) return;
    if (this.cmdlineVisible) return;
    const model = this.editor.getModel();
    if (!model) return;
    const selection = this.editor.getSelection();
    const base = selection && !selection.isEmpty() ? selection.getStartPosition() : null;
    const basePos = base ?? this.editor.getPosition() ?? this.lastCursorPos ?? new monaco.Position(1, 1);
    const parts = String(text).split(/\r?\n/);
    let line = basePos.lineNumber;
    let col = basePos.column;
    if (parts.length <= 1) {
      col += Array.from(parts[0] ?? "").length;
    } else {
      line += parts.length - 1;
      col = 1 + Array.from(parts[parts.length - 1] ?? "").length;
    }
    const next = model.validatePosition(new monaco.Position(line, col));
    const prev = this.editor.getPosition() ?? this.lastCursorPos ?? basePos;
    this.optimisticCursorPrevPos = prev;
    this.optimisticCursorPos = next;
    this.optimisticCursorUntil = (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) + 120;
    this.lastCursorPos = next;
    if (this.compositionActive) return;
    this.suppressCursorSync = true;
    this.editor.setPosition(next);
    this.suppressCursorSync = false;
  }

  private positionPreedit(): void {
    if (!this.preeditEl || !this.preeditVisible) return;
    const pos = this.editor.getPosition();
    if (!pos) return;
    const vis = this.editor.getScrolledVisiblePosition(pos);
    if (!vis) return;
    this.preeditEl.style.left = `${Math.max(0, vis.left)}px`;
    this.preeditEl.style.top = `${Math.max(0, vis.top)}px`;
    this.preeditEl.style.height = `${Math.max(0, vis.height)}px`;
  }

  private disposeEditorListeners(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.clearVisualDecorations();
    if (this.visualStyleEl) {
      try { this.visualStyleEl.remove(); } catch (_) {}
      this.visualStyleEl = null;
    }
    if (this.cmdlineEl) {
      try { this.cmdlineEl.remove(); } catch (_) {}
      this.cmdlineEl = null;
    }
    if (this.messageEl) {
      try { this.messageEl.remove(); } catch (_) {}
      this.messageEl = null;
    }
    if (this.popupEl) {
      try { this.popupEl.remove(); } catch (_) {}
      this.popupEl = null;
    }
    if (this.preeditEl) {
      try { this.preeditEl.remove(); } catch (_) {}
      this.preeditEl = null;
      this.preeditVisible = false;
    }
    if (this.messageTimer) {
      clearTimeout(this.messageTimer);
      this.messageTimer = null;
    }
    if (this.resyncTimer) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.compositionActive = false;
    this.pendingResyncAfterComposition = false;
    this.delegateInsertToMonaco = false;
    this.applyingFromNvim = false;
    this.shadowLines = null;
    this.pendingBufEdits = [];
    this.pendingCursorSync = false;
    this.pendingFullSync = false;
    if (this.cursorSyncTimer) {
      clearTimeout(this.cursorSyncTimer);
      this.cursorSyncTimer = null;
    }
    this.nvimChannelId = null;
    this.hostAutocmdInstalled = false;
    if (this.visualSelectionRefreshTimer) {
      clearTimeout(this.visualSelectionRefreshTimer);
      this.visualSelectionRefreshTimer = null;
    }
    if (this.originalOptions) {
      try { this.editor.updateOptions(this.originalOptions); } catch (_) {}
      this.originalOptions = null;
    }
  }

  private async primeSession(): Promise<void> {
    if (this.bufHandle) return;
    this.primeSent = true;
    try {
      if (this.opts.uiAttach) {
        try {
          await this.rpcCall("nvim_ui_attach", [this.uiCols || this.opts.cols, this.uiRows || this.opts.rows, this.opts.uiAttachOptions]);
        } catch (_) {
        }
      }
      for (const cmd of this.opts.startupCommands) {
        if (!cmd) continue;
        this.sendNotify("nvim_command", [cmd]);
      }
      if (this.opts.startupLua) {
        try { await this.rpcCall("nvim_exec_lua", [this.opts.startupLua, []]); } catch (_) {}
      }
      const buf = await this.rpcCall("nvim_get_current_buf", []);
      const id = extractBufId(buf) ?? 1;
      this.bufHandle = id;
      const attached = await this.rpcCall("nvim_buf_attach", [id, true, {}]);
      if (attached !== true) throw new Error("nvim_buf_attach failed");
      if (this.opts.syncTabstop) this.syncTabstopFromMonaco();
      const lines = await this.rpcCall("nvim_buf_get_lines", [id, 0, -1, false]);
      this.applyBuffer(Array.isArray(lines) ? lines as string[] : [""]);
      const seeded = await this.seedBuffer(id, this.nextSeedLines);
      this.nextSeedLines = null;
      if (seeded && seeded.length) this.applyBuffer(seeded);
      await this.installHostAutocmds();
      await this.syncVisualSelectionColor();
      if (!this.lastMode) this.lastMode = "n";
      this.opts.status("ready");
      this.editor.focus();
      if (this.opts.autoResize) this.scheduleResizeToEditor();
      if (this.opts.onModeChange) this.opts.onModeChange(this.lastMode);
    } catch (err) {
      this.opts.status(`failed to attach: ${(err as Error)?.message ?? err}`, true);
    }
  }

  private handleClipboardCopy(lines: string[]): void {
    const text = (lines ?? []).join("\n");
    const adapter = this.opts.clipboard;
    if (adapter === null) return;
    if (adapter?.writeText) {
      adapter.writeText(text).catch(() => {});
      return;
    }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
  }

  private handleRequest(msgid: number, method: string, params: unknown[]): void {
    if (method === "wasm-clipboard-paste") {
      this.doClipboardPaste(msgid);
    } else {
      this.sendRpcResponse(msgid, null, null);
    }
  }

  private async handleNotify(method: string, params: unknown[]): Promise<void> {
    if (method === "monaco_cursorMove") {
      const arg = params?.[0];
      if (arg && typeof arg === "object") {
        this.applyMonacoCursorMove(arg as Record<string, unknown>);
        this.syncCursorToNvimNow();
      }
      return;
    }
    if (method === "monaco_reveal") {
      const arg = params?.[0];
      if (arg && typeof arg === "object") {
        const resetCursor = this.applyMonacoReveal(arg as Record<string, unknown>);
        if (resetCursor) this.syncCursorToNvimNow();
      }
      return;
    }
    if (method === "monaco_moveCursor") {
      const arg = params?.[0];
      if (arg && typeof arg === "object") {
        this.applyMonacoMoveCursor(arg as Record<string, unknown>);
        this.syncCursorToNvimNow();
      }
      return;
    }
    if (method === "monaco_cursor") {
      const [ln, col0] = params;
      const clamped = clampCursor(this.editor, Number(ln), Number(col0));
      // In insert-mode delegation, Monaco owns the caret; don't overwrite it.
      if (this.delegateInsertToMonaco) {
        const model = this.editor.getModel();
        const validated = model
          ? model.validatePosition(new monaco.Position(clamped.line, clamped.col))
          : new monaco.Position(clamped.line, clamped.col);
        this.lastCursorPos = validated;
        return;
      }
      this.updateCursor(clamped.line, clamped.col);
      if (isVisualMode(this.lastMode)) this.scheduleVisualSelectionRefresh();
      return;
    }
    if (method === "monaco_mode") {
      const m = typeof params?.[0] === "string" ? String(params[0]) : "";
      this.applyNvimMode(m);
      return;
    }
    if (method === "nvim_buf_lines_event") {
      if (this.delegateInsertToMonaco) return;
      const [buf, _changedtick, firstline, lastline, linedata] = params;
      const id = extractBufId(buf);
      if (this.bufHandle != null && id === this.bufHandle) {
        if (this.compositionActive) {
          // Don't mutate the Monaco model during IME composition; it can cause the
          // IME rendering/caret to glitch. We'll resync after composition ends.
          this.pendingResyncAfterComposition = true;
          return;
        }
        const model = this.editor.getModel();
        const fl = Number(firstline);
        const ll = Number(lastline);
        const newLines = Array.isArray(linedata) ? (linedata as unknown[]).map((l) => String(l ?? "")) : null;
        const canPatch = model && Number.isInteger(fl) && Number.isInteger(ll) && fl >= 0 && ll >= fl && newLines;
        if (canPatch) {
          try {
            this.applyLinePatch(model!, fl, ll, newLines!);
          } catch (_) {
          }
        } else {
          try {
            const allLines = await this.rpcCall("nvim_buf_get_lines", [id, 0, -1, false]);
            this.applyBuffer(Array.isArray(allLines) ? (allLines as string[]) : [""]);
          } catch (_) {
          }
        }
        if (isVisualMode(this.lastMode)) this.scheduleVisualSelectionRefresh();
      }
    } else if (method === "nvim_buf_detach_event") {
      this.bufHandle = null;
    } else if (method === "redraw") {
      this.handleRedraw(params);
    }
  }

  private applyLinePatch(model: monaco.editor.ITextModel, firstline: number, lastline: number, newLines: string[]): void {
    const oldLineCount = model.getLineCount();
    const fl = Math.min(firstline, oldLineCount);
    const ll = Math.min(lastline, oldLineCount);
    const pos = this.lastCursorPos ?? this.editor.getPosition() ?? new monaco.Position(1, 1);

    const eof = new monaco.Position(oldLineCount, model.getLineMaxColumn(oldLineCount));
    const start = fl < oldLineCount ? new monaco.Position(fl + 1, 1) : eof;
    const end = ll < oldLineCount ? new monaco.Position(ll + 1, 1) : eof;

    let text = newLines.join("\n");
    const insertingAtEof = firstline >= oldLineCount && lastline >= oldLineCount;
    if (insertingAtEof && newLines.length > 0) text = `\n${text}`;
    const hasFollowingLine = lastline < oldLineCount;
    if (hasFollowingLine && newLines.length > 0) text += "\n";

    const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
    try {
      const existing = model.getValueInRange(range);
      if (existing === text) return;
    } catch (_) {
    }

    this.suppressCursorSync = true;
    this.applyingFromNvim = true;
    model.applyEdits([{ range, text }]);
    this.applyingFromNvim = false;
    if (pos) this.editor.setPosition(pos);
    this.suppressCursorSync = false;

    if (this.delegateInsertToMonaco) {
      // Keep our shadow in sync if Neovim changed the buffer while delegating.
      try { this.shadowLines = model.getLinesContent(); } catch (_) {}
    }
  }

  private initCmdlineUi(): void {
    if (this.opts.cmdlineContainer === null) return;
    if (this.cmdlineEl || this.messageEl || this.popupEl) return;
    const container = this.opts.cmdlineContainer ?? this.editor.getDomNode();
    if (!container) return;
    try {
      const style = window.getComputedStyle(container);
      if (style.position === "static") {
        (container as HTMLElement).style.position = "relative";
      }
    } catch (_) {
    }
    const baseFont = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
    const baseSize = "12px";
    const baseLine = "1.4";

    if (!this.opts.onCmdline) {
      const el = document.createElement("div");
      el.style.position = "absolute";
      el.style.left = "0";
      el.style.right = "0";
      el.style.bottom = "0";
      el.style.padding = "6px 10px";
      el.style.fontFamily = baseFont;
      el.style.fontSize = baseSize;
      el.style.lineHeight = baseLine;
      el.style.background = "rgba(0, 0, 0, 0.72)";
      el.style.color = "#ddd";
      el.style.borderTop = "1px solid rgba(255, 255, 255, 0.08)";
      el.style.whiteSpace = "pre";
      el.style.display = "none";
      el.style.pointerEvents = "none";
      el.style.zIndex = "20";
      container.appendChild(el);
      this.cmdlineEl = el;
    }

    if (!this.opts.onMessage) {
      const msg = document.createElement("div");
      msg.style.position = "absolute";
      msg.style.left = "0";
      msg.style.right = "0";
      msg.style.bottom = "34px";
      msg.style.padding = "6px 10px";
      msg.style.fontFamily = baseFont;
      msg.style.fontSize = baseSize;
      msg.style.lineHeight = baseLine;
      msg.style.background = "rgba(0, 0, 0, 0.55)";
      msg.style.color = "#ddd";
      msg.style.whiteSpace = "pre-wrap";
      msg.style.display = "none";
      msg.style.pointerEvents = "none";
      msg.style.zIndex = "19";
      container.appendChild(msg);
      this.messageEl = msg;
    }

    if (!this.opts.onPopupmenu) {
      const pop = document.createElement("div");
      pop.style.position = "absolute";
      pop.style.left = "12px";
      pop.style.bottom = "34px";
      pop.style.maxHeight = "40%";
      pop.style.overflow = "auto";
      pop.style.minWidth = "240px";
      pop.style.padding = "4px 0";
      pop.style.fontFamily = baseFont;
      pop.style.fontSize = baseSize;
      pop.style.lineHeight = baseLine;
      pop.style.background = "rgba(0, 0, 0, 0.88)";
      pop.style.border = "1px solid rgba(255, 255, 255, 0.12)";
      pop.style.borderRadius = "6px";
      pop.style.color = "#ddd";
      pop.style.whiteSpace = "pre";
      pop.style.display = "none";
      pop.style.pointerEvents = "none";
      pop.style.zIndex = "21";
      container.appendChild(pop);
      this.popupEl = pop;
    }
  }

  private setCmdline(text: string | null): void {
    if (this.opts.onCmdline) {
      try { this.opts.onCmdline(text); } catch (_) {}
    }
    if (!this.cmdlineEl) return;
    if (text == null || text === "") {
      this.cmdlineEl.textContent = "";
      this.cmdlineEl.style.display = "none";
      this.cmdlineVisible = false;
      return;
    }
    this.cmdlineEl.textContent = text;
    this.cmdlineEl.style.display = "block";
    this.cmdlineVisible = true;
  }

  private setMessage(text: string | null): void {
    if (this.opts.onMessage) {
      try { this.opts.onMessage(text); } catch (_) {}
    }
    if (!this.messageEl) return;
    if (this.messageTimer) {
      clearTimeout(this.messageTimer);
      this.messageTimer = null;
    }
    if (text == null || text === "") {
      this.messageEl.textContent = "";
      this.messageEl.style.display = "none";
      return;
    }
    this.messageEl.textContent = text;
    this.messageEl.style.display = "block";
    this.messageTimer = window.setTimeout(() => {
      this.messageTimer = null;
      this.setMessage(null);
    }, 4000);
  }

  private setPopupmenu(items: PopupMenuItem[] | null, selected: number): void {
    this.popupItems = items ?? [];
    this.popupSelected = selected;
    if (this.opts.onPopupmenu) {
      try { this.opts.onPopupmenu(items, selected); } catch (_) {}
    }
    if (!this.popupEl) return;
    if (!items || !items.length) {
      this.popupEl.textContent = "";
      this.popupEl.style.display = "none";
      return;
    }
    this.popupEl.innerHTML = "";
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      const row = document.createElement("div");
      row.style.padding = "2px 10px";
      row.style.display = "flex";
      row.style.gap = "10px";
      row.style.justifyContent = "space-between";
      row.style.background = i === selected ? "rgba(255,255,255,0.12)" : "transparent";
      const left = document.createElement("span");
      left.textContent = it.word ?? "";
      const right = document.createElement("span");
      right.style.opacity = "0.7";
      right.textContent = it.menu ?? it.kind ?? "";
      row.appendChild(left);
      row.appendChild(right);
      this.popupEl.appendChild(row);
    }
    this.popupEl.style.display = "block";
  }

  private applyMonacoWrap(cols: number): void {
    const c = Math.max(this.opts.minCols, Number(cols) || 0);
    if (!Number.isFinite(c) || c <= 0) return;
    const strategy = this.opts.wrapStrategy;
    if (this.wrapColumnApplied === c && this.wrapStrategyApplied === strategy) return;
    try {
      this.editor.updateOptions({
        wordWrap: "wordWrapColumn",
        wordWrapColumn: c,
        wrappingStrategy: strategy,
      } as any);
      this.wrapColumnApplied = c;
      this.wrapStrategyApplied = strategy;
    } catch (_) {
    }
  }

  private applyMonacoCursorMove(arg: Record<string, unknown>): void {
    const to = typeof arg.to === "string" ? arg.to : "";
    const by = typeof arg.by === "string" ? arg.by : "";
    const value = Math.max(1, Number(arg.value ?? 1) || 1);
    if (!to) return;

    const move = () => {
      try {
        this.editor.trigger("monaco-neovim-wasm", "cursorMove", { to, by, value } as any);
        return true;
      } catch (_) {
      }
      if (by === "wrappedLine" && (to === "down" || to === "up")) {
        const action = to === "down" ? "cursorDown" : "cursorUp";
        for (let i = 0; i < value; i += 1) {
          try { this.editor.trigger("monaco-neovim-wasm", action, null); } catch (_) {}
        }
        return true;
      }
      return false;
    };

    this.suppressCursorSync = true;
    void move();
    const pos = this.editor.getPosition();
    if (pos) this.lastCursorPos = pos;
    this.suppressCursorSync = false;
  }

  private applyMonacoReveal(arg: Record<string, unknown>): boolean {
    const direction = typeof arg.direction === "string" ? arg.direction : "";
    const resetCursor = Boolean(arg.resetCursor);
    const pos = this.editor.getPosition();
    if (!pos) return false;
    const line = pos.lineNumber;

    const rows = Math.max(1, this.uiRows || this.opts.rows);
    const fontInfo = this.editor.getOption(monaco.editor.EditorOption.fontInfo) as any;
    const lineHeight = Math.max(1, Number(fontInfo?.lineHeight ?? 0) || 0);

    this.suppressCursorSync = true;
    try {
      if (direction === "top") {
        const top = this.editor.getTopForLineNumber(line);
        this.editor.setScrollTop(top);
      } else if (direction === "center") {
        this.editor.revealLineInCenter(line);
      } else if (direction === "bottom") {
        const top = this.editor.getTopForLineNumber(line);
        const target = Math.max(0, top - (rows - 1) * lineHeight);
        this.editor.setScrollTop(target);
      }

      if (resetCursor) {
        const model = this.editor.getModel();
        if (model) {
          const text = model.getLineContent(line) ?? "";
          const m = /\S/.exec(text);
          const col = m ? (m.index + 1) : 1;
          const next = model.validatePosition(new monaco.Position(line, col));
          this.editor.setPosition(next);
          this.lastCursorPos = next;
        }
      }
    } catch (_) {
    }
    this.suppressCursorSync = false;
    return resetCursor;
  }

  private applyMonacoMoveCursor(arg: Record<string, unknown>): void {
    const to = typeof arg.to === "string" ? arg.to : "";
    if (!to) return;
    const model = this.editor.getModel();
    if (!model) return;

    let top = 1;
    let bottom = model.getLineCount();
    try {
      const ranges = this.editor.getVisibleRanges();
      if (ranges && ranges.length) {
        top = Math.min(...ranges.map((r) => r.startLineNumber));
        bottom = Math.max(...ranges.map((r) => r.endLineNumber));
      }
    } catch (_) {
    }
    top = Math.max(1, Math.min(top, model.getLineCount()));
    bottom = Math.max(1, Math.min(bottom, model.getLineCount()));
    if (bottom < top) bottom = top;

    let targetLine = top;
    if (to === "top") {
      targetLine = top;
    } else if (to === "middle") {
      targetLine = Math.floor((top + bottom) / 2);
    } else if (to === "bottom") {
      targetLine = bottom;
    } else {
      return;
    }

    const text = model.getLineContent(targetLine) ?? "";
    const m = /\S/.exec(text);
    const col = m ? (m.index + 1) : 1;
    const next = model.validatePosition(new monaco.Position(targetLine, col));
    this.suppressCursorSync = true;
    try { this.editor.setPosition(next); } catch (_) {}
    this.lastCursorPos = next;
    this.suppressCursorSync = false;
  }

  private syncTabstopFromMonaco(): void {
    const model = this.editor.getModel();
    if (!model) return;
    const anyModel = model as any;
    const tabSize = Math.max(1, Number(anyModel.getOptions?.().tabSize ?? 4) || 4);
    // Keep display width consistent across Neovim + Monaco for wrapped movement (gj/gk).
    this.sendNotify("nvim_command", [`set tabstop=${tabSize} shiftwidth=${tabSize} softtabstop=${tabSize}`]);
  }

  private updatePopupmenuSelection(selected: number): void {
    if (this.popupSelected === selected) return;
    this.popupSelected = selected;
    if (this.opts.onPopupmenu) {
      try { this.opts.onPopupmenu(this.popupItems, selected); } catch (_) {}
      return;
    }
    if (!this.popupEl) return;
    const children = Array.from(this.popupEl.children) as HTMLElement[];
    for (let i = 0; i < children.length; i += 1) {
      children[i].style.background = i === selected ? "rgba(255,255,255,0.12)" : "transparent";
    }
  }

  private handleRedraw(params: unknown[]): void {
    if (!Array.isArray(params)) return;
    for (const batch of params) {
      if (!Array.isArray(batch) || batch.length === 0) continue;
      const name = batch[0];
      if (typeof name !== "string") continue;
      const rawArgs = batch.slice(1);
      const args = rawArgs.length === 1 && Array.isArray(rawArgs[0]) ? (rawArgs[0] as unknown[]) : rawArgs;
      if (name === "cmdline_hide") {
        this.setCmdline(null);
        continue;
      }
      if (name === "cmdline_show") {
        const content = args[0];
        const firstc = typeof args[2] === "string" ? args[2] : "";
        const prompt = typeof args[3] === "string" ? args[3] : "";
        const indent = Math.max(0, Number(args[4] ?? 0) || 0);
        const prefix = prompt ? prompt : (firstc || "");
        const text = `${" ".repeat(indent)}${prefix}${uiChunksToText(content)}`;
        this.setCmdline(text);
        continue;
      }
      if (name === "msg_clear") {
        this.setMessage(null);
        continue;
      }
      if (name === "msg_show") {
        const kind = typeof args[0] === "string" ? args[0] : "";
        const content = args[1];
        const replaceLast = Boolean(args[2]);
        const append = Boolean(args[4]);
        const text = uiChunksToText(content);
        if (kind === "empty" && !text) {
          this.setMessage(null);
          continue;
        }
        if (!text) continue;
        if (append && this.messageEl?.textContent) {
          this.setMessage(`${this.messageEl.textContent}${text}`);
          continue;
        }
        if (replaceLast) {
          this.setMessage(text);
          continue;
        }
        this.setMessage(text);
        continue;
      }
      if (name === "msg_showmode" || name === "msg_showcmd" || name === "msg_ruler") {
        const content = args[0];
        const text = uiChunksToText(content);
        this.setMessage(text || null);
        continue;
      }
      if (name === "popupmenu_hide") {
        this.setPopupmenu(null, -1);
        continue;
      }
      if (name === "popupmenu_show") {
        const itemsRaw = args[0];
        const selected = Number(args[1] ?? -1);
        const items = parsePopupmenuItems(itemsRaw);
        this.setPopupmenu(items, Number.isFinite(selected) ? selected : -1);
        continue;
      }
      if (name === "popupmenu_select") {
        const selected = Number(args[0] ?? -1);
        this.updatePopupmenuSelection(Number.isFinite(selected) ? selected : -1);
        continue;
      }
      if (name === "mode_change") {
        const mode = typeof args[0] === "string" ? args[0] : "";
        this.applyNvimMode(mode);
        continue;
      }
    }
  }

  private initTextInputListeners(): void {
    const root = this.editor.getDomNode();
    if (!root) return;
    const inputs = Array.from(root.querySelectorAll("textarea.inputarea")) as HTMLTextAreaElement[];
    if (!inputs.length) return;

    const nowMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

    const stopAll = (e: Event) => {
      try { (e as any).stopImmediatePropagation?.(); } catch (_) {}
      try { e.stopPropagation(); } catch (_) {}
    };

    const onCompositionStart = () => {
      this.compositionActive = true;
      if (this.delegateInsertToMonaco) {
        this.setPreedit(null);
        return;
      }
      this.setPreedit("");
    };
    const onCompositionEndStateOnly = () => {
      this.compositionActive = false;
      this.setPreedit(null);
    };
    const onCompositionEnd = (e: CompositionEvent) => {
      this.compositionActive = false;
      this.setPreedit(null);
      if (this.delegateInsertToMonaco) {
        this.scheduleCursorSyncToNvim();
        return;
      }
      const target = e.target as HTMLTextAreaElement | null;
      try { if (target) target.value = ""; } catch (_) {}
      if (this.pendingResyncAfterComposition) {
        this.pendingResyncAfterComposition = false;
        this.scheduleResync();
      }
    };
    const onCompositionUpdate = (e: CompositionEvent) => {
      if (!this.compositionActive) this.compositionActive = true;
      if (this.delegateInsertToMonaco) return;
      const target = e.target as HTMLTextAreaElement | null;
      const data = typeof e.data === "string" ? e.data : (target?.value ? String(target.value) : "");
      this.setPreedit(data || "");
    };
    const onBeforeInput = (e: Event) => {
      if (this.delegateInsertToMonaco) return;
      // Prevent Monaco from turning IME/text input events into model edits; Neovim
      // remains the source of truth and we re-render from nvim_buf_lines_event.
      stopAll(e);
    };
    const onInput = (e: Event) => {
      if (this.delegateInsertToMonaco) return;
      stopAll(e);
      const ie = e as InputEvent;
      const target = ie.target as HTMLTextAreaElement | null;

      if (this.ignoreNextInputEvent) {
        this.ignoreNextInputEvent = false;
        try { if (target) target.value = ""; } catch (_) {}
        return;
      }
      if (this.compositionActive) return;

      try { if (target) target.value = ""; } catch (_) {}
    };
    const onPaste = (e: ClipboardEvent) => {
      if (this.delegateInsertToMonaco) return;
      stopAll(e);
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text) {
        e.preventDefault();
        this.pasteText(text);
      }
      try { (e.target as HTMLTextAreaElement | null)?.value && ((e.target as HTMLTextAreaElement).value = ""); } catch (_) {}
    };

    this.disposables.push(
      // Capture phase to ensure we see events even if Monaco stops propagation.
      domListener(root, "compositionstart", onCompositionStart, true),
      domListener(root, "compositionupdate", onCompositionUpdate, true),
      domListener(root, "compositionend", onCompositionEndStateOnly, true),
    );

    for (const input of inputs) {
      this.disposables.push(
        domListener(input, "beforeinput", onBeforeInput, true),
        domListener(input, "input", onInput, true),
        domListener(input, "compositionstart", (e) => { onCompositionStart(); void e; }, true),
        domListener(input, "compositionupdate", (e) => { onCompositionUpdate(e as CompositionEvent); }, true),
        domListener(input, "compositionend", (e) => { onCompositionEnd(e as CompositionEvent); }, true),
        domListener(input, "paste", onPaste, true),
      );
    }
  }

  private scheduleResync(): void {
    if (this.resyncTimer) return;
    this.resyncTimer = window.setTimeout(() => {
      this.resyncTimer = null;
      void this.resyncBufferFromNvim();
    }, 50);
  }

  private async resyncBufferFromNvim(): Promise<void> {
    if (this.compositionActive) return;
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;
    try {
      const lines = await this.rpcCall("nvim_buf_get_lines", [this.bufHandle, 0, -1, false]);
      this.applyBuffer(Array.isArray(lines) ? (lines as string[]) : [""]);
    } catch (_) {
    }
  }

  private applyBuffer(lines: string[] = [""]): void {
    const model = this.editor.getModel();
    if (!model) return;
    const joined = (lines && lines.length ? lines : [""]).join("\n");
    if (model.getValue() === joined) return;
    const pos = this.lastCursorPos ?? this.editor.getPosition() ?? new monaco.Position(1, 1);
    this.suppressCursorSync = true;
    this.applyingFromNvim = true;
    model.setValue(joined);
    this.applyingFromNvim = false;
    if (pos) this.editor.setPosition(pos);
    this.suppressCursorSync = false;
    if (this.delegateInsertToMonaco) {
      try { this.shadowLines = model.getLinesContent(); } catch (_) {}
    }
  }

  private ensureVisualStyle(): void {
    if (this.visualStyleEl) return;
    const el = document.createElement("style");
    el.id = "monaco-neovim-wasm-visual-style";
    el.textContent = `
.monaco-neovim-visual-line {
  background-color: ${this.visualBgCss};
}
.monaco-neovim-visual-inline {
  background-color: ${this.visualBgCss};
}
`;
    document.head.appendChild(el);
    this.visualStyleEl = el;
  }

  private setVisualBgCss(bg: string): void {
    const next = bg || this.visualBgCss;
    if (next === this.visualBgCss && this.visualStyleEl) return;
    this.visualBgCss = next;
    if (this.visualStyleEl) {
      this.visualStyleEl.textContent = `
.monaco-neovim-visual-line {
  background-color: ${this.visualBgCss};
}
.monaco-neovim-visual-inline {
  background-color: ${this.visualBgCss};
}
`;
    }
  }

  private clearVisualDecorations(): void {
    if (!this.visualDecorationIds.length) return;
    try {
      this.visualDecorationIds = this.editor.deltaDecorations(this.visualDecorationIds, []);
    } catch (_) {
      this.visualDecorationIds = [];
    }
    this.visualSelectionActive = false;
  }

  private applyVisualDecorations(selections: monaco.Selection[], mode: string): void {
    this.ensureVisualStyle();
    const tail = getModeTail(mode);
    const isLinewise = tail === "V";
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    if (isLinewise) {
      let minLine = Infinity;
      let maxLine = -Infinity;
      for (const sel of selections) {
        const a = sel.getStartPosition();
        const b = sel.getEndPosition();
        minLine = Math.min(minLine, a.lineNumber, b.lineNumber);
        maxLine = Math.max(maxLine, a.lineNumber, b.lineNumber);
      }
      if (Number.isFinite(minLine) && Number.isFinite(maxLine) && maxLine >= minLine) {
        decorations.push({
          range: new monaco.Range(minLine, 1, maxLine, 1),
          options: { isWholeLine: true, className: "monaco-neovim-visual-line" },
        });
      }
    } else {
      for (const sel of selections) {
        const a = sel.getStartPosition();
        const b = sel.getEndPosition();
        decorations.push({
          range: monaco.Range.fromPositions(a, b),
          options: { inlineClassName: "monaco-neovim-visual-inline" },
        });
      }
    }
    try {
      this.visualDecorationIds = this.editor.deltaDecorations(this.visualDecorationIds, decorations);
      this.visualSelectionActive = decorations.length > 0;
    } catch (_) {
      this.visualDecorationIds = [];
      this.visualSelectionActive = false;
    }
  }

  private applyNvimMode(mode: string): void {
    const m = typeof mode === "string" ? mode : "";
    if (!m || m === this.lastMode) return;
    this.lastMode = m;

    const nextDelegate = isInsertLike(m);
    if (nextDelegate !== this.delegateInsertToMonaco) {
      this.delegateInsertToMonaco = nextDelegate;
      if (nextDelegate) {
        this.setPreedit(null);
        this.shadowLines = this.editor.getModel()?.getLinesContent() ?? null;
        this.pendingBufEdits = [];
        this.pendingFullSync = false;
        this.pendingCursorSync = false;
      } else {
        if (this.pendingBufEdits.length || this.pendingCursorSync || this.pendingFullSync) {
          this.flushPendingMonacoSync();
        }
        this.shadowLines = null;
        this.pendingBufEdits = [];
        this.pendingFullSync = false;
        this.pendingCursorSync = false;
      }
    }

    this.applyCursorStyle(m);
    if (this.opts.onModeChange) this.opts.onModeChange(m);
    void this.updateVisualSelection(m);
  }

  private handleKey(ev: monaco.IKeyboardEvent): void {
    const browserEvent = ev.browserEvent as KeyboardEvent;
    if (browserEvent.defaultPrevented && browserEvent.key !== "Escape") return;
    if (this.delegateInsertToMonaco) {
      // While delegating insert-mode typing to Monaco (IME-friendly), only
      // forward "command-like" keys to Neovim after syncing Monaco -> Neovim.
      if (browserEvent.key === "Escape") {
        ev.preventDefault();
        this.flushPendingMonacoSync();
        this.sendInput("<Esc>");
        return;
      }
      if (!this.opts.shouldHandleKey(browserEvent)) return;
      if (browserEvent.ctrlKey || browserEvent.altKey || browserEvent.metaKey) {
        const key = this.opts.translateKey(browserEvent);
        if (!key) return;
        ev.preventDefault();
        this.flushPendingMonacoSync();
        this.sendInput(key);
        return;
      }
      return;
    }
    if (
      this.ignoreTextKeydownUntil > 0
      && (typeof browserEvent.key === "string" && browserEvent.key.length === 1)
      && !browserEvent.ctrlKey
      && !browserEvent.metaKey
      && !browserEvent.altKey
      && (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) < this.ignoreTextKeydownUntil
    ) {
      return;
    }
    // IME: don't intercept Process/229 events; they are part of composition flow.
    if (browserEvent.key === "Process" || (browserEvent as any).keyCode === 229) {
      this.compositionActive = true;
      return;
    }
    if (this.compositionActive || browserEvent.isComposing) return;
    if (!this.opts.shouldHandleKey(browserEvent)) return;
    const key = this.opts.translateKey(browserEvent);
    if (!key) return;
    // Some browsers still dispatch an `input` event even if we preventDefault on
    // keydown. Ignore the next `input` to avoid double-sending text.
    this.ignoreNextInputEvent = true;
    ev.preventDefault();
    this.sendInput(key);
  }

  private handleMouse(ev: monaco.editor.IEditorMouseEvent): void {
    if (this.delegateInsertToMonaco) return;
    if (!this.bufHandle || !ev.target?.position) return;
    const { lineNumber, column } = ev.target.position;
    const model = this.editor.getModel();
    const charCol0 = Math.max(0, column - 1);
    const text = model ? (model.getLineContent(lineNumber) ?? "") : "";
    const byteCol0 = model ? charIndexToByteIndex(text, charCol0) : charCol0;
    this.sendNotify("nvim_win_set_cursor", [0, [lineNumber, byteCol0]]);
  }

  private sendInput(keys: string): void {
    this.sendNotify("nvim_input", [keys]);
  }

  private pasteText(text: string): void {
    const payload = String(text ?? "");
    if (!payload) return;
    const crlf = payload.includes("\r\n");
    this.sendNotify("nvim_paste", [payload, crlf, -1]);
  }

  private handleMonacoModelChange(ev: monaco.editor.IModelContentChangedEvent): void {
    if (!this.delegateInsertToMonaco) return;
    if (this.applyingFromNvim) return;
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;
    const model = this.editor.getModel();
    if (!model) return;

    if (!this.shadowLines) {
      // We don't have a reliable pre-change snapshot; fall back to full sync.
      this.pendingFullSync = true;
      this.pendingCursorSync = true;
      this.shadowLines = model.getLinesContent();
      this.scheduleFlushPendingMonacoSync();
      return;
    }

    if (!ev.changes || ev.changes.length !== 1) {
      this.pendingFullSync = true;
      this.pendingCursorSync = true;
      this.shadowLines = model.getLinesContent();
      this.scheduleFlushPendingMonacoSync();
      return;
    }

    const change = ev.changes[0];
    const range = change.range;
    const startRow = range.startLineNumber - 1;
    const endRow = range.endLineNumber - 1;
    if (startRow < 0 || endRow < 0) return;
    if (this.shadowLines[startRow] == null || this.shadowLines[endRow] == null) {
      this.pendingFullSync = true;
      this.pendingCursorSync = true;
      this.shadowLines = model.getLinesContent();
      this.scheduleFlushPendingMonacoSync();
      return;
    }

    const oldStartLine = this.shadowLines[startRow] ?? "";
    const oldEndLine = this.shadowLines[endRow] ?? "";
    const startColChar = Math.max(0, range.startColumn - 1);
    const endColChar = Math.max(0, range.endColumn - 1);
    const startColByte = charIndexToByteIndex(oldStartLine, startColChar);
    const endColByte = charIndexToByteIndex(oldEndLine, endColChar);
    const text = String(change.text ?? "");
    const lines = text.length ? text.split(/\r?\n/) : [];

    this.pendingBufEdits.push({ startRow, startColByte, endRow, endColByte, lines });
    applyShadowLinesChange(this.shadowLines, startRow, startColChar, endRow, endColChar, text);

    this.pendingCursorSync = true;
    this.scheduleFlushPendingMonacoSync();
  }

  private scheduleCursorSyncToNvim(): void {
    if (!this.delegateInsertToMonaco) return;
    this.pendingCursorSync = true;
    this.scheduleFlushPendingMonacoSync();
  }

  private scheduleFlushPendingMonacoSync(): void {
    if (this.cursorSyncTimer) return;
    this.cursorSyncTimer = window.setTimeout(() => {
      this.cursorSyncTimer = null;
      this.flushPendingMonacoSync();
    }, 0);
  }

  private flushPendingMonacoSync(): void {
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;
    const model = this.editor.getModel();
    if (!model) return;

    if (this.pendingFullSync) {
      const lines = model.getLinesContent();
      this.sendNotify("nvim_buf_set_lines", [this.bufHandle, 0, -1, false, lines]);
      this.pendingFullSync = false;
      this.pendingBufEdits = [];
      this.shadowLines = lines.slice();
    } else if (this.pendingBufEdits.length) {
      for (const edit of this.pendingBufEdits) {
        this.sendNotify("nvim_buf_set_text", [this.bufHandle, edit.startRow, edit.startColByte, edit.endRow, edit.endColByte, edit.lines]);
      }
      this.pendingBufEdits = [];
    }

    if (this.pendingCursorSync) {
      this.pendingCursorSync = false;
      this.syncCursorToNvimNow();
    }
  }

  private syncCursorToNvimNow(): void {
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;
    const model = this.editor.getModel();
    const pos = this.editor.getPosition();
    if (!model || !pos) return;
    const lineNumber = pos.lineNumber;
    const text = model.getLineContent(lineNumber) ?? "";
    const byteCol0 = charIndexToByteIndex(text, Math.max(0, pos.column - 1));
    this.sendNotify("nvim_win_set_cursor", [0, [lineNumber, byteCol0]]);
  }

  private scheduleVisualSelectionRefresh(): void {
    if (this.visualSelectionRefreshTimer) return;
    this.visualSelectionRefreshTimer = window.setTimeout(() => {
      this.visualSelectionRefreshTimer = null;
      void this.updateVisualSelection(this.lastMode || "n");
    }, 16);
  }

  private async installHostAutocmds(): Promise<void> {
    if (this.hostAutocmdInstalled) return;
    try {
      const info = await this.rpcCall("nvim_get_api_info", []);
      const chan = Array.isArray(info) ? Number(info[0]) : NaN;
      if (!Number.isFinite(chan) || chan <= 0) return;
      this.nvimChannelId = chan;
      const wrapped = this.opts.wrappedLineMotions ? "true" : "false";
      const scroll = this.opts.scrollMotions ? "true" : "false";
const lua = `
local chan = ...
local api = vim.api
vim.g.monaco_neovim_wasm_chan = chan

local function send_cursor()
  local cur = api.nvim_win_get_cursor(0)
  vim.rpcnotify(chan, "monaco_cursor", cur[1], cur[2])
end

local function send_mode()
  local m = api.nvim_get_mode().mode or ""
  vim.rpcnotify(chan, "monaco_mode", m)
end

if ${wrapped} then
  pcall(vim.cmd, "silent! source $HOME/.config/nvim/monaco-neovim-wasm/motion.vim")
end

if ${scroll} then
  pcall(vim.cmd, "silent! source $HOME/.config/nvim/monaco-neovim-wasm/scrolling.vim")
end

local group = api.nvim_create_augroup("MonacoNeovimWasm", { clear = true })
api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
  group = group,
  callback = function() send_cursor() end,
})
api.nvim_create_autocmd({ "ModeChanged", "InsertEnter", "InsertLeave" }, {
  group = group,
  callback = function() send_mode(); send_cursor() end,
})
api.nvim_create_autocmd({ "VisualEnter", "VisualLeave" }, {
  group = group,
  callback = function() send_mode(); send_cursor() end,
})

send_mode()
send_cursor()
`;
      await this.rpcCall("nvim_exec_lua", [lua, [chan]]);
      this.hostAutocmdInstalled = true;
    } catch (_) {
    }
  }

  private sendNotify(method: string, params: unknown[] = []): void {
    this.session?.notify(method, params);
  }

  private sendRpcResponse(msgid: number, error: unknown, result: unknown): void {
    this.session?.respond(msgid, error, result);
  }

  private rpcCall(method: string, params: unknown[] = []): Promise<any> {
    if (!this.session) return Promise.reject(new Error("session not started"));
    return this.session.call(method, params);
  }

  private doClipboardPaste(msgid: number): void {
    const fallback = (text: string | null | undefined) => {
      const lines = (text || "").split(/\r?\n/);
      this.sendRpcResponse(msgid, null, [lines, "v"]);
    };
    const adapter = this.opts.clipboard;
    if (adapter === null) {
      fallback("");
      return;
    }
    if (adapter?.readText) {
      adapter.readText()
        .then((text) => fallback(text || ""))
        .catch(() => {
          const manual = window.prompt("Paste text");
          fallback(manual || "");
        });
      return;
    }
    if (!navigator.clipboard?.readText) {
      const manual = window.prompt("Paste text");
      fallback(manual || "");
      return;
    }
    navigator.clipboard.readText()
      .then((text) => fallback(text || ""))
      .catch(() => fallback(""));
  }

  private updateCursor(lineNumber: number, column: number): void {
    const model = this.editor.getModel();
    const ln = Math.max(1, Number(lineNumber) || 1);
    const cl = Math.max(1, Number(column) || 1);
    const validated = model
      ? model.validatePosition(new monaco.Position(ln, cl))
      : new monaco.Position(ln, cl);
    this.lastCursorPos = validated;
    if (this.compositionActive) return;
    const current = this.editor.getPosition();
    const same = current && current.lineNumber === validated.lineNumber && current.column === validated.column;
    if (!same) {
      this.suppressCursorSync = true;
      this.editor.setPosition(this.lastCursorPos);
      if (this.visualSelectionActive) {
        this.editor.setSelection(new monaco.Selection(validated.lineNumber, validated.column, validated.lineNumber, validated.column));
      }
      this.editor.revealPositionInCenterIfOutsideViewport(this.lastCursorPos);
      this.suppressCursorSync = false;
    }
  }

  private scheduleCursorRefresh(): void {
    if (this.compositionActive) return;
    if (this.cursorRefreshTimer) return;
    const now = (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
    const delay = this.optimisticCursorUntil > now ? Math.max(30, Math.min(180, this.optimisticCursorUntil - now)) : 30;
    this.cursorRefreshTimer = window.setTimeout(() => {
      this.cursorRefreshTimer = null;
      void this.refreshCursorMode();
    }, delay);
  }

  private async refreshCursorMode(): Promise<void> {
    if (this.compositionActive) return;
    const now = (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
    if (this.optimisticCursorUntil > now) {
      // Avoid overwriting an optimistic caret update with a stale poll result.
      this.scheduleCursorRefresh();
      return;
    }
    if (this.cursorRefreshInFlight) {
      this.cursorRefreshPending = true;
      return;
    }
    this.cursorRefreshInFlight = true;
    try {
      const cursor = await this.rpcCall("nvim_win_get_cursor", [0]);
      if (Array.isArray(cursor) && cursor.length >= 2) {
        const ln = Number(cursor[0]);
        const col0 = Number(cursor[1]);
        const clamped = clampCursor(this.editor, ln, col0);
        const next = new monaco.Position(clamped.line, clamped.col);
        const now2 = (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
        if (this.optimisticCursorPos && this.optimisticCursorUntil > now2) {
          const prev = this.optimisticCursorPrevPos;
          if (prev && next.lineNumber === prev.lineNumber && next.column === prev.column) {
            // Still seeing the old cursor; keep optimistic.
          } else if (next.lineNumber < this.optimisticCursorPos.lineNumber
            || (next.lineNumber === this.optimisticCursorPos.lineNumber && next.column < this.optimisticCursorPos.column)) {
            // Cursor moved backwards relative to optimistic position; likely stale.
          } else {
            this.optimisticCursorPos = null;
            this.optimisticCursorPrevPos = null;
            this.optimisticCursorUntil = 0;
            this.updateCursor(next.lineNumber, next.column);
          }
        } else {
          this.optimisticCursorPos = null;
          this.optimisticCursorPrevPos = null;
          this.optimisticCursorUntil = 0;
          this.updateCursor(next.lineNumber, next.column);
        }
      }
      if (!this.lastMode) {
        try {
          const mode = await this.rpcCall("nvim_get_mode", []);
          if (mode && typeof (mode as { mode?: string }).mode === "string") {
            const m = (mode as { mode: string }).mode;
            this.lastMode = m;
            this.applyCursorStyle(m);
            if (this.opts.onModeChange) this.opts.onModeChange(m);
          }
        } catch (_) {
        }
      }
      await this.updateVisualSelection(this.lastMode || "n");
    } catch (err) {
      void err;
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
      this.clearVisualDecorations();
      return;
    }
    try {
      const selections = await this.fetchVisualRanges();
      if (token !== this.visualSelectionToken) return;
      if (!selections.length) return;
      this.applyVisualDecorations(selections, mode);
    } catch (_) {
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
      this.setVisualBgCss(main);
    } catch (_) {
    }
  }

  private async fetchVisualBg(): Promise<string | null> {
    try {
      const hl = await this.rpcCall("nvim_get_hl", [0, { name: "Visual", link: false }]);
      const bg = normalizeHlBg(hl);
      if (bg) return bg;
    } catch (_) {
    }
    try {
      const hl = await this.rpcCall("nvim_get_hl_by_name", ["Visual", true]);
      const bg = normalizeHlBg(hl);
      if (bg) return bg;
    } catch (_) {
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
      await this.rpcCall("nvim_buf_set_option", [buf, "filetype", this.opts.seedFiletype]);
      await this.rpcCall("nvim_buf_set_name", [buf, this.opts.seedName]);
      return seed;
    } catch (_) {
      return null;
    }
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
  if (!key || key === "Dead" || key === "Unidentified") return null;

  const isCtrl = ev.ctrlKey;
  const isAlt = ev.altKey;
  const isMeta = ev.metaKey;
  const isShift = ev.shiftKey;

  const withMods = (name: string, includeShift = false) => {
    const all: string[] = [];
    if (isCtrl) all.push("C-");
    if (includeShift && isShift) all.push("S-");
    if (isAlt) all.push("A-");
    if (isMeta) all.push("D-");
    return all.length ? `<${all.join("")}${name}>` : `<${name}>`;
  };

  switch (key) {
    case "Backspace": return withMods("BS", true);
    case "Enter": return withMods("CR", true);
    case "Escape": return withMods("Esc", true);
    case "Tab": return isShift && !isCtrl && !isAlt && !isMeta ? "<S-Tab>" : withMods("Tab", true);
    case "ArrowUp": return withMods("Up", true);
    case "ArrowDown": return withMods("Down", true);
    case "ArrowLeft": return withMods("Left", true);
    case "ArrowRight": return withMods("Right", true);
    case "Delete": return withMods("Del", true);
    case "Home": return withMods("Home", true);
    case "End": return withMods("End", true);
    case "PageUp": return withMods("PageUp", true);
    case "PageDown": return withMods("PageDown", true);
    case "Insert": return withMods("Insert", true);
    default: break;
  }

  if (/^F\d{1,2}$/.test(key)) return withMods(key, true);

  if (key.length === 1) {
    if (!isCtrl && !isAlt && !isMeta) return key;
    if (key === " " && isCtrl && !isAlt && !isMeta) return "<Nul>";
    const ch = /^[A-Za-z]$/.test(key) ? key.toLowerCase() : key;
    const prefix = (isCtrl ? "C-" : "") + (isAlt ? "A-" : "") + (isMeta ? "D-" : "");
    return `<${prefix}${ch}>`;
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

function charIndexToByteIndex(text: string, charIndex: number): number {
  const target = Math.max(0, Number(charIndex) || 0);
  let bytes = 0;
  let i = 0;
  while (i < target && i < text.length) {
    const code = text.codePointAt(i);
    const b = utf8ByteLength(code ?? 0);
    bytes += b;
    i += b === 4 ? 2 : 1;
  }
  return bytes;
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
    if (charIndex < text.length) {
      const cp = text.codePointAt(charIndex);
      endByte = byte + utf8ByteLength(cp ?? 0);
    }
  }
  const column = byteIndexToCharIndex(text, endByte) + 1;
  const maxColumn = model.getLineMaxColumn(lineNumber);
  return { lineNumber, column: clamp(column, 1, maxColumn) };
}

function isVisualMode(mode: string): boolean {
  const m = typeof mode === "string" ? mode : "";
  return m.includes("v") || m.includes("V") || m.includes("\u0016") || m.includes("s") || m.includes("S") || m.includes("\u0013");
}

function normalizeSessionFiles(files?: Array<{ path: string; data: Uint8Array | string }> | null) {
  if (!files || !Array.isArray(files) || files.length === 0) return undefined;
  const enc = new TextEncoder();
  const out: Array<{ path: string; data: Uint8Array }> = [];
  for (const f of files) {
    if (!f) continue;
    const path = String((f as any).path ?? "");
    if (!path) continue;
    const data = (f as any).data;
    if (data instanceof Uint8Array) out.push({ path, data });
    else out.push({ path, data: enc.encode(String(data ?? "")) });
  }
  return out.length ? out : undefined;
}

function mergeSessionFiles(
  user?: Array<{ path: string; data: Uint8Array | string }> | null,
  internal?: Array<{ path: string; data: Uint8Array | string }> | null,
): Array<{ path: string; data: Uint8Array | string }> | undefined {
  const a = Array.isArray(internal) ? internal.filter(Boolean) : [];
  const b = Array.isArray(user) ? user.filter(Boolean) : [];
  const all = [...a, ...b];
  return all.length ? all : undefined;
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

function domListener<E extends Event>(
  target: EventTarget,
  type: string,
  handler: (ev: E) => void,
  options?: AddEventListenerOptions | boolean,
): monaco.IDisposable {
  target.addEventListener(type, handler as EventListener, options);
  return { dispose: () => target.removeEventListener(type, handler as EventListener, options) };
}

function isInsertLike(mode: string): boolean {
  const m = typeof mode === "string" ? mode : "";
  return m.startsWith("i") || m.startsWith("R");
}

function getModeTail(mode: string): string {
  const m = typeof mode === "string" ? mode : "";
  return m.length ? m[m.length - 1] : "";
}

function applyShadowLinesChange(
  lines: string[],
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  text: string,
): void {
  const beforeLine = lines[startRow] ?? "";
  const afterLine = lines[endRow] ?? "";
  const prefix = beforeLine.slice(0, Math.max(0, startCol));
  const suffix = afterLine.slice(Math.max(0, endCol));
  const inserted = String(text ?? "");
  const parts = inserted.split(/\r?\n/);

  let replacement: string[];
  if (parts.length <= 1) {
    replacement = [`${prefix}${parts[0] ?? ""}${suffix}`];
  } else {
    const first = `${prefix}${parts[0] ?? ""}`;
    const last = `${parts[parts.length - 1] ?? ""}${suffix}`;
    const middle = parts.slice(1, -1);
    replacement = [first, ...middle, last];
  }

  lines.splice(startRow, Math.max(0, endRow - startRow + 1), ...replacement);
}

function uiChunksToText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  let out = "";
  for (const part of content) {
    if (typeof part === "string") {
      out += part;
      continue;
    }
    if (Array.isArray(part)) {
      // Neovim UI chunks are typically [attr_id|attrs, text_chunk, hl_id].
      if (typeof part[1] === "string") {
        out += part[1];
      } else if (typeof part[0] === "string") {
        // Back-compat for older/simple chunk shapes.
        out += part[0];
      } else {
        out += uiChunksToText(part);
      }
      continue;
    }
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      out += (part as { text: string }).text;
    }
  }
  return out;
}

function parsePopupmenuItems(items: unknown): PopupMenuItem[] {
  if (!Array.isArray(items)) return [];
  const out: PopupMenuItem[] = [];
  for (const it of items) {
    if (Array.isArray(it)) {
      out.push({
        word: String(it[0] ?? ""),
        kind: it[1] == null ? undefined : String(it[1]),
        menu: it[2] == null ? undefined : String(it[2]),
        info: it[3] == null ? undefined : String(it[3]),
      });
      continue;
    }
    if (it && typeof it === "object") {
      const obj = it as Record<string, unknown>;
      const word = obj.word ?? obj.abbr ?? obj.text;
      if (word != null) out.push({ word: String(word), kind: obj.kind ? String(obj.kind) : undefined, menu: obj.menu ? String(obj.menu) : undefined, info: obj.info ? String(obj.info) : undefined });
    }
  }
  return out.filter((x) => x.word.length > 0);
}

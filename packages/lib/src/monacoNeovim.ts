import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";
import { DEFAULT_SHARED_INPUT_BYTES } from "./sharedInput";
import { NeovimWasmSession, type NeovimWasmInputMode } from "./neovimWasmSession";
import motionOverridesVim from "./overrides/motion.vim?raw";
import scrollingOverridesVim from "./overrides/scrolling.vim?raw";
import hostCommandsOverridesVim from "./overrides/host-commands.vim?raw";

export type StatusEmitter = (text: string, warn?: boolean) => void;
export type ClipboardAdapter = {
  readText?: () => Promise<string>;
  writeText?: (text: string) => Promise<void>;
};

export type FileSystemAdapter = {
  readFile?: (path: string) => Promise<string | Uint8Array | null | undefined>;
  writeFile?: (path: string, data: string | Uint8Array) => Promise<void>;
};

export type HostCommand =
  | { action: "edit"; path?: string; bang?: boolean }
  | { action: "write"; path?: string; bang?: boolean }
  | { action: "quit"; bang?: boolean }
  | { action: "wq"; bang?: boolean }
  | { action: string; [k: string]: unknown };

export type MonacoNeovimOptions = {
  worker?: Worker | null;
  workerUrl?: URL;
  reuseWorker?: boolean;
  wasmPath?: string;
  runtimePath?: string;
  inputMode?: NeovimWasmInputMode;
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
  scrolloff?: number;
  syncScrolloff?: boolean;
  ctrlKeysForNormalMode?: string[];
  ctrlKeysForInsertMode?: string[];
  altKeysForNormalMode?: string[];
  altKeysForInsertMode?: string[];
  metaKeysForNormalMode?: string[];
  metaKeysForInsertMode?: string[];
  searchHighlights?: boolean;
  hostCommands?: boolean;
  fileSystem?: FileSystemAdapter | null;
  onHostCommand?: (cmd: HostCommand) => void | Promise<void>;
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
  insertSyncDebounceMs?: number;
  debug?: boolean;
  debugLog?: (line: string) => void;
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
  inputMode: NeovimWasmInputMode;
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
  scrolloff?: number;
  syncScrolloff: boolean;
  ctrlKeysForNormalMode?: string[];
  ctrlKeysForInsertMode?: string[];
  altKeysForNormalMode?: string[];
  altKeysForInsertMode?: string[];
  metaKeysForNormalMode?: string[];
  metaKeysForInsertMode?: string[];
  searchHighlights: boolean;
  hostCommands: boolean;
  fileSystem?: FileSystemAdapter | null;
  onHostCommand?: (cmd: HostCommand) => void | Promise<void>;
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
  insertSyncDebounceMs: number;
  debug: boolean;
  debugLog?: (line: string) => void;
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

type BufferState = {
  id: number;
  name: string;
  filetype: string;
  model: monaco.editor.ITextModel;
  createdModel: boolean;
  shadowLines: string[] | null;
  pendingBufEdits: PendingBufSetText[];
  pendingFullSync: boolean;
  pendingCursorSync: boolean;
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

	-- virtcol2col() returns a column (1-indexed) for the given virtual column.
	-- Neovim <= 0.9 returns the *last* byte of a multibyte character, while Neovim >= 0.10 returns the *first* byte.
	-- For our byte<->Monaco conversion we always want the 0-indexed *first* byte of the character.
	local function virtcol2byte0(winid, lnum, virtcol)
	  local byte0 = fn.virtcol2col(winid, lnum, virtcol) - 1
	  if fn.has("nvim-0.10.0") == 1 then
	    return byte0
	  end
	  local buf = api.nvim_win_get_buf(winid)
	  local line = api.nvim_buf_get_lines(buf, lnum - 1, lnum, false)[1] or ""
	  local char_idx = fn.charidx(line, byte0)
	  local prefix = fn.strcharpart(line, 0, char_idx)
	  return #prefix
	end

	local function char_width_at_byte0(line, byte0)
	  if not line or line == "" then return 1, "" end
	  local b = math.max(0, math.min(#line, byte0 or 0))
	  local char_idx = fn.charidx(line, b)
	  local ch = fn.strcharpart(line, char_idx, 1)
	  if ch == "\\t" then return 1, ch end
	  local w = fn.strdisplaywidth(ch)
	  if not w or w < 1 then w = 1 end
	  return w, ch
	end

	local function start_vcol_at_byte0(line, byte0)
	  if not line or line == "" then return 1 end
	  local b = math.max(0, math.min(#line, byte0 or 0))
	  local char_idx = fn.charidx(line, b)
	  local prefix = fn.strcharpart(line, 0, char_idx)
	  return fn.strdisplaywidth(prefix) + 1
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
	  local inclusive = (vim.o.selection or "inclusive") == "inclusive"
	  local start_vcol, end_vcol = fn.virtcol("v"), fn.virtcol(".")
	  if not inclusive then
	    -- 'selection=exclusive' excludes the cursor column from Visual selections.
	    if end_vcol >= start_vcol then
	      end_vcol = end_vcol - 1
	    else
	      end_vcol = end_vcol + 1
	    end
	    if end_vcol < 1 then end_vcol = 1 end
	  end
	  local left_vcol, right_vcol = math.min(start_vcol, end_vcol), math.max(start_vcol, end_vcol)
	  local top, bot = math.min(sline, eline), math.max(sline, eline)
	  for lnum = top, bot do
	    local line = api.nvim_buf_get_lines(buf, lnum, lnum + 1, false)[1] or ""
	    local disp = fn.strdisplaywidth(line)
	    local line_bytes = #line
	    local col_a = left_vcol > disp and line_bytes or virtcol2byte0(win, lnum + 1, left_vcol)
	    local col_b = right_vcol > disp and line_bytes or virtcol2byte0(win, lnum + 1, right_vcol)
	    if col_a > line_bytes then col_a = line_bytes end
	    if col_b > line_bytes then col_b = line_bytes end

	    local eff_left_vcol = left_vcol
	    if left_vcol <= disp then
	      local start_vcol_a = start_vcol_at_byte0(line, col_a)
	      local w_a, ch_a = char_width_at_byte0(line, col_a)
	      if ch_a ~= "\\t" and w_a > 1 and eff_left_vcol > start_vcol_a then
	        eff_left_vcol = start_vcol_a
	      end
	    end

	    local eff_right_vcol = right_vcol
	    if right_vcol <= disp then
	      local start_vcol_b = start_vcol_at_byte0(line, col_b)
	      local w_b, ch_b = char_width_at_byte0(line, col_b)
	      if ch_b ~= "\\t" and w_b > 1 then
	        eff_right_vcol = start_vcol_b + (w_b - 1)
	      end
	    end

	    if eff_right_vcol < eff_left_vcol then
	      eff_left_vcol, eff_right_vcol = eff_right_vcol, eff_left_vcol
	    end
	    table.insert(ranges, {
	      start = { line = lnum, col = col_a },
	      ["end"] = { line = lnum, col = col_b },
	      inclusive = inclusive,
	      start_vcol = eff_left_vcol,
	      end_vcol = eff_right_vcol,
	      disp = disp,
	    })
	  end

  if #ranges == 0 then
    local cur = api.nvim_win_get_cursor(win)
    local line0 = (cur[1] or 1) - 1
    local col0 = cur[2] or 0
    return { { start = { line = line0, col = col0 }, ["end"] = { line = line0, col = col0 }, inclusive = false } }
  end

  return ranges
end

	local tail = (api.nvim_get_mode().mode or ""):sub(-1)
	return { tail = tail, ranges = get_selections(...) }
	`;

const SEARCH_HIGHLIGHT_LUA = `
local api, fn = vim.api, vim.fn

local function get_visible_range(s, e)
  s = tonumber(s) or 1
  e = tonumber(e) or s
  if e < s then s, e = e, s end
  if s < 1 then s = 1 end
  if e < 1 then e = 1 end
  return s, e
end

local function to_matches(buf, s, e, pat)
  local ok, re = pcall(vim.regex, pat)
  if not ok or not re then
    return {}, nil
  end
  local lines = api.nvim_buf_get_lines(buf, s - 1, e, false)
  local matches = {}
  local cur = api.nvim_win_get_cursor(0)
  local cur_lnum = cur[1] or 1
  local cur_col0 = cur[2] or 0
  local current = nil

  local max_total = 3000
  local max_per_line = 200

  for idx, line in ipairs(lines) do
    if #matches >= max_total then break end
    local lnum = (s + idx - 1)
    local start = 0
    local safety = 0
    while start <= #line and safety < max_per_line do
      safety = safety + 1
      local ms, me = re:match_str(line, start)
      if ms == nil or me == nil then break end
      if me <= ms then
        start = ms + 1
      else
        table.insert(matches, { l = lnum - 1, s = ms, e = me })
        if current == nil and lnum == cur_lnum and cur_col0 >= ms and cur_col0 < me then
          current = { l = lnum - 1, s = ms, e = me }
        end
        start = me
      end
    end
  end

  if current == nil then
    local pos = fn.searchpos(pat, "nW")
    local lnum = tonumber(pos[1] or 0) or 0
    local col = tonumber(pos[2] or 0) or 0
    if lnum > 0 and col > 0 then
      local line = api.nvim_buf_get_lines(buf, lnum - 1, lnum, false)[1] or ""
      local ms, me = re:match_str(line, col - 1)
      if ms ~= nil and me ~= nil and me > ms then
        current = { l = lnum - 1, s = ms, e = me }
      end
    end
  end

  return matches, current
end

local function run(...)
  local cmdtype = fn.getcmdtype() or ""
  local pat = ""
  if cmdtype == "/" or cmdtype == "?" then
    pat = fn.getcmdline() or ""
    if pat == "" then
      return { enabled = false, matches = {}, current = nil }
    end
  else
    if vim.v.hlsearch ~= 1 then
      return { enabled = false, matches = {}, current = nil }
    end
    pat = fn.getreg("/") or ""
    if pat == "" then
      return { enabled = false, matches = {}, current = nil }
    end
  end
  local s, e = get_visible_range(select(1, ...), select(2, ...))
  local buf = api.nvim_get_current_buf()
  local matches, current = to_matches(buf, s, e, pat)
  return { enabled = true, matches = matches, current = current, start = s, finish = e }
end

return run(...)
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
  private visualVirtualOverlayEl: HTMLDivElement | null = null;
  private visualVirtualRawRanges: any[] = [];
  private visualVirtualActive = false;
  private visualBgCss = "rgba(62, 68, 81, 0.45)";
  private monacoPrevOccurrencesHighlight: ("off" | "singleFile" | "multiFile") | null = null;
  private monacoPrevSelectionHighlight: boolean | null = null;
  private monacoPrevSelectionHighlightMultiline: boolean | null = null;
  private monacoHighlightsSuppressed = false;
  private cursorRefreshTimer: number | null = null;
  private cursorRefreshInFlight = false;
  private cursorRefreshPending = false;
  private disposables: monaco.IDisposable[] = [];
  private notifyChain: Promise<void> = Promise.resolve();
  private nvimChannelId: number | null = null;
  private hostAutocmdInstalled = false;
  private nvimScrolloff = 0;
  private ctrlKeysNormal: Set<string> | null = null;
  private ctrlKeysInsert: Set<string> | null = null;
  private altKeysNormal: Set<string> | null = null;
  private altKeysInsert: Set<string> | null = null;
  private metaKeysNormal: Set<string> | null = null;
  private metaKeysInsert: Set<string> | null = null;
  private searchDecorationIds: string[] = [];
  private searchStyleEl: HTMLStyleElement | null = null;
  private searchRefreshTimer: number | null = null;
  private searchRefreshInFlight = false;
  private searchRefreshPending = false;
  private execLuaAvailable: boolean | null = null;
  private visualSelectionRefreshTimer: number | null = null;
  private selectionSyncTimer: number | null = null;
  private pendingSelection: monaco.Selection | null = null;
  private lastCursorStyle: MonacoEditor.IStandaloneEditorConstructionOptions["cursorStyle"] | null = null;
  private lastCursorBlink: MonacoEditor.IStandaloneEditorConstructionOptions["cursorBlinking"] | null = null;
  private lastCursorWidth: number | null = null;
  private initialCursorWidth = 0;
  private typicalFullWidth = 2;
  private nextSeedLines: string[] | null = null;
  private cmdlineEl: HTMLDivElement | null = null;
  private cmdlineVisible = false;
  private cmdlineTextRaw: string | null = null;
  private cmdlineCursorByte: number | null = null;
  private cmdlineCursorOffsetBytes = 0;
  private cmdlineCursorContentBytes = 0;
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
  private pendingEscAfterComposition = false;
  private exitingInsertMode = false;
  private pendingKeysAfterExit = "";
  private exitInsertTimer: number | null = null;
  private dotRepeatKeys = "";
  private dotRepeatBackspaces = 0;
  private delegatedInsertReplayPossible = false;
  private recentNormalKeys = "";
  private lastDelegatedInsertPrefix: string | null = null;
  private lastDelegatedDotRepeat: { prefix: string; keys: string } | null = null;
  private ignoreInsertExitCursor: { line: number; col0: number; untilMs: number } | null = null;
  private ignoreMonacoCursorSyncToNvimUntil = 0;
  private ignoreTextKeydownUntil = 0;
  private lastImeCommitAt = 0;
  private lastImeCommitText = "";
  private recordingRegister = "";
  private recordingRefreshArmed = false;
  private recordingRefreshTimer: number | null = null;
  private optimisticCursorUntil = 0;
  private optimisticCursorPos: monaco.Position | null = null;
  private optimisticCursorPrevPos: monaco.Position | null = null;
  private delegateInsertToMonaco = false;
  private editorReadOnly: boolean | null = null;
  private applyingFromNvim = false;
  private buffers = new Map<number, BufferState>();
  private buffersByName = new Map<string, number>();
  private cursorSyncTimer: number | null = null;
  private ignoreSelectionSyncUntil = 0;
  private ignoreActiveBufLinesEventsUntil = 0;
  private modelContentDisposable: monaco.IDisposable | null = null;
  private originalOptions: Partial<MonacoEditor.IStandaloneEditorConstructionOptions> | null = null;
  private resyncTimer: number | null = null;

  private debugLog(line: string): void {
    if (!this.opts.debug) return;
    try {
      const msg = `[monaco-neovim-wasm] ${line}`;
      if (this.opts.debugLog) this.opts.debugLog(msg);
      else if (typeof console !== "undefined") console.log(msg);
    } catch (_) {
    }
  }

  private nowMs(): number {
    return (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  }

  private scheduleRecordingRefresh(): void {
    if (this.recordingRefreshTimer) return;
    this.recordingRefreshTimer = window.setTimeout(() => {
      this.recordingRefreshTimer = null;
      void this.refreshRecordingState();
    }, 0);
  }

  private async refreshRecordingState(): Promise<void> {
    if (!this.session || !this.session.isRunning()) return;
    try {
      const reg = await this.rpcCall("nvim_call_function", ["reg_recording", []]);
      this.recordingRegister = typeof reg === "string" ? reg : String(reg ?? "");
    } catch (_) {
    }
  }

  private sendCmdlineImeText(text: string): void {
    const payload = String(text ?? "");
    if (!payload) return;
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    if (payload.length > 1 && payload === this.lastImeCommitText && (now - this.lastImeCommitAt) < 60) return;
    this.lastImeCommitText = payload;
    this.lastImeCommitAt = now;
    this.sendInput(normalizeNvimInputText(payload, true));
  }

  constructor(editor: MonacoEditor.IStandaloneCodeEditor, options: MonacoNeovimOptions = {}) {
    this.editor = editor;
    const debugFromGlobal = (() => {
      try { return Boolean((globalThis as any)?.__MONACO_NEOVIM_WASM_DEBUG__); } catch (_) { return false; }
    })();
    const debugFromQuery = (() => {
      try {
        if (typeof location === "undefined" || !location?.search) return false;
        const qs = new URLSearchParams(location.search);
        return qs.has("monaco-neovim-wasm-debug") || qs.has("mnw_debug");
      } catch (_) {
        return false;
      }
    })();
    const debugAuto = debugFromGlobal || debugFromQuery;
    // Query/global debugging must be able to override an app's default `debug: false`
    // without requiring local code changes (useful for private playgrounds).
    const debug = debugAuto ? true : Boolean(options.debug);
    this.opts = {
      worker: options.worker ?? null,
      workerUrl: options.workerUrl ?? new URL("./nvimWorker.js", import.meta.url),
      reuseWorker: options.reuseWorker ?? false,
      wasmPath: options.wasmPath ?? "",
      runtimePath: options.runtimePath ?? "",
      inputMode: options.inputMode ?? "shared",
      env: options.env,
      files: options.files,
      sharedInputBytes: options.sharedInputBytes ?? DEFAULT_SHARED_INPUT_BYTES,
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      minCols: options.minCols ?? 20,
      minRows: options.minRows ?? 5,
      autoResize: options.autoResize ?? true,
      resizeDebounceMs: options.resizeDebounceMs ?? 50,
      syncWrap: options.syncWrap ?? true,
      wrapStrategy: options.wrapStrategy ?? "simple",
      syncTabstop: options.syncTabstop ?? true,
      wrappedLineMotions: options.wrappedLineMotions ?? true,
      scrollMotions: options.scrollMotions ?? true,
      scrolloff: Number.isFinite(options.scrolloff as any) ? Math.max(0, Number(options.scrolloff)) : undefined,
      syncScrolloff: options.syncScrolloff ?? true,
      ctrlKeysForNormalMode: options.ctrlKeysForNormalMode,
      ctrlKeysForInsertMode: options.ctrlKeysForInsertMode,
      altKeysForNormalMode: options.altKeysForNormalMode,
      altKeysForInsertMode: options.altKeysForInsertMode,
      metaKeysForNormalMode: options.metaKeysForNormalMode,
      metaKeysForInsertMode: options.metaKeysForInsertMode,
      searchHighlights: options.searchHighlights ?? true,
      hostCommands: options.hostCommands ?? Boolean(options.onHostCommand || options.fileSystem),
      fileSystem: options.fileSystem,
      onHostCommand: options.onHostCommand,
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
      insertSyncDebounceMs: Number.isFinite(options.insertSyncDebounceMs as any) ? Math.max(0, Number(options.insertSyncDebounceMs)) : 20,
      debug,
      debugLog: options.debugLog,
      shouldHandleKey: options.shouldHandleKey ?? (() => true),
      translateKey: options.translateKey ?? translateKey,
    };
    this.ctrlKeysNormal = this.opts.ctrlKeysForNormalMode ? new Set(this.opts.ctrlKeysForNormalMode.map((s) => String(s).toLowerCase())) : null;
    this.ctrlKeysInsert = this.opts.ctrlKeysForInsertMode ? new Set(this.opts.ctrlKeysForInsertMode.map((s) => String(s).toLowerCase())) : null;
    this.altKeysNormal = this.opts.altKeysForNormalMode ? new Set(this.opts.altKeysForNormalMode.map((s) => String(s).toLowerCase())) : null;
    this.altKeysInsert = this.opts.altKeysForInsertMode ? new Set(this.opts.altKeysForInsertMode.map((s) => String(s).toLowerCase())) : null;
    this.metaKeysNormal = this.opts.metaKeysForNormalMode ? new Set(this.opts.metaKeysForNormalMode.map((s) => String(s).toLowerCase())) : null;
    this.metaKeysInsert = this.opts.metaKeysForInsertMode ? new Set(this.opts.metaKeysForInsertMode.map((s) => String(s).toLowerCase())) : null;
    if (this.opts.debug) {
      this.opts.status?.(`[monaco-neovim-wasm] debug enabled`);
      this.debugLog("debug enabled");
    }
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
        onNotify: (method: string, params: unknown[]) => {
          this.notifyChain = this.notifyChain
            .then(() => this.handleNotify(method, params))
            .catch(() => {});
        },
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
          inputMode: this.opts.inputMode,
          sharedInputBytes: this.opts.sharedInputBytes,
          rpcTimeoutMs: this.opts.rpcTimeoutMs,
          reuseWorker: this.opts.reuseWorker,
          handlers,
        });
      } else {
        this.session.setHandlers(handlers);
      }

      if (!this.opts.wasmPath || !this.opts.runtimePath) {
        throw new Error("wasmPath/runtimePath is required (use @monaco-neovim-wasm/wasm or @monaco-neovim-wasm/wasm-async for defaults).");
      }
      await this.session.start({
        cols: this.uiCols,
        rows: this.uiRows,
        wasmPath: this.opts.wasmPath,
        runtimePath: this.opts.runtimePath,
        inputMode: this.opts.inputMode,
        env: this.opts.env,
        files: normalizeSessionFiles(mergeSessionFiles(
          this.opts.files,
          this.opts.wrappedLineMotions || this.opts.scrollMotions || this.opts.hostCommands
            ? [
              { path: "home/.config/nvim/monaco-neovim-wasm/motion.vim", data: motionOverridesVim },
              { path: "home/.config/nvim/monaco-neovim-wasm/scrolling.vim", data: scrollingOverridesVim },
              { path: "home/.config/nvim/monaco-neovim-wasm/host-commands.vim", data: hostCommandsOverridesVim },
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
    this.recordingRegister = "";
    this.recordingRefreshArmed = false;
    if (this.recordingRefreshTimer) {
      clearTimeout(this.recordingRefreshTimer);
      this.recordingRefreshTimer = null;
    }
    this.exitingInsertMode = false;
    this.pendingKeysAfterExit = "";
    if (this.exitInsertTimer) {
      clearTimeout(this.exitInsertTimer);
      this.exitInsertTimer = null;
    }
    this.applyingFromNvim = false;
    this.clearBufferStates();
    if (this.cursorSyncTimer) {
      clearTimeout(this.cursorSyncTimer);
      this.cursorSyncTimer = null;
    }
    this.nvimChannelId = null;
    this.hostAutocmdInstalled = false;
    this.notifyChain = Promise.resolve();
    if (this.visualSelectionRefreshTimer) {
      clearTimeout(this.visualSelectionRefreshTimer);
      this.visualSelectionRefreshTimer = null;
    }
    if (this.cursorRefreshTimer) {
      clearTimeout(this.cursorRefreshTimer);
      this.cursorRefreshTimer = null;
    }
    if (this.selectionSyncTimer) {
      clearTimeout(this.selectionSyncTimer);
      this.selectionSyncTimer = null;
    }
    this.pendingSelection = null;
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

  type(text: string, wrapEnter = true): void {
    const payload = normalizeNvimInputText(String(text ?? ""), wrapEnter);
    if (!payload) return;
    this.sendNotify("nvim_input", [payload]);
  }

  paste(text: string): void {
    this.pasteText(text);
  }

  async execLua<T = unknown>(code: string, args: unknown[] = []): Promise<T> {
    const source = String(code ?? "");
    const argv = Array.isArray(args) ? args : [];
    if (this.execLuaAvailable !== false) {
      try {
        const res = await this.rpcCall("nvim_exec_lua", [source, argv]) as T;
        this.execLuaAvailable = true;
        return res;
      } catch (err) {
        const msg = (err as { message?: string })?.message || String(err);
        if (msg.includes("Invalid method") && msg.includes("nvim_exec_lua")) {
          this.execLuaAvailable = false;
        } else {
          throw err;
        }
      }
    }
    const expr = `(function(...)\n${source}\nend)(unpack(_A))`;
    return this.rpcCall("nvim_call_function", ["luaeval", [expr, argv]]) as Promise<T>;
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

    // Default to read-only outside of insert-mode delegation. This prevents
    // Monaco's native edit context / beforeinput pipeline from applying edits
    // that slip past our event interception in normal/visual/operator modes.
    // Keep `domReadOnly` false so cmdline/search can still use IME/text events.
    this.setEditorReadOnly(!this.delegateInsertToMonaco);
    this.editor.updateOptions({ domReadOnly: false });
    if (this.opts.syncWrap) {
      const col = this.uiCols || this.opts.cols;
      if (col > 0) this.applyMonacoWrap(col);
    }

    this.attachActiveModelListener();

    this.disposables.push(
      this.editor.onDidChangeModel(() => this.handleActiveModelChanged()),
      this.editor.onKeyDown((ev) => this.handleKey(ev)),
      this.editor.onMouseDown((ev) => this.handleMouse(ev)),
      this.editor.onDidChangeCursorSelection((ev) => this.handleSelection(ev)),
      this.editor.onDidChangeCursorPosition((ev) => {
        const cur = this.editor.getPosition();
        if (cur) this.lastCursorPos = cur;
        if (this.delegateInsertToMonaco) {
          if (this.compositionActive) this.positionPreedit();
          this.scheduleCursorSyncToNvim();
          return;
        }
        if (this.nowMs() < this.ignoreMonacoCursorSyncToNvimUntil && ev.source !== "mouse") {
          return;
        }
        // During IME composition, Monaco moves its internal cursor/selection.
        // Don't fight it, otherwise the view can glitch until composition ends.
        if (this.compositionActive) {
          this.positionPreedit();
          return;
        }
        if (this.suppressCursorSync || !this.lastCursorPos) return;
        if (ev.source === "mouse") {
          // Keep Neovim's cursor in sync with mouse-driven Monaco cursor moves.
          // Relying solely on `onMouseDown` can miss cases where Monaco moves the
          // caret without a text-target position (e.g. clicking padding/whitespace),
          // which later manifests as a "cursor jump" when entering visual mode.
          const sel = this.editor.getSelection();
          if (sel && sel.isEmpty()) this.syncCursorToNvimNow(true);
          return;
        }
        if (ev.source === "keyboard") {
          this.suppressCursorSync = true;
          this.editor.setPosition(this.lastCursorPos);
          this.suppressCursorSync = false;
          return;
        }
      }),
      this.editor.onDidScrollChange(() => {
        if (!this.compositionActive) return;
        this.positionPreedit();
      }),
    );
    this.disposables.push(
      this.editor.onDidScrollChange(() => {
        if (!this.opts.searchHighlights) return;
        if (this.compositionActive) return;
        this.scheduleSearchHighlightRefresh();
      }),
    );
    this.disposables.push(
      this.editor.onDidScrollChange(() => {
        if (!this.visualVirtualActive) return;
        this.renderVisualVirtualOverlay();
      }),
      this.editor.onDidLayoutChange(() => {
        if (!this.visualVirtualActive) return;
        this.renderVisualVirtualOverlay();
      }),
      this.editor.onDidChangeConfiguration((e) => {
        if (!this.visualVirtualActive) return;
        if (
          e.hasChanged(EditorOption.fontInfo)
          || e.hasChanged(EditorOption.lineHeight)
          || e.hasChanged(EditorOption.fontSize)
          || e.hasChanged(EditorOption.fontFamily)
        ) {
          this.renderVisualVirtualOverlay();
        }
      }),
    );
    this.disposables.push(
      this.editor.onDidChangeConfiguration((e) => {
        // Some hosts update editor options after we attach. Ensure normal mode
        // stays read-only so typed characters can't mutate the model behind
        // Neovim's back (desync: Monaco shows text Neovim doesn't have).
        if (e.hasChanged(EditorOption.readOnly) && !this.delegateInsertToMonaco) {
          this.setEditorReadOnly(true);
        }
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

  private handleActiveModelChanged(): void {
    this.attachActiveModelListener();
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;
    const model = this.editor.getModel();
    if (!model) return;

    // If the host swaps Monaco models (e.g. file open), ensure Neovim stays in sync.
    // This prevents "inserted text not recognized by Neovim" desyncs when the
    // active model diverges from the buffer state we flush to.
    try {
      const uri = (model as any).uri as monaco.Uri | undefined;
      const scheme = uri?.scheme ?? "";
      const authority = uri?.authority ?? "";
      const path = uri?.path ?? "";
      if (scheme === "nvim" && authority === "buf") {
        const m = /^\/(\d+)$/.exec(path);
        const id = m ? Number(m[1]) : NaN;
        if (Number.isFinite(id) && id > 0) {
          this.bufHandle = id;
        }
      }
    } catch (_) {
    }

    const state = this.ensureActiveState();
    if (!state) return;
    if (state.model === model) return;

    this.debugLog(`active model changed: rebind buf=${this.bufHandle}`);
    state.model = model;
    state.createdModel = false;
    state.pendingBufEdits = [];
    state.pendingFullSync = false;
    state.pendingCursorSync = false;
    state.shadowLines = this.delegateInsertToMonaco ? (model.getLinesContent?.() ?? null) : null;

    try {
      // Treat the new model content as the new source of truth for the current buffer.
      // Neovim will emit nvim_buf_lines_event and we will re-render.
      const lines = model.getLinesContent?.() ?? model.getValue().split(/\r?\n/);
      this.sendNotify("nvim_buf_set_lines", [this.bufHandle, 0, -1, false, lines]);
      this.syncCursorToNvimNow(true);
    } catch (_) {
    }
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
    if (this.modelContentDisposable) {
      try { this.modelContentDisposable.dispose(); } catch (_) {}
      this.modelContentDisposable = null;
    }
    this.clearVisualDecorations();
    this.clearSearchHighlights();
    this.setMonacoHighlightsSuppressed(false);
    if (this.searchStyleEl) {
      try { this.searchStyleEl.remove(); } catch (_) {}
      this.searchStyleEl = null;
    }
    if (this.visualStyleEl) {
      try { this.visualStyleEl.remove(); } catch (_) {}
      this.visualStyleEl = null;
    }
    if (this.visualVirtualOverlayEl) {
      try { this.visualVirtualOverlayEl.remove(); } catch (_) {}
      this.visualVirtualOverlayEl = null;
    }
    this.visualVirtualRawRanges = [];
    this.visualVirtualActive = false;
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
    if (this.searchRefreshTimer) {
      clearTimeout(this.searchRefreshTimer);
      this.searchRefreshTimer = null;
    }
    this.searchRefreshInFlight = false;
    this.searchRefreshPending = false;
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.compositionActive = false;
    this.pendingResyncAfterComposition = false;
    this.delegateInsertToMonaco = false;
    this.applyingFromNvim = false;
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
    this.editorReadOnly = null;
  }

  private attachActiveModelListener(): void {
    if (this.modelContentDisposable) {
      try { this.modelContentDisposable.dispose(); } catch (_) {}
      this.modelContentDisposable = null;
    }
    const model = this.editor.getModel();
    if (!model) return;
    this.modelContentDisposable = model.onDidChangeContent((ev) => this.handleMonacoModelChange(ev));
  }

  private getActiveState(): BufferState | null {
    if (!this.bufHandle) return null;
    return this.buffers.get(this.bufHandle) ?? null;
  }

  private ensureActiveState(): BufferState | null {
    if (!this.bufHandle) return null;
    const model = this.editor.getModel();
    if (!model) return null;
    const existing = this.buffers.get(this.bufHandle);
    if (existing) {
      if (existing.model !== model) {
        existing.model = model;
        existing.createdModel = false;
      }
      return existing;
    }
    const state: BufferState = {
      id: this.bufHandle,
      name: "",
      filetype: "",
      model,
      createdModel: false,
      shadowLines: null,
      pendingBufEdits: [],
      pendingFullSync: false,
      pendingCursorSync: false,
    };
    this.buffers.set(state.id, state);
    return state;
  }

  private clearBufferStates(): void {
    for (const state of this.buffers.values()) {
      if (state.createdModel) {
        try { state.model.dispose(); } catch (_) {}
      }
    }
    this.buffers.clear();
    this.buffersByName.clear();
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
        try { await this.execLua(this.opts.startupLua, []); } catch (_) {}
      }
      const buf = await this.rpcCall("nvim_get_current_buf", []);
      const id = extractBufId(buf) ?? 1;
      this.bufHandle = id;
      const attached = await this.rpcCall("nvim_buf_attach", [id, true, {}]);
      if (attached !== true) throw new Error("nvim_buf_attach failed");
      this.ensureActiveState();
      if (this.opts.syncTabstop) this.syncTabstopFromMonaco();
      const lines = await this.rpcCall("nvim_buf_get_lines", [id, 0, -1, false]);
      this.applyBuffer(Array.isArray(lines) ? lines as string[] : [""]);
      const seeded = await this.seedBuffer(id, this.nextSeedLines);
      this.nextSeedLines = null;
      if (seeded && seeded.length) this.applyBuffer(seeded);
      try {
        const st = this.ensureActiveState();
        if (st) {
          const name = await this.rpcCall("nvim_buf_get_name", [id]);
          st.name = typeof name === "string" ? name : "";
          if (st.name) this.buffersByName.set(st.name, id);
          try {
            const ft = await this.rpcCall("nvim_buf_get_option", [id, "filetype"]);
            st.filetype = typeof ft === "string" ? ft : "";
          } catch (_) {
          }
        }
      } catch (_) {
      }
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
        if (!this.exitingInsertMode) this.syncCursorToNvimNow(true);
      }
      return;
    }
    if (method === "monaco_scroll") {
      const arg = params?.[0];
      if (arg && typeof arg === "object") {
        const moved = this.applyMonacoScroll(arg as Record<string, unknown>);
        if (moved && !this.exitingInsertMode) this.syncCursorToNvimNow(true);
      }
      return;
    }
    if (method === "monaco_reveal") {
      const arg = params?.[0];
      if (arg && typeof arg === "object") {
        const resetCursor = this.applyMonacoReveal(arg as Record<string, unknown>);
        if (resetCursor && !this.exitingInsertMode) this.syncCursorToNvimNow(true);
      }
      return;
    }
    if (method === "monaco_moveCursor") {
      const arg = params?.[0];
      if (arg && typeof arg === "object") {
        this.applyMonacoMoveCursor(arg as Record<string, unknown>);
        if (!this.exitingInsertMode) this.syncCursorToNvimNow(true);
      }
      return;
    }
    if (method === "monaco_scrolloff") {
      const v = Number(params?.[0]);
      if (Number.isFinite(v)) {
        this.nvimScrolloff = Math.max(0, Math.floor(v));
        this.applyScrolloff();
      }
      return;
    }
    if (method === "monaco_host_command") {
      const arg = params?.[0];
      if (arg && typeof arg === "object") {
        await this.handleHostCommand(arg as Record<string, unknown>);
      }
      return;
    }
    if (method === "monaco_buf_enter") {
      const arg = params?.[0];
      if (arg && typeof arg === "object") {
        await this.handleBufEnter(arg as Record<string, unknown>);
      }
      return;
    }
    if (method === "monaco_buf_delete") {
      const arg = params?.[0];
      if (arg && typeof arg === "object") {
        this.handleBufDelete(arg as Record<string, unknown>);
      }
      return;
    }
    if (method === "monaco_cursor") {
      const [ln, col0] = params;
      // If we explicitly synced the insert-mode cursor right before sending <Esc>,
      // Neovim can emit a late CursorMovedI event for that *insert* position after
      // it has already left insert mode. Ignoring it prevents the caret from
      // jumping forward by 1 column right after exiting insert.
      try {
        const g = this.ignoreInsertExitCursor;
        const now = this.nowMs();
        if (
          g
          && now < g.untilMs
          && !this.delegateInsertToMonaco
          && Number(ln) === g.line
          && Number(col0) === g.col0
          && g.col0 > 0
        ) {
          this.debugLog(`nvim->monaco cursor: ignore stale post-exit insert cursor ln=${Number(ln)} col0=${Number(col0)}`);
          return;
        }
        if (g && now >= g.untilMs) this.ignoreInsertExitCursor = null;
      } catch (_) {
      }
      const clamped = clampCursor(this.editor, Number(ln), Number(col0));
      this.debugLog(`nvim->monaco cursor: ln=${Number(ln)} col0=${Number(col0)} -> line=${clamped.line} col=${clamped.col} delegateInsert=${this.delegateInsertToMonaco} exitingInsert=${this.exitingInsertMode} mode=${JSON.stringify(this.lastMode)}`);
      // In insert-mode delegation, Monaco owns the caret; don't overwrite it.
      // While exiting insert mode we do want to accept Neovim cursor updates so
      // the UI doesn't "jump" when the mode change arrives slightly later.
      if (this.delegateInsertToMonaco && !this.exitingInsertMode) {
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
      if (!this.hostAutocmdInstalled) {
        // Some environments can have the host autocmd Lua installed even if the
        // initial installation call didn't resolve cleanly. Once we observe a
        // monaco_mode notify, treat it as authoritative and stop using `redraw`
        // mode_change to avoid mode flip-flop (normal/insert vs n/i).
        this.hostAutocmdInstalled = true;
      }
      this.debugLog(`nvim->monaco mode: ${JSON.stringify(this.lastMode)} -> ${JSON.stringify(m)}`);
      this.applyNvimMode(m);
      return;
    }
    if (method === "monaco_recording") {
      const reg = typeof params?.[0] === "string" ? String(params[0]) : "";
      this.recordingRegister = reg;
      return;
    }
    if (method === "nvim_buf_lines_event") {
      const [buf, _changedtick, firstline, lastline, linedata] = params;
      const id = extractBufId(buf);
      if (!id) return;
      const state = (this.bufHandle != null && id === this.bufHandle) ? this.ensureActiveState() : (this.buffers.get(id) ?? null);
      if (!state) return;
      if (this.bufHandle != null && id === this.bufHandle && this.delegateInsertToMonaco && !this.exitingInsertMode) {
        // During insert-mode delegation, Monaco is the source of truth for the
        // document. Neovim will echo our Monaco->Neovim changes back via
        // nvim_buf_lines_event; applying them can create feedback loops and
        // corrupt the model when patches are computed on partially-updated state.
        // Ignore the echo window right after we flush Monaco edits to Neovim.
        if (this.nowMs() < this.ignoreActiveBufLinesEventsUntil) return;
      }
      if (this.bufHandle != null && id === this.bufHandle && this.compositionActive) {
        // Don't mutate the Monaco model during IME composition; it can cause the
        // IME rendering/caret to glitch. We'll resync after composition ends.
        this.pendingResyncAfterComposition = true;
        return;
      }

      const model = state.model;
      const fl = Number(firstline);
      const ll = Number(lastline);
      const newLines = Array.isArray(linedata) ? (linedata as unknown[]).map((l) => String(l ?? "")) : null;
      const canPatch = model && Number.isInteger(fl) && Number.isInteger(ll) && fl >= 0 && ll >= fl && newLines;
      if (canPatch) {
        try {
          const isActiveModel = this.bufHandle != null && id === this.bufHandle && this.editor.getModel() === model;
          if (isActiveModel && this.delegateInsertToMonaco) {
            const patch = this.computeLinePatch(model!, fl, ll, newLines!);
            let isNoop = false;
            try { isNoop = model!.getValueInRange(patch.range) === patch.text; } catch (_) {}
            if (!isNoop) {
              if (state.pendingFullSync || state.pendingBufEdits.length) {
                // We're in the middle of applying Monaco->Neovim edits; applying
                // Neovim line events now can race with our pending patches.
                // Instead, resync the active buffer shortly.
                this.scheduleResync();
                return;
              }
              this.applyLinePatchToModel(model!, fl, ll, newLines!);
              try { state.shadowLines = model!.getLinesContent(); } catch (_) {}
            }
          } else if (isActiveModel) {
            this.applyLinePatch(model!, fl, ll, newLines!);
          } else {
            this.applyLinePatchToModel(model!, fl, ll, newLines!);
          }
        } catch (_) {
        }
      } else {
        try {
          const allLines = await this.rpcCall("nvim_buf_get_lines", [id, 0, -1, false]);
          const lines = Array.isArray(allLines) ? (allLines as string[]) : [""];
          if (this.bufHandle != null && id === this.bufHandle && this.editor.getModel() === model) {
            this.applyBuffer(lines);
          } else {
            this.setModelText(model!, lines);
          }
        } catch (_) {
        }
      }
      if (this.bufHandle != null && id === this.bufHandle && isVisualMode(this.lastMode)) this.scheduleVisualSelectionRefresh();
    } else if (method === "nvim_buf_detach_event") {
      const id = extractBufId(params?.[0]);
      if (id && this.buffers.has(id)) {
        const state = this.buffers.get(id)!;
        if (state.name) this.buffersByName.delete(state.name);
        if (state.createdModel) {
          try { state.model.dispose(); } catch (_) {}
        }
        this.buffers.delete(id);
      }
      if (id && this.bufHandle === id) {
        this.bufHandle = null;
      }
    } else if (method === "redraw") {
      this.handleRedraw(params);
    }
  }

  private computeLinePatch(
    model: monaco.editor.ITextModel,
    firstline: number,
    lastline: number,
    newLines: string[],
  ): { range: monaco.Range; text: string } {
    const oldLineCount = model.getLineCount();
    const fl = Math.min(firstline, oldLineCount);
    const ll = Math.min(lastline, oldLineCount);

    const eof = new monaco.Position(oldLineCount, model.getLineMaxColumn(oldLineCount));
    const deletingToEof = ll >= oldLineCount && newLines.length === 0;
    const startPos = (deletingToEof && fl > 0)
      ? new monaco.Position(fl, model.getLineMaxColumn(fl))
      : (fl < oldLineCount ? new monaco.Position(fl + 1, 1) : eof);
    const endPos = ll < oldLineCount ? new monaco.Position(ll + 1, 1) : eof;

    let text = newLines.join("\n");
    const insertingAtEof = firstline >= oldLineCount && lastline >= oldLineCount;
    if (insertingAtEof && newLines.length > 0) text = `\n${text}`;
    const hasFollowingLine = lastline < oldLineCount;
    if (hasFollowingLine && newLines.length > 0) text += "\n";

    const range = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
    return { range, text };
  }

  private applyLinePatch(model: monaco.editor.ITextModel, firstline: number, lastline: number, newLines: string[]): void {
    const pos = this.lastCursorPos ?? this.editor.getPosition() ?? new monaco.Position(1, 1);
    const patch = this.computeLinePatch(model, firstline, lastline, newLines);
    try {
      const existing = model.getValueInRange(patch.range);
      if (existing === patch.text) return;
    } catch (_) {
    }

    this.suppressCursorSync = true;
    this.applyingFromNvim = true;
    model.applyEdits([{ range: patch.range, text: patch.text }]);
    this.applyingFromNvim = false;
    if (pos) this.editor.setPosition(pos);
    this.suppressCursorSync = false;

    if (this.delegateInsertToMonaco) {
      const state = this.getActiveState();
      if (state && state.model === model) {
        // Keep our shadow in sync if Neovim changed the active buffer while delegating.
        try { state.shadowLines = model.getLinesContent(); } catch (_) {}
      }
    }
  }

  private applyLinePatchToModel(model: monaco.editor.ITextModel, firstline: number, lastline: number, newLines: string[]): void {
    const patch = this.computeLinePatch(model, firstline, lastline, newLines);
    try {
      const existing = model.getValueInRange(patch.range);
      if (existing === patch.text) return;
    } catch (_) {
    }

    this.applyingFromNvim = true;
    try { model.applyEdits([{ range: patch.range, text: patch.text }]); } catch (_) {}
    this.applyingFromNvim = false;
  }

  private setModelText(model: monaco.editor.ITextModel, lines: string[]): void {
    const joined = (lines && lines.length ? lines : [""]).join("\n");
    try {
      if (model.getValue() === joined) return;
    } catch (_) {
    }
    this.applyingFromNvim = true;
    try { model.setValue(joined); } catch (_) {}
    this.applyingFromNvim = false;
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
    this.cmdlineTextRaw = text;
    this.cmdlineCursorByte = null;
    this.cmdlineCursorOffsetBytes = 0;
    this.cmdlineCursorContentBytes = 0;
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

  private setCmdlineCursor(bytePos: number | null): void {
    if (!this.cmdlineEl || !this.cmdlineVisible) return;
    if (!this.cmdlineTextRaw) return;
    if (bytePos == null || !Number.isFinite(bytePos)) {
      this.cmdlineEl.textContent = this.cmdlineTextRaw;
      this.cmdlineCursorByte = null;
      return;
    }
    const text = this.cmdlineTextRaw;
    const clampedByte = Math.max(0, Math.min(Number(bytePos) || 0, utf8StringByteLength(text)));
    const idx = Math.max(0, Math.min(text.length, byteIndexToCharIndex(text, clampedByte)));
    this.cmdlineCursorByte = clampedByte;
    this.cmdlineEl.textContent = `${text.slice(0, idx)}▏${text.slice(idx)}`;
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
    if (pos) {
      this.lastCursorPos = pos;
      this.applyScrolloff(pos);
    }
    this.suppressCursorSync = false;
    this.scheduleSearchHighlightRefresh();
  }

  private getScrolloffLines(): number {
    if (this.opts.scrolloff != null) return Math.max(0, Math.floor(this.opts.scrolloff));
    if (!this.opts.syncScrolloff) return 0;
    return Math.max(0, Math.floor(this.nvimScrolloff));
  }

  private applyScrolloff(pos?: monaco.Position | null): boolean {
    if (this.compositionActive) return false;
    if (this.delegateInsertToMonaco) return false;
    const so = this.getScrolloffLines();
    if (so <= 0) return false;

    const p = pos ?? this.editor.getPosition();
    if (!p) return false;

    const lineHeight = Math.max(1, Number(this.editor.getOption(monaco.editor.EditorOption.lineHeight) as any) || 0);
    const soPx = so * lineHeight;
    if (soPx <= 0) return false;

    let layoutHeight = 0;
    try {
      const layout = this.editor.getLayoutInfo() as any;
      layoutHeight = Math.max(0, Number(layout?.contentHeight ?? layout?.height ?? 0) || 0);
    } catch (_) {
    }
    if (layoutHeight <= 0) return false;

    const ensureVisible = () => {
      try { this.editor.revealPositionInCenterIfOutsideViewport(p); } catch (_) {}
    };

    let sp: { top: number; height: number } | null = null;
    try { sp = this.editor.getScrolledVisiblePosition(p) as any; } catch (_) {}
    if (!sp) {
      ensureVisible();
      try { sp = this.editor.getScrolledVisiblePosition(p) as any; } catch (_) {}
    }
    if (!sp || !Number.isFinite(sp.top) || !Number.isFinite(sp.height)) return false;

    const scrollTop = this.editor.getScrollTop();
    const cursorTop = sp.top;
    const cursorBottom = sp.top + sp.height;
    const minBottom = Math.max(0, layoutHeight - soPx);

    let delta = 0;
    if (cursorTop < soPx) {
      delta = cursorTop - soPx;
    } else if (cursorBottom > minBottom) {
      delta = cursorBottom - minBottom;
    }
    if (!delta) return false;

    try { this.editor.setScrollTop(Math.max(0, scrollTop + delta)); } catch (_) {}
    return true;
  }

  private applyMonacoScroll(arg: Record<string, unknown>): boolean {
    const by = typeof arg.by === "string" ? arg.by : "";
    const direction = typeof arg.direction === "string" ? arg.direction : "";
    const value = Math.max(1, Number(arg.value ?? 1) || 1);
    const moveCursor = Boolean(arg.moveCursor);
    const cursorBy = typeof arg.cursorBy === "string" ? arg.cursorBy : "wrappedLine";

    const rows = Math.max(3, this.uiRows || this.opts.rows);
    const fontInfo = this.editor.getOption(monaco.editor.EditorOption.fontInfo) as any;
    const lineHeight = Math.max(1, Number(fontInfo?.lineHeight ?? 0) || 0);

    const pageLines = Math.max(1, rows - 2);
    const halfPageLines = Math.max(1, Math.floor(pageLines / 2));

    let deltaLines = value;
    if (by === "page") deltaLines = pageLines * value;
    else if (by === "halfPage") deltaLines = halfPageLines * value;
    else if (by === "line") deltaLines = value;
    else return false;

    const sign = direction === "up" ? -1 : direction === "down" ? 1 : 0;
    if (!sign) return false;

    this.suppressCursorSync = true;
    try {
      const top = this.editor.getScrollTop();
      const next = Math.max(0, top + sign * deltaLines * lineHeight);
      this.editor.setScrollTop(next);
    } catch (_) {
    }

    let moved = false;
    if (moveCursor) {
      try {
        this.applyMonacoCursorMove({
          to: sign > 0 ? "down" : "up",
          by: cursorBy,
          value: deltaLines,
        });
        moved = true;
      } catch (_) {
      }
    }

    this.suppressCursorSync = false;
    return moved;
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
    const value = Math.max(1, Number(arg.value ?? 1) || 1);

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
      targetLine = top + (value - 1);
    } else if (to === "middle") {
      targetLine = Math.floor((top + bottom) / 2);
    } else if (to === "bottom") {
      targetLine = bottom - (value - 1);
    } else {
      return;
    }
    targetLine = Math.max(top, Math.min(bottom, targetLine));

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
        this.scheduleSearchHighlightRefresh();
        continue;
      }
      if (name === "cmdline_show") {
        const content = args[0];
        const pos = Math.max(0, Number(args[1] ?? 0) || 0);
        const firstc = typeof args[2] === "string" ? args[2] : "";
        const prompt = typeof args[3] === "string" ? args[3] : "";
        const indent = Math.max(0, Number(args[4] ?? 0) || 0);
        const prefix = prompt ? prompt : (firstc || "");
        const indentText = " ".repeat(indent);
        const contentText = uiChunksToText(content);
        const text = `${indentText}${prefix}${contentText}`;
        this.setCmdline(text);
        // `pos` is in bytes; depending on the UI provider it may be relative to
        // the typed content only, so adjust if it looks like that case.
        const prefixBytes = utf8StringByteLength(`${indentText}${prefix}`);
        const contentBytes = utf8StringByteLength(contentText);
        this.cmdlineCursorOffsetBytes = prefixBytes;
        this.cmdlineCursorContentBytes = contentBytes;
        const cursorByte = pos <= contentBytes ? (this.cmdlineCursorOffsetBytes + pos) : pos;
        this.setCmdlineCursor(cursorByte);
        this.scheduleSearchHighlightRefresh();
        continue;
      }
      if (name === "cmdline_pos") {
        const pos = Math.max(0, Number(args[0] ?? 0) || 0);
        const cursorByte = (this.cmdlineCursorOffsetBytes > 0 && pos <= this.cmdlineCursorContentBytes)
          ? (this.cmdlineCursorOffsetBytes + pos)
          : pos;
        this.setCmdlineCursor(cursorByte);
        this.scheduleSearchHighlightRefresh();
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
        // `redraw` mode_change reports coarse, UI-oriented strings (e.g. "insert")
        // that can disagree with `nvim_get_mode()` (e.g. replace / operator-pending
        // states). We rely on `monaco_mode` (autocmd via nvim_get_mode()) for
        // correctness and only fall back to mode_change before those autocmds
        // are installed.
        if (!this.hostAutocmdInstalled) this.applyNvimMode(mode);
        continue;
      }
    }
  }

  private initTextInputListeners(): void {
    const root = this.editor.getDomNode();
    if (!root) return;
    const ownerDoc = root.ownerDocument || document;
    const view: EventTarget = ownerDoc.defaultView || window;

    const nowMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

    const stopAll = (e: Event) => {
      try { (e as any).stopImmediatePropagation?.(); } catch (_) {}
      try { e.stopPropagation(); } catch (_) {}
    };

    const isEditorEvent = (e: Event): boolean => {
      try {
        const hasTextFocus = typeof (this.editor as any).hasTextFocus === "function"
          ? Boolean((this.editor as any).hasTextFocus())
          : false;
        if (hasTextFocus) return true;
        const target = e.target as Node | null;
        if (target && root.contains(target)) return true;
        const active = ownerDoc.activeElement as Node | null;
        return Boolean(active && root.contains(active));
      } catch (_) {
        return false;
      }
    };

    const asMaybeInputTarget = (target: EventTarget | null): HTMLElement | null => {
      try {
        const el = target as HTMLElement | null;
        if (!el || typeof (el as any).tagName !== "string") return null;
        return el;
      } catch (_) {
        return null;
      }
    };

    const onKeydownCapture = (e: KeyboardEvent) => {
      if (!isEditorEvent(e)) return;
      if (this.compositionActive || e.isComposing) return;
      if (e.getModifierState?.("AltGraph")) return;

      const insertMode = this.delegateInsertToMonaco && !this.exitingInsertMode;
      if (insertMode) {
        // Escape must reliably exit insert mode even when Monaco keydown
        // handling is bypassed by the native edit context / browser.
        if (e.key === "Escape") {
          if (!this.opts.shouldHandleKey(e)) return;
          stopAll(e);
          try { e.preventDefault(); } catch (_) {}
          if (this.compositionActive || e.isComposing) {
            this.pendingEscAfterComposition = true;
            return;
          }
          this.exitDelegatedInsertMode("<Esc>");
          return;
        }
        // If the user navigates or performs non-trivial edits while delegating,
        // we can't safely replay them as Neovim input for dot-repeat.
        const k = e.key;
        if (
          k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown"
          || k === "Home" || k === "End"
          || k === "PageUp" || k === "PageDown"
          || k === "Tab"
          || k === "Enter"
        ) {
          this.delegatedInsertReplayPossible = false;
        }
      }
      if (
        !insertMode
        && (e.key === "Backspace" || e.key === "Delete" || e.key === "Escape")
      ) {
        if (!this.opts.shouldHandleKey(e)) return;
        const key = this.opts.translateKey(e);
        if (!key) return;
        // Preempt Monaco edits/selection handling and forward to Neovim.
        stopAll(e);
        try { e.preventDefault(); } catch (_) {}
        // While we're already in the middle of exiting delegated insert mode, an
        // additional physical <Esc> shouldn't enqueue another <Esc>.
        if (this.exitingInsertMode && key === "<Esc>") return;
        if (this.exitingInsertMode) {
          this.pendingKeysAfterExit += key;
        } else {
          this.sendInput(key);
        }
        return;
      }

      if (
        isCmdlineLike(this.lastMode)
        && !this.delegateInsertToMonaco
        && !this.exitingInsertMode
        && !e.ctrlKey
        && !e.metaKey
        && (typeof e.key === "string" && e.key.length === 1)
      ) {
        const asciiPrintable = /^[\x20-\x7E]$/.test(e.key);
        const treatAsAltChord = Boolean(e.altKey && asciiPrintable);
        if (!treatAsAltChord) {
          if (!this.opts.shouldHandleKey(e)) return;
          // Prevent Monaco keybindings from swallowing plain printable characters
          // in cmdline/search modes; rely on `input`/IME events for text.
          stopAll(e);
          return;
        }
      }

      if (!e.ctrlKey && !e.altKey && !e.metaKey) return;
      const name = this.modifiedKeyName(e);
      if (!name) return;
      if (!this.opts.shouldHandleKey(e)) return;

      if (this.hasExplicitModAllowlist(insertMode)) {
        if (!this.shouldForwardModifiedKeys(e, insertMode)) return;
      } else {
        // Legacy behavior: only preempt the common scroll keys (plus <C-v> for visual block)
        // in normal/visual/operator modes.
        if (insertMode) return;
        if (!e.ctrlKey || e.altKey || e.metaKey) return;
        if (name !== "f" && name !== "b" && name !== "d" && name !== "u" && name !== "e" && name !== "y" && name !== "v") return;
      }

      const key = this.opts.translateKey(e);
      if (!key) return;
      // Preempt Monaco keybindings (e.g. Ctrl+F find) and forward to Neovim.
      stopAll(e);
      try { e.preventDefault(); } catch (_) {}
      if (this.exitingInsertMode) {
        this.debugLog(`keydown(capture) buffer: key=${JSON.stringify(e.key)} code=${JSON.stringify(e.code)} mods=${e.ctrlKey ? "C" : ""}${e.altKey ? "A" : ""}${e.metaKey ? "D" : ""}${e.shiftKey ? "S" : ""} -> ${key}`);
        this.pendingKeysAfterExit += key;
      } else {
        if (insertMode && (key === "<C-[>" || key === "<C-c>")) {
          this.debugLog(`keydown(capture) exit insert: key=${JSON.stringify(e.key)} code=${JSON.stringify(e.code)} mods=${e.ctrlKey ? "C" : ""}${e.altKey ? "A" : ""}${e.metaKey ? "D" : ""}${e.shiftKey ? "S" : ""} -> ${key}`);
          this.exitDelegatedInsertMode(key);
        } else {
          if (insertMode) this.flushPendingMonacoSync();
          this.debugLog(`keydown(capture) send: key=${JSON.stringify(e.key)} code=${JSON.stringify(e.code)} mods=${e.ctrlKey ? "C" : ""}${e.altKey ? "A" : ""}${e.metaKey ? "D" : ""}${e.shiftKey ? "S" : ""} -> ${key}`);
          this.sendInput(key);
        }
      }
    };

    const onCompositionStart = (e: CompositionEvent) => {
      if (!isEditorEvent(e)) return;
      this.compositionActive = true;
      this.debugLog(`compositionstart delegateInsert=${this.delegateInsertToMonaco} mode=${JSON.stringify(this.lastMode)}`);
      if (this.delegateInsertToMonaco) {
        this.setPreedit(null);
        return;
      }
      this.setPreedit("");
    };
    const onCompositionEnd = (e: CompositionEvent) => {
      if (!isEditorEvent(e)) return;
      this.compositionActive = false;
      this.setPreedit(null);
      this.debugLog(`compositionend delegateInsert=${this.delegateInsertToMonaco} mode=${JSON.stringify(this.lastMode)} data=${JSON.stringify((e as any).data ?? "")}`);
      if (this.delegateInsertToMonaco) {
        if (this.pendingEscAfterComposition) {
          this.pendingEscAfterComposition = false;
          this.exitDelegatedInsertMode("<Esc>");
          return;
        }
        // Avoid late cursor syncs when we are in the middle of exiting insert mode.
        if (!this.exitingInsertMode) this.scheduleCursorSyncToNvim();
        return;
      }
      const target = asMaybeInputTarget(e.target);
      if (isCmdlineLike(this.lastMode)) {
        // Command-line/search mode relies on IME/text input events, not keydown.
        const data = typeof e.data === "string" ? e.data : "";
        const fallback = (!data && target && (target as any).tagName === "TEXTAREA" && (target as HTMLTextAreaElement).value)
          ? String((target as HTMLTextAreaElement).value)
        : (!data && target?.textContent ? String(target.textContent) : "");
        const commit = data || fallback;
        if (commit) this.sendCmdlineImeText(commit);
      }
      try {
        if (target && (target as any).tagName === "TEXTAREA") (target as HTMLTextAreaElement).value = "";
        else if (target) target.textContent = "";
      } catch (_) {}
      if (this.pendingResyncAfterComposition) {
        this.pendingResyncAfterComposition = false;
        this.scheduleResync();
      }
    };
    const onCompositionUpdate = (e: CompositionEvent) => {
      if (!isEditorEvent(e)) return;
      if (!this.compositionActive) this.compositionActive = true;
      if (this.delegateInsertToMonaco) return;
      const target = asMaybeInputTarget(e.target);
      const data = typeof e.data === "string" ? e.data : (
        (target && (target as any).tagName === "TEXTAREA" && (target as HTMLTextAreaElement).value)
          ? String((target as HTMLTextAreaElement).value)
          : (target?.textContent ? String(target.textContent) : "")
      );
      this.setPreedit(data || "");
    };
    const onBeforeInput = (e: Event) => {
      if (!isEditorEvent(e)) return;
      if (this.delegateInsertToMonaco && !this.exitingInsertMode) return;
      const target = asMaybeInputTarget(e.target);
      // Prevent Monaco from turning IME/text input events into model edits; Neovim
      // remains the source of truth and we re-render from nvim_buf_lines_event.
      stopAll(e);
      try { (e as InputEvent).preventDefault?.(); } catch (_) {}

      // Monaco >=0.55 can deliver cmdline typing via `beforeinput` (native edit context)
      // instead of `input` (textarea). Handle text commits here so cmdline/search works.
      if (isCmdlineLike(this.lastMode) && !this.compositionActive) {
        const ie = e as InputEvent;
        const data = typeof ie.data === "string" ? ie.data : "";
        const inputType = typeof (ie as any).inputType === "string" ? String((ie as any).inputType) : "";
        const composing = Boolean((ie as any).isComposing);
        if (!composing && !inputType.includes("Composition") && data) {
          this.sendCmdlineImeText(data);
        }
      }
    };
    const onInput = (e: Event) => {
      if (!isEditorEvent(e)) return;
      if (this.delegateInsertToMonaco && !this.exitingInsertMode) return;
      const target = asMaybeInputTarget((e as InputEvent).target);
      stopAll(e);
      const ie = e as InputEvent;

      if (this.ignoreNextInputEvent) {
        this.ignoreNextInputEvent = false;
        try {
          if ((target as any)?.tagName === "TEXTAREA") (target as HTMLTextAreaElement).value = "";
          else if (target) target.textContent = "";
        } catch (_) {}
        return;
      }
      if (this.compositionActive) return;

      if (isCmdlineLike(this.lastMode)) {
        const data = typeof ie.data === "string" ? ie.data : "";
        const fallback = (!data && (target as any)?.tagName === "TEXTAREA" && (target as HTMLTextAreaElement).value)
          ? String((target as HTMLTextAreaElement).value)
          : (!data && target?.textContent ? String(target.textContent) : "");
        const commit = data || fallback;
        if (commit) this.sendCmdlineImeText(commit);
      }
      try {
        if ((target as any)?.tagName === "TEXTAREA") (target as HTMLTextAreaElement).value = "";
        else if (target) target.textContent = "";
      } catch (_) {}
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!isEditorEvent(e)) return;
      if (this.delegateInsertToMonaco && !this.exitingInsertMode) return;
      const target = asMaybeInputTarget(e.target);
      stopAll(e);
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text) {
        e.preventDefault();
        this.ignoreNextInputEvent = true;
        this.pasteText(text);
      }
      try {
        if ((target as any)?.tagName === "TEXTAREA") (target as HTMLTextAreaElement).value = "";
        else if (target) target.textContent = "";
      } catch (_) {}
    };

    this.disposables.push(
      // Capture phase to ensure we see events even if Monaco stops propagation.
      domListener(view, "keydown", onKeydownCapture, true),
      domListener(view, "beforeinput", onBeforeInput, true),
      domListener(view, "input", onInput, true),
      domListener(view, "paste", onPaste, true),
      domListener(view, "compositionstart", onCompositionStart, true),
      domListener(view, "compositionupdate", onCompositionUpdate, true),
      domListener(view, "compositionend", onCompositionEnd, true),
    );
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
      const state = this.getActiveState();
      if (state && state.model === model) {
        try { state.shadowLines = model.getLinesContent(); } catch (_) {}
      }
    }
  }

  private ensureVisualStyle(): void {
    if (!this.visualStyleEl) {
      const el = document.createElement("style");
      el.id = "monaco-neovim-wasm-visual-style";
      el.textContent = `
.monaco-neovim-visual-line {
  background-color: ${this.visualBgCss};
}
.monaco-neovim-visual-inline {
  background-color: ${this.visualBgCss};
}
.monaco-neovim-visual-virtual {
  position: absolute;
  background-color: ${this.visualBgCss};
  pointer-events: none;
}
`;
      document.head.appendChild(el);
      this.visualStyleEl = el;
    }
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
.monaco-neovim-visual-virtual {
  position: absolute;
  background-color: ${this.visualBgCss};
  pointer-events: none;
}
`;
    }
  }

  private ensureVisualVirtualOverlay(): HTMLDivElement | null {
    if (this.visualVirtualOverlayEl && this.visualVirtualOverlayEl.isConnected) return this.visualVirtualOverlayEl;
    const root = this.editor.getDomNode();
    if (!root) return null;
    const host =
      (root.querySelector(".lines-content .view-overlays") as HTMLElement | null)
      ?? (root.querySelector(".view-overlays") as HTMLElement | null)
      ?? root;
    const el = document.createElement("div");
    el.id = "monaco-neovim-wasm-visual-virtual-overlay";
    el.style.position = "absolute";
    el.style.left = "0";
    el.style.top = "0";
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.pointerEvents = "none";
    // Attach under Monaco's overlay layer so the highlight doesn't visually
    // "wash out" foreground text (closer to VS Code / Monaco selection).
    host.appendChild(el);
    this.visualVirtualOverlayEl = el;
    return el;
  }

  private clearVisualVirtualOverlay(): void {
    this.visualVirtualActive = false;
    this.visualVirtualRawRanges = [];
    if (this.visualVirtualOverlayEl) {
      try { this.visualVirtualOverlayEl.replaceChildren(); } catch (_) {}
    }
  }

  private renderVisualVirtualOverlay(): void {
    if (!this.visualVirtualActive) return;
    const overlay = this.ensureVisualVirtualOverlay();
    if (!overlay) return;
    const model = this.editor.getModel();
    if (!model) {
      try { overlay.replaceChildren(); } catch (_) {}
      return;
    }
    const root = this.editor.getDomNode();
    let offsetX = 0;
    let offsetY = 0;
    if (root && overlay !== root) {
      try {
        const rootRect = root.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        offsetX = Number.isFinite(overlayRect.left - rootRect.left) ? (overlayRect.left - rootRect.left) : 0;
        offsetY = Number.isFinite(overlayRect.top - rootRect.top) ? (overlayRect.top - rootRect.top) : 0;
      } catch (_) {
      }
    }
    const rawRanges = Array.isArray(this.visualVirtualRawRanges) ? this.visualVirtualRawRanges : [];
    if (rawRanges.length === 0) {
      try { overlay.replaceChildren(); } catch (_) {}
      return;
    }

    const fontInfo = this.editor.getOption(monaco.editor.EditorOption.fontInfo) as any;
    const charWidth = Math.max(1, Number(fontInfo?.typicalHalfwidthCharacterWidth ?? fontInfo?.maxDigitWidth ?? 0) || 0);

    const frag = document.createDocumentFragment();
    for (const r of rawRanges) {
      const l0 = Number(r?.start?.line);
      const startVcol = Number(r?.start_vcol);
      const endVcol = Number(r?.end_vcol);
      const disp = Number(r?.disp);
      if (!Number.isFinite(l0)
        || !Number.isFinite(startVcol)
        || !Number.isFinite(endVcol)
        || !Number.isFinite(disp)) continue;
      const lineNumber = l0 + 1;
      if (lineNumber < 1 || lineNumber > model.getLineCount()) continue;

      const leftVcol = Math.min(startVcol, endVcol);
      const rightVcol = Math.max(startVcol, endVcol);

      const visCol1 = this.editor.getScrolledVisiblePosition(new monaco.Position(lineNumber, 1));
      if (!visCol1) continue;

      const widthCols = rightVcol - leftVcol + 1;
      if (widthCols <= 0) continue;
      const xStart = visCol1.left + Math.max(0, leftVcol - 1) * charWidth;
      const w = widthCols * charWidth;
      if (!Number.isFinite(w) || w <= 0) continue;

      const el = document.createElement("div");
      el.className = "monaco-neovim-visual-virtual";
      // If the overlay container isn't the editor root (e.g. attached under
      // Monaco's `.view-overlays`), adjust for its coordinate origin.
      el.style.left = `${Math.max(0, xStart - offsetX)}px`;
      el.style.top = `${Math.max(0, visCol1.top - offsetY)}px`;
      el.style.width = `${w}px`;
      el.style.height = `${Math.max(0, visCol1.height)}px`;
      frag.appendChild(el);
    }
    try { overlay.replaceChildren(frag); } catch (_) {}
  }

  private clearVisualDecorations(): void {
    this.clearVisualVirtualOverlay();
    if (!this.visualDecorationIds.length) {
      this.visualSelectionActive = false;
      return;
    }
    try {
      this.visualDecorationIds = this.editor.deltaDecorations(this.visualDecorationIds, []);
    } catch (_) {
      this.visualDecorationIds = [];
    }
    this.visualSelectionActive = false;
  }

  private ensureSearchStyle(): void {
    if (this.searchStyleEl) return;
    const el = document.createElement("style");
    el.id = "monaco-neovim-wasm-search-style";
    el.textContent = `
.monaco-neovim-search-match {
  background-color: rgba(255, 210, 77, 0.22);
}
.monaco-neovim-search-current {
  background-color: rgba(255, 210, 77, 0.45);
}
`;
    document.head.appendChild(el);
    this.searchStyleEl = el;
  }

  private clearSearchHighlights(): void {
    if (!this.searchDecorationIds.length) return;
    try {
      this.searchDecorationIds = this.editor.deltaDecorations(this.searchDecorationIds, []);
    } catch (_) {
      this.searchDecorationIds = [];
    }
  }

  private scheduleSearchHighlightRefresh(): void {
    if (!this.opts.searchHighlights) return;
    if (this.searchRefreshTimer) return;
    this.searchRefreshTimer = window.setTimeout(() => {
      this.searchRefreshTimer = null;
      void this.refreshSearchHighlights();
    }, 60);
  }

  private async refreshSearchHighlights(): Promise<void> {
    if (!this.opts.searchHighlights) return;
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;
    const model = this.editor.getModel();
    if (!model) return;
    if (this.searchRefreshInFlight) {
      this.searchRefreshPending = true;
      return;
    }
    this.searchRefreshInFlight = true;
    try {
      let start = 1;
      let end = model.getLineCount();
      try {
        const ranges = this.editor.getVisibleRanges();
        if (ranges && ranges.length) {
          start = Math.min(...ranges.map((r) => r.startLineNumber));
          end = Math.max(...ranges.map((r) => r.endLineNumber));
        }
      } catch (_) {
      }
      start = Math.max(1, Math.min(start, model.getLineCount()));
      end = Math.max(1, Math.min(end, model.getLineCount()));
      const res = await this.execLua(SEARCH_HIGHLIGHT_LUA, [start, end]);
      this.applySearchHighlights(res, model);
    } catch (_) {
    }
    this.searchRefreshInFlight = false;
    if (this.searchRefreshPending) {
      this.searchRefreshPending = false;
      this.scheduleSearchHighlightRefresh();
    }
  }

  private applySearchHighlights(res: unknown, model: monaco.editor.ITextModel): void {
    if (!res || typeof res !== "object") {
      this.clearSearchHighlights();
      return;
    }
    const obj = res as Record<string, unknown>;
    const enabled = Boolean(obj.enabled);
    if (!enabled) {
      this.clearSearchHighlights();
      return;
    }
    const matches = Array.isArray(obj.matches) ? (obj.matches as any[]) : [];
    const current = (obj.current && typeof obj.current === "object") ? (obj.current as any) : null;
    const currentKey = current && Number.isFinite(Number(current.l)) ? `${Number(current.l)}:${Number(current.s)}:${Number(current.e)}` : null;

    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const max = 2000;
    const lineCache = new Map<number, string>();
    const getLine = (ln: number) => {
      if (lineCache.has(ln)) return lineCache.get(ln)!;
      const text = model.getLineContent(ln) ?? "";
      lineCache.set(ln, text);
      return text;
    };

    for (let i = 0; i < matches.length && decorations.length < max; i += 1) {
      const m = matches[i];
      const l0 = Number(m?.l);
      const s0 = Number(m?.s);
      const e0 = Number(m?.e);
      if (!Number.isFinite(l0) || !Number.isFinite(s0) || !Number.isFinite(e0)) continue;
      const lineNumber = l0 + 1;
      if (lineNumber < 1 || lineNumber > model.getLineCount()) continue;
      const text = getLine(lineNumber);
      const startCol = byteIndexToCharIndex(text, Math.max(0, s0)) + 1;
      const endCol = byteIndexToCharIndex(text, Math.max(0, e0)) + 1;
      if (endCol <= startCol) continue;
      const key = `${l0}:${s0}:${e0}`;
      const className = (currentKey && key === currentKey) ? "monaco-neovim-search-current" : "monaco-neovim-search-match";
      decorations.push({
        range: new monaco.Range(lineNumber, startCol, lineNumber, endCol),
        options: { inlineClassName: className },
      });
    }

    this.ensureSearchStyle();
    try {
      this.searchDecorationIds = this.editor.deltaDecorations(this.searchDecorationIds, decorations);
    } catch (_) {
      this.searchDecorationIds = [];
    }
  }

  private applyVisualDecorations(
    selections: monaco.Selection[],
    mode: string,
    rawRanges: any[] = [],
    modeTailOverride = "",
  ): void {
    this.ensureVisualStyle();
    const tail = (typeof modeTailOverride === "string" && modeTailOverride) ? modeTailOverride : getModeTail(mode);
    const isLinewise = tail === "V";
    const isBlockwise = tail === "\u0016";
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
    } else if (!isBlockwise) {
      for (const sel of selections) {
        const a = sel.getStartPosition();
        const b = sel.getEndPosition();
        decorations.push({
          range: monaco.Range.fromPositions(a, b),
          options: { className: "monaco-neovim-visual-inline" },
        });
      }
    }

    if (isBlockwise) {
      this.visualVirtualRawRanges = Array.isArray(rawRanges) ? rawRanges : [];
      this.visualVirtualActive = true;
      this.renderVisualVirtualOverlay();
    } else {
      this.clearVisualVirtualOverlay();
    }
    try {
      this.visualDecorationIds = this.editor.deltaDecorations(this.visualDecorationIds, decorations);
      this.visualSelectionActive = decorations.length > 0 || isBlockwise;
    } catch (_) {
      this.visualDecorationIds = [];
      this.visualSelectionActive = false;
    }

    // Keep Monaco's own selection collapsed so it doesn't visually compete with
    // Neovim's visual-mode highlights (especially in visual-block mode where we
    // use a DOM overlay instead of model decorations).
    if (this.visualSelectionActive && !this.compositionActive) {
      // Only collapse using Monaco's *current* cursor position. Using a cached
      // lastCursorPos here can jump the cursor when entering visual mode (mode
      // events can arrive before cursor events).
      const pos = this.editor.getPosition();
      if (pos) {
        try {
          this.suppressCursorSync = true;
          this.editor.setSelection(new monaco.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column));
        } catch (_) {
        } finally {
          this.suppressCursorSync = false;
        }
      }
    }
  }

  private applyNvimMode(mode: string): void {
    const m = typeof mode === "string" ? mode : "";
    if (!m || m === this.lastMode) return;
    const prevMode = this.lastMode;
    this.lastMode = m;
    if (isCmdlineLike(m)) this.ignoreNextInputEvent = false;
    this.setMonacoHighlightsSuppressed(isVisualMode(m));

    const nextDelegate = isInsertLike(m) && !this.recordingRegister;
    if (nextDelegate !== this.delegateInsertToMonaco) {
      this.delegateInsertToMonaco = nextDelegate;
      this.setEditorReadOnly(!nextDelegate);
      const state = this.ensureActiveState();
      if (nextDelegate) {
        this.setPreedit(null);
        this.dotRepeatKeys = "";
        this.dotRepeatBackspaces = 0;
        this.delegatedInsertReplayPossible = true;
        {
          const raw = this.recentNormalKeys;
          const last1 = raw.slice(-1);
          const last2 = raw.slice(-2);
          const single = new Set(["i", "a", "I", "A", "o", "O", "s", "S", "C", "R"]);
          if (last2 === "cc") {
            this.lastDelegatedInsertPrefix = "cc";
          } else if (single.has(last1)) {
            this.lastDelegatedInsertPrefix = last1;
          } else {
            const idx = raw.lastIndexOf("c");
            if (idx >= 0) {
              let start = idx;
              while (start > 0 && /\d/.test(raw[start - 1] ?? "")) start -= 1;
              this.lastDelegatedInsertPrefix = raw.slice(start);
            } else {
              this.lastDelegatedInsertPrefix = null;
            }
          }
        }
        if (state) {
          state.shadowLines = this.editor.getModel()?.getLinesContent() ?? null;
          state.pendingBufEdits = [];
          state.pendingFullSync = false;
          state.pendingCursorSync = false;
        }
      } else {
        if (state) {
          if (state.pendingBufEdits.length || state.pendingCursorSync || state.pendingFullSync) {
            this.flushPendingMonacoSync();
          }
          state.shadowLines = null;
          state.pendingBufEdits = [];
          state.pendingFullSync = false;
          state.pendingCursorSync = false;
        }
        this.dotRepeatKeys = "";
        this.dotRepeatBackspaces = 0;
        this.delegatedInsertReplayPossible = false;
      }
    }

    if (this.exitingInsertMode && !isInsertLike(m)) {
      if (this.exitInsertTimer) {
        clearTimeout(this.exitInsertTimer);
        this.exitInsertTimer = null;
      }
      this.exitingInsertMode = false;
      const pending = this.pendingKeysAfterExit;
      this.pendingKeysAfterExit = "";
      if (pending) this.sendInput(pending);
    }

    this.applyCursorStyle(m);
    if (this.opts.onModeChange) this.opts.onModeChange(m);
    void this.updateVisualSelection(m);
    if (isVisualMode(prevMode) && !isVisualMode(m)) {
      // Monaco selection can persist even after leaving visual mode; clear it to
      // avoid Monaco-only deletes (e.g. Backspace) and rely on decorations instead.
      try {
        const pos = this.editor.getPosition() ?? this.lastCursorPos;
        if (pos && !this.compositionActive) {
          this.suppressCursorSync = true;
          this.editor.setSelection(new monaco.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column));
          this.suppressCursorSync = false;
        }
      } catch (_) {
        this.suppressCursorSync = false;
      }
    }
    this.scheduleSearchHighlightRefresh();
  }

  private setEditorReadOnly(readOnly: boolean): void {
    const next = Boolean(readOnly);
    if (this.editorReadOnly === next) return;
    try {
      this.editor.updateOptions({ readOnly: next });
      this.editorReadOnly = next;
    } catch (_) {
    }
  }

  private armInsertExit(): void {
    this.exitingInsertMode = true;
    // When exiting delegated insert, Monaco can emit follow-up cursor updates
    // (source="api") due to option toggles/selection normalization. Don't sync
    // those back to Neovim, otherwise they can override Neovim's final cursor
    // position after <Esc>.
    this.ignoreMonacoCursorSyncToNvimUntil = this.nowMs() + 250;
    this.pendingKeysAfterExit = "";
    if (this.exitInsertTimer) {
      clearTimeout(this.exitInsertTimer);
      this.exitInsertTimer = null;
    }
    // Stop any debounced Monaco->Neovim sync from firing after we've initiated
    // insert-mode exit; late cursor syncs can override Neovim's final cursor
    // position after <Esc>.
    if (this.cursorSyncTimer) {
      clearTimeout(this.cursorSyncTimer);
      this.cursorSyncTimer = null;
    }
    // Fallback: if we don't observe a mode change soon, don't keep buffering forever.
    this.exitInsertTimer = window.setTimeout(() => {
      this.exitInsertTimer = null;
      if (!this.exitingInsertMode) return;
      const pending = this.pendingKeysAfterExit;
      this.pendingKeysAfterExit = "";
      if (pending) this.sendInput(pending);
    }, 800);
  }

  private finalizeDelegatedInsertDotRepeat(): void {
    const prefix = this.lastDelegatedInsertPrefix;
    const keys = this.dotRepeatKeys;
    if (this.delegatedInsertReplayPossible && prefix && keys) {
      this.lastDelegatedDotRepeat = { prefix, keys };
    } else {
      this.lastDelegatedDotRepeat = null;
    }
    this.dotRepeatKeys = "";
    this.dotRepeatBackspaces = 0;
    this.delegatedInsertReplayPossible = false;
  }

  private exitDelegatedInsertMode(exitKey: string): void {
    this.debugLog(`exitDelegatedInsertMode: key=${JSON.stringify(exitKey)} prefix=${JSON.stringify(this.lastDelegatedInsertPrefix)} dotKeysLen=${this.dotRepeatKeys.length} replayPossible=${this.delegatedInsertReplayPossible}`);
    this.finalizeDelegatedInsertDotRepeat();
    // Begin buffering keys immediately, then perform a blocking flush/cursor-sync
    // before sending <Esc>, matching vscode-neovim's sequencing.
    this.armInsertExit();
    void this.performDelegatedInsertExit(exitKey);
  }

  private async performDelegatedInsertExit(exitKey: string): Promise<void> {
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;

    try {
      this.debugLog(`performDelegatedInsertExit: begin buf=${this.bufHandle} exitKey=${JSON.stringify(exitKey)}`);
    } catch (_) {
    }

    try {
      await this.flushPendingMonacoSyncBlocking();
    } catch (_) {
    }

    try {
      const model = this.editor.getModel();
      const pos = this.editor.getPosition();
      if (model && pos) {
        const text = model.getLineContent(pos.lineNumber) ?? "";
        const byteCol0 = charIndexToByteIndex(text, Math.max(0, pos.column - 1));
        this.ignoreInsertExitCursor = { line: pos.lineNumber, col0: byteCol0, untilMs: this.nowMs() + 400 };
        this.debugLog(`exitDelegatedInsertMode: sync cursor before exit: line=${pos.lineNumber} col=${pos.column} (byteCol0=${byteCol0})`);
        await this.rpcCall("nvim_win_set_cursor", [0, [pos.lineNumber, byteCol0]]);
      }
    } catch (_) {
    }

    try {
      await this.rpcCall("nvim_input", [exitKey]);
    } catch (_) {
      this.sendInput(exitKey);
    }

    try {
      this.debugLog(`performDelegatedInsertExit: sent exitKey=${JSON.stringify(exitKey)}`);
    } catch (_) {
    }
  }

  private async flushPendingMonacoSyncBlocking(): Promise<void> {
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;
    const state = this.getActiveState();
    if (!state) return;
    const model = this.editor.getModel();
    if (!model) return;
    if (state.model !== model) return;

    try {
      this.debugLog(`flushPendingMonacoSyncBlocking: full=${state.pendingFullSync} edits=${state.pendingBufEdits.length} cursor=${state.pendingCursorSync} buf=${this.bufHandle}`);
    } catch (_) {
    }

    // Match flushPendingMonacoSync's preference for full sync when multiple edits exist.
    if (!state.pendingFullSync && state.pendingBufEdits.length > 1) {
      state.pendingFullSync = true;
    }

    if (state.pendingFullSync) {
      const lines = model.getLinesContent();
      state.pendingFullSync = false;
      state.pendingBufEdits = [];
      state.pendingCursorSync = false;
      state.shadowLines = lines.slice();
      if (this.delegateInsertToMonaco) this.ignoreActiveBufLinesEventsUntil = this.nowMs() + 120;
      await this.rpcCall("nvim_buf_set_lines", [this.bufHandle, 0, -1, false, lines]);
      return;
    }

    if (state.pendingBufEdits.length) {
      const edits = state.pendingBufEdits.slice();
      state.pendingBufEdits = [];
      state.pendingCursorSync = false;
      if (this.delegateInsertToMonaco) this.ignoreActiveBufLinesEventsUntil = this.nowMs() + 120;
      for (const edit of edits) {
        await this.rpcCall("nvim_buf_set_text", [this.bufHandle, edit.startRow, edit.startColByte, edit.endRow, edit.endColByte, edit.lines]);
      }
      return;
    }

    if (state.pendingCursorSync) {
      state.pendingCursorSync = false;
    }
  }

  private syncDotRepeatToNvim(): void {
    if (!this.session || !this.session.isRunning()) return;
    const keys = this.dotRepeatKeys;
    const bs = this.dotRepeatBackspaces;
    this.dotRepeatKeys = "";
    this.dotRepeatBackspaces = 0;
    if (!keys) return;
    const lua = `
local api = vim.api
local keys, bs = ...
keys = type(keys) == "string" and keys or ""
if keys == "" then
  return
end
local mode = (api.nvim_get_mode() or {}).mode or ""
if not mode:match("^[iR]") then
  return
end
local ei = vim.opt.ei:get()
vim.opt.ei = "all"
local curr_win = api.nvim_get_current_win()
local temp_buf = api.nvim_create_buf(false, true)
local temp_win = api.nvim_open_win(temp_buf, true, { external = true, width = 1, height = 1 })
bs = tonumber(bs) or 0
if bs > 0 then
  pcall(api.nvim_buf_set_lines, temp_buf, 0, -1, false, { ("x"):rep(bs) })
  pcall(api.nvim_win_set_cursor, temp_win, { 1, bs })
end
local tc = api.nvim_replace_termcodes(keys, true, true, true)
api.nvim_feedkeys(tc, "n", true)
pcall(api.nvim_set_current_win, curr_win)
pcall(api.nvim_win_close, temp_win, true)
pcall(api.nvim_buf_delete, temp_buf, { force = true })
vim.opt.ei = ei
`;
    void this.execLua(lua, [keys, bs]).catch(() => {});
  }

  private handleKey(ev: monaco.IKeyboardEvent): void {
    const browserEvent = ev.browserEvent as KeyboardEvent;
    if (this.exitingInsertMode) {
      if (browserEvent.key === "Escape") {
        ev.preventDefault();
        return;
      }
      // IME: don't intercept Process/229 events; they are part of composition flow.
      if (browserEvent.key === "Process" || (browserEvent as any).keyCode === 229) {
        this.compositionActive = true;
        return;
      }
      if (this.compositionActive || browserEvent.isComposing) return;
      if (!this.opts.shouldHandleKey(browserEvent)) return;
      if (this.hasExplicitModAllowlist(false)) {
        if (!this.shouldForwardModifiedKeys(browserEvent, false)) return;
      }
      const key = this.opts.translateKey(browserEvent);
      if (!key) return;
      this.ignoreNextInputEvent = true;
      ev.preventDefault();
      this.pendingKeysAfterExit += key;
      return;
    }
    if (this.delegateInsertToMonaco) {
      // While delegating insert-mode typing to Monaco (IME-friendly), only
      // forward "command-like" keys to Neovim after syncing Monaco -> Neovim.
      if (browserEvent.key === "Escape") {
        if (this.compositionActive || browserEvent.isComposing) {
          // Let the browser/Monaco finish the IME composition first, then send
          // <Esc> to Neovim from `compositionend`.
          this.pendingEscAfterComposition = true;
          return;
        }
        ev.preventDefault();
        this.exitDelegatedInsertMode("<Esc>");
        return;
      }
      if (!this.opts.shouldHandleKey(browserEvent)) return;
      if (this.hasExplicitModAllowlist(true)) {
        if (!this.shouldForwardModifiedKeys(browserEvent, true)) return;
      }
      if ((browserEvent.ctrlKey || browserEvent.altKey || browserEvent.metaKey) && !browserEvent.getModifierState?.("AltGraph")) {
        const key = this.opts.translateKey(browserEvent);
        if (!key) return;
        ev.preventDefault();
        if (key === "<C-[>" || key === "<C-c>") {
          this.exitDelegatedInsertMode(key);
        } else {
          this.flushPendingMonacoSync();
          this.sendInput(key);
        }
        return;
      }
      return;
    }
    if (
      isCmdlineLike(this.lastMode)
      && !this.compositionActive
      && !browserEvent.isComposing
      && !(browserEvent.getModifierState?.("AltGraph"))
      && !browserEvent.ctrlKey
      && !browserEvent.metaKey
      && (typeof browserEvent.key === "string" && browserEvent.key.length === 1)
    ) {
      const asciiPrintable = /^[\x20-\x7E]$/.test(browserEvent.key);
      const treatAsAltChord = Boolean(browserEvent.altKey && asciiPrintable);
      if (!treatAsAltChord) {
        if (!this.opts.shouldHandleKey(browserEvent)) return;
        return;
      }
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
    if (this.hasExplicitModAllowlist(false)) {
      if (!this.shouldForwardModifiedKeys(browserEvent, false)) return;
    }
    const key = this.opts.translateKey(browserEvent);
    if (!key) return;
    // Some browsers still dispatch an `input` event even if we preventDefault on
    // keydown. Ignore the next `input` to avoid double-sending text.
    this.ignoreNextInputEvent = true;
    ev.preventDefault();
    if (this.lastMode.startsWith("n")) {
      if (key === "q") {
        if (this.recordingRegister) {
          this.recordingRegister = "";
          this.scheduleRecordingRefresh();
        } else {
          this.recordingRefreshArmed = true;
        }
      } else if (this.recordingRefreshArmed && typeof key === "string" && key.length === 1) {
        this.recordingRefreshArmed = false;
        this.recordingRegister = key;
        this.scheduleRecordingRefresh();
      }

      if (key === "." && this.lastDelegatedDotRepeat) {
        const { prefix, keys: replay } = this.lastDelegatedDotRepeat;
        this.sendInput(prefix);
        this.sendInput(replay);
        this.sendInput("<Esc>");
        return;
      }

      if (this.lastDelegatedDotRepeat) {
        const clearOn = new Set(["c", "d", "y", "p", "x", "s", "r", "~", "J", ":"]);
        if (clearOn.has(key)) this.lastDelegatedDotRepeat = null;
      }

    }
    if (!isInsertLike(this.lastMode) && key.length === 1 && !key.startsWith("<")) {
      this.recentNormalKeys = (this.recentNormalKeys + key).slice(-16);
    }
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

  private handleSelection(ev: monaco.editor.ICursorSelectionChangedEvent): void {
    if (this.delegateInsertToMonaco) return;
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;
    if (this.suppressCursorSync) return;
    if (this.compositionActive || (ev as any)?.isComposing) return;

    const sel = ev.selection;
    if (!sel) return;

    // Only sync mouse-driven selections to avoid interfering with programmatic selection changes.
    if (ev.source !== "mouse") return;

    if (sel.isEmpty()) {
      // Clicking to clear a selection should exit visual mode.
      if (isVisualMode(this.lastMode)) this.sendInput("<Esc>");
      return;
    }

    this.pendingSelection = new monaco.Selection(
      sel.selectionStartLineNumber,
      sel.selectionStartColumn,
      sel.positionLineNumber,
      sel.positionColumn,
    );
    if (this.selectionSyncTimer) return;
    this.selectionSyncTimer = window.setTimeout(() => {
      this.selectionSyncTimer = null;
      const pending = this.pendingSelection;
      this.pendingSelection = null;
      if (!pending) return;
      void this.syncVisualSelectionToNvim(pending).catch(() => {});
    }, 80);
  }

  private async syncVisualSelectionToNvim(sel: monaco.Selection): Promise<void> {
    if (this.delegateInsertToMonaco) return;
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;
    const model = this.editor.getModel();
    if (!model) return;

    const anchorLine = sel.selectionStartLineNumber;
    const anchorCharCol0 = Math.max(0, sel.selectionStartColumn - 1);
    const activeLine = sel.positionLineNumber;
    const activeCharCol0 = Math.max(0, sel.positionColumn - 1);

    const anchorText = model.getLineContent(anchorLine) ?? "";
    const activeText = model.getLineContent(activeLine) ?? "";
    const anchorByteCol0 = charIndexToByteIndex(anchorText, anchorCharCol0);
    const activeByteCol0 = charIndexToByteIndex(activeText, activeCharCol0);

    const lua = `
local api = vim.api
local fn = vim.fn
local a_line, a_col0, b_line, b_col0 = ...
local mode = api.nvim_get_mode().mode or ""
if mode:match("[vV\\022]") then
  local esc = api.nvim_replace_termcodes("<Esc>", true, true, true)
  api.nvim_feedkeys(esc, "n", false)
end
api.nvim_win_set_cursor(0, { a_line, a_col0 })
api.nvim_feedkeys("v", "n", false)
api.nvim_win_set_cursor(0, { b_line, b_col0 })
`;
    await this.execLua(lua, [anchorLine, anchorByteCol0, activeLine, activeByteCol0]);
  }

  private sendInput(keys: string): void {
    this.sendNotify("nvim_input", [keys]);
  }

  private modifiedKeyName(ev: KeyboardEvent): string | null {
    const key = ev.key;
    if (!key) return null;
    if (key.length === 1) {
      if (/^[A-Za-z]$/.test(key)) return key.toLowerCase();
      return key.toLowerCase();
    }
    switch (key) {
      case "ArrowUp": return "up";
      case "ArrowDown": return "down";
      case "ArrowLeft": return "left";
      case "ArrowRight": return "right";
      case "Backspace": return "backspace";
      case "Delete": return "delete";
      default: return null;
    }
  }

  private hasExplicitModAllowlist(insertMode: boolean): boolean {
    return Boolean(
      (insertMode ? this.ctrlKeysInsert : this.ctrlKeysNormal)
      || (insertMode ? this.altKeysInsert : this.altKeysNormal)
      || (insertMode ? this.metaKeysInsert : this.metaKeysNormal),
    );
  }

  private shouldForwardModifiedKeys(ev: KeyboardEvent, insertMode: boolean): boolean {
    const name = this.modifiedKeyName(ev);
    if (!name) return false;
    if (ev.ctrlKey) {
      const allow = insertMode ? this.ctrlKeysInsert : this.ctrlKeysNormal;
      if (allow && !allow.has(name)) return false;
    }
    if (ev.altKey) {
      const allow = insertMode ? this.altKeysInsert : this.altKeysNormal;
      if (allow && !allow.has(name)) return false;
    }
    if (ev.metaKey) {
      const allow = insertMode ? this.metaKeysInsert : this.metaKeysNormal;
      if (allow && !allow.has(name)) return false;
    }
    return true;
  }

  private pasteText(text: string): void {
    const payload = String(text ?? "");
    if (!payload) return;
    const crlf = payload.includes("\r\n");
    this.sendNotify("nvim_paste", [payload, crlf, -1]);
  }

  private handleMonacoModelChange(ev: monaco.editor.IModelContentChangedEvent): void {
    if (!this.delegateInsertToMonaco) {
      // In non-insert delegation, Neovim is the source of truth and Monaco edits
      // are unexpected; force a resync to correct any transient/bad keybinding effects.
      if (this.applyingFromNvim) return;
      if (!this.session || !this.session.isRunning()) return;
      if (!this.bufHandle) return;
      if (this.compositionActive || (ev as any)?.isComposing) return;
      if (ev?.changes?.length) this.scheduleResync();
      return;
    }
    if (this.applyingFromNvim) return;
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;
    const model = this.editor.getModel();
    if (!model) return;
    const state = this.ensureActiveState();
    if (!state || state.model !== model) return;

    if (!state.shadowLines) {
      // We don't have a reliable pre-change snapshot; fall back to full sync.
      state.pendingFullSync = true;
      state.pendingCursorSync = true;
      state.shadowLines = model.getLinesContent();
      this.dotRepeatKeys = "";
      this.dotRepeatBackspaces = 0;
      this.delegatedInsertReplayPossible = false;
      this.scheduleFlushPendingMonacoSync();
      return;
    }

    if (!ev.changes || ev.changes.length !== 1) {
      state.pendingFullSync = true;
      state.pendingCursorSync = true;
      state.shadowLines = model.getLinesContent();
      this.dotRepeatKeys = "";
      this.dotRepeatBackspaces = 0;
      this.delegatedInsertReplayPossible = false;
      this.scheduleFlushPendingMonacoSync();
      return;
    }

    const change = ev.changes[0];
    const range = change.range;
    const startRow = range.startLineNumber - 1;
    const endRow = range.endLineNumber - 1;
    if (startRow < 0 || endRow < 0) return;
    if (state.shadowLines[startRow] == null || state.shadowLines[endRow] == null) {
      state.pendingFullSync = true;
      state.pendingCursorSync = true;
      state.shadowLines = model.getLinesContent();
      this.dotRepeatKeys = "";
      this.dotRepeatBackspaces = 0;
      this.delegatedInsertReplayPossible = false;
      this.scheduleFlushPendingMonacoSync();
      return;
    }

    const oldStartLine = state.shadowLines[startRow] ?? "";
    const oldEndLine = state.shadowLines[endRow] ?? "";
    const startColChar = Math.max(0, range.startColumn - 1);
    const endColChar = Math.max(0, range.endColumn - 1);
    const startColByte = charIndexToByteIndex(oldStartLine, startColChar);
    const endColByte = charIndexToByteIndex(oldEndLine, endColChar);
    const text = String(change.text ?? "");
    const lines = text.length ? text.split(/\r?\n/) : [];

    // Best-effort dot-repeat tracking for Monaco-delegated insert typing.
    // This is intentionally conservative; complex multi-line edits are ignored.
    try {
      const deleted = Math.max(0, Number((change as any).rangeLength ?? 0) || 0);
      if (startRow === endRow && !text.includes("\n")) {
        if (deleted > 0) {
          this.dotRepeatBackspaces += deleted;
          this.dotRepeatKeys += "<BS>".repeat(deleted);
        }
        if (text) {
          this.dotRepeatKeys += normalizeNvimInputText(text, true);
        }
        if (this.dotRepeatKeys.length > 20000) {
          this.dotRepeatKeys = "";
          this.dotRepeatBackspaces = 0;
          this.delegatedInsertReplayPossible = false;
        }
      } else {
        this.dotRepeatKeys = "";
        this.dotRepeatBackspaces = 0;
        this.delegatedInsertReplayPossible = false;
      }
    } catch (_) {
    }

    state.pendingBufEdits.push({ startRow, startColByte, endRow, endColByte, lines });
    applyShadowLinesChange(state.shadowLines, startRow, startColChar, endRow, endColChar, text);

    state.pendingCursorSync = true;
    this.scheduleFlushPendingMonacoSync();
  }

  private scheduleCursorSyncToNvim(): void {
    if (!this.delegateInsertToMonaco) return;
    if (this.exitingInsertMode) return;
    const state = this.getActiveState();
    if (!state) return;
    state.pendingCursorSync = true;
    this.scheduleFlushPendingMonacoSync();
  }

  private scheduleFlushPendingMonacoSync(): void {
    if (this.cursorSyncTimer) return;
    const delay = Math.max(0, Number(this.opts.insertSyncDebounceMs) || 0);
    this.cursorSyncTimer = window.setTimeout(() => {
      this.cursorSyncTimer = null;
      this.flushPendingMonacoSync();
    }, delay);
  }

  private flushPendingMonacoSync(): void {
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;
    const state = this.getActiveState();
    if (!state) return;
    const model = this.editor.getModel();
    if (!model) return;
    if (state.model !== model) return;

    this.debugLog(`flushPendingMonacoSync: full=${state.pendingFullSync} edits=${state.pendingBufEdits.length} cursor=${state.pendingCursorSync} delegateInsert=${this.delegateInsertToMonaco} exitingInsert=${this.exitingInsertMode} mode=${JSON.stringify(this.lastMode)}`);

    // Prefer a single full sync when there are multiple incremental edits; it
    // reduces undo fragmentation and avoids tricky coordinate rebasing.
    if (!state.pendingFullSync && state.pendingBufEdits.length > 1) {
      state.pendingFullSync = true;
    }

    if (state.pendingFullSync) {
      const lines = model.getLinesContent();
      this.sendNotify("nvim_buf_set_lines", [this.bufHandle, 0, -1, false, lines]);
      if (this.delegateInsertToMonaco) this.ignoreActiveBufLinesEventsUntil = this.nowMs() + 120;
      state.pendingFullSync = false;
      state.pendingBufEdits = [];
      state.shadowLines = lines.slice();
    } else if (state.pendingBufEdits.length) {
      for (const edit of state.pendingBufEdits) {
        this.sendNotify("nvim_buf_set_text", [this.bufHandle, edit.startRow, edit.startColByte, edit.endRow, edit.endColByte, edit.lines]);
      }
      if (this.delegateInsertToMonaco) this.ignoreActiveBufLinesEventsUntil = this.nowMs() + 120;
      state.pendingBufEdits = [];
    }

    if (state.pendingCursorSync) {
      state.pendingCursorSync = false;
      // Only sync the caret position while insert-mode typing is delegated to
      // Monaco. After leaving insert mode, Neovim owns the caret and late syncs
      // can cause cursor jumps.
      if (this.delegateInsertToMonaco && !this.exitingInsertMode) {
        this.syncCursorToNvimNow();
      }
    }
  }

  private syncCursorToNvimNow(force = false): void {
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;
    if (!force && !this.delegateInsertToMonaco) return;
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
      const scrolloff = (this.opts.syncScrolloff && this.opts.scrolloff == null) ? "true" : "false";
      const hostCommands = this.opts.hostCommands ? "true" : "false";
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

local function send_scrolloff()
  local so = vim.o.scrolloff or 0
  vim.rpcnotify(chan, "monaco_scrolloff", so)
end

local function send_recording()
  local r = vim.fn.reg_recording() or ""
  vim.rpcnotify(chan, "monaco_recording", r)
end

if ${wrapped} then
  pcall(vim.cmd, "silent! source $HOME/.config/nvim/monaco-neovim-wasm/motion.vim")
end

if ${scroll} then
  pcall(vim.cmd, "silent! source $HOME/.config/nvim/monaco-neovim-wasm/scrolling.vim")
end
if ${hostCommands} then
  pcall(vim.cmd, "silent! source $HOME/.config/nvim/monaco-neovim-wasm/host-commands.vim")
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
api.nvim_create_autocmd({ "RecordingEnter", "RecordingLeave" }, {
  group = group,
  callback = function() send_recording() end,
})
if ${scrolloff} then
  api.nvim_create_autocmd({ "OptionSet" }, {
    group = group,
    pattern = { "scrolloff" },
    callback = function() send_scrolloff() end,
  })
end
api.nvim_create_autocmd({ "BufEnter", "BufWinEnter" }, {
  group = group,
  callback = function()
    local b = api.nvim_get_current_buf()
    local name = api.nvim_buf_get_name(b) or ""
    local ft = (vim.bo[b] and vim.bo[b].filetype) or ""
    vim.rpcnotify(chan, "monaco_buf_enter", { buf = b, name = name, filetype = ft })
    send_cursor()
  end,
})
api.nvim_create_autocmd({ "BufDelete" }, {
  group = group,
  callback = function(ev)
    local b = (ev and ev.buf) or api.nvim_get_current_buf()
    vim.rpcnotify(chan, "monaco_buf_delete", { buf = b })
  end,
})

send_mode()
send_cursor()
send_scrolloff()
send_recording()
vim.rpcnotify(chan, "monaco_buf_enter", {
  buf = api.nvim_get_current_buf(),
  name = api.nvim_buf_get_name(api.nvim_get_current_buf()) or "",
  filetype = (vim.bo[api.nvim_get_current_buf()] and vim.bo[api.nvim_get_current_buf()].filetype) or "",
})
`;
      await this.execLua(lua, [chan]);
      this.hostAutocmdInstalled = true;
    } catch (_) {
    }
  }

  private async handleHostCommand(arg: Record<string, unknown>): Promise<void> {
    const action = typeof arg.action === "string" ? arg.action : "";
    if (!action) return;
    const cmd = { ...arg, action } as HostCommand;

    if (this.opts.onHostCommand) {
      try { await this.opts.onHostCommand(cmd); } catch (_) {}
      return;
    }

    const fs = this.opts.fileSystem;
    if (!fs) {
      this.opts.status(`host command ignored: ${action}`, true);
      return;
    }

    if (action === "edit") {
      const path = typeof (cmd as any).path === "string" ? String((cmd as any).path) : "";
      if (!path) {
        this.opts.status("edit: no path (provide onHostCommand or fileSystem.readFile)", true);
        return;
      }
      if (!fs.readFile) {
        this.opts.status("edit: fileSystem.readFile not set", true);
        return;
      }
      try {
        const res = await fs.readFile(path);
        if (res == null) return;
        const text = res instanceof Uint8Array ? new TextDecoder().decode(res) : String(res);
        await this.openText({ path, text });
        this.opts.status(`opened: ${path}`);
      } catch (e) {
        this.opts.status(`edit failed: ${(e as Error)?.message ?? e}`, true);
      }
      return;
    }

    if (action === "write" || action === "wq") {
      const model = this.editor.getModel();
      const text = model ? model.getValue() : "";
      let path = typeof (cmd as any).path === "string" ? String((cmd as any).path) : "";
      if (!path) {
        try {
          const name = await this.rpcCall("nvim_buf_get_name", [0]);
          if (typeof name === "string") path = name;
        } catch (_) {
        }
      }
      if (!path) path = this.opts.seedName;
      if (!fs.writeFile) {
        this.opts.status("write: fileSystem.writeFile not set", true);
        return;
      }
      try {
        await fs.writeFile(path, text);
        try {
          await this.rpcCall("nvim_buf_set_name", [0, path]);
        } catch (_) {
        }
        try { await this.rpcCall("nvim_buf_set_option", [0, "modified", false]); } catch (_) {}
        const state = this.getActiveState();
        if (state) {
          if (state.name && state.name !== path) this.buffersByName.delete(state.name);
          state.name = path;
          this.buffersByName.set(path, state.id);
        }
        this.opts.status(`written: ${path}`);
        if (action === "wq") {
          this.opts.status("wq requested (provide onHostCommand to close the editor)");
        }
      } catch (e) {
        this.opts.status(`write failed: ${(e as Error)?.message ?? e}`, true);
      }
      return;
    }

    if (action === "quit") {
      this.opts.status("quit requested (provide onHostCommand to close the editor)");
      return;
    }

    this.opts.status(`host command ignored: ${action}`, true);
  }

  private async handleBufEnter(arg: Record<string, unknown>): Promise<void> {
    const id = Number((arg as any).buf);
    if (!Number.isFinite(id) || id <= 0) return;
    const name = typeof (arg as any).name === "string" ? String((arg as any).name) : "";
    const filetype = typeof (arg as any).filetype === "string" ? String((arg as any).filetype) : "";

    if (this.delegateInsertToMonaco) {
      // Flush edits for the previous active buffer before switching.
      this.flushPendingMonacoSync();
    }

    let state = this.buffers.get(id) ?? null;
    if (!state && this.bufHandle === id) {
      state = this.ensureActiveState();
    }
    if (!state) {
      try { await this.rpcCall("nvim_buf_attach", [id, false, {}]); } catch (_) {}
      let lines: string[] = [""];
      try {
        const all = await this.rpcCall("nvim_buf_get_lines", [id, 0, -1, false]);
        if (Array.isArray(all)) lines = (all as unknown[]).map((l) => String(l ?? ""));
      } catch (_) {
      }
      const uri = monaco.Uri.from({ scheme: "nvim", authority: "buf", path: `/${id}` });
      const text = lines.join("\n");
      const hasLang = filetype && monaco.languages.getLanguages().some((l) => l.id === filetype);
      const model = monaco.editor.createModel(text, hasLang ? filetype : undefined, uri);
      state = {
        id,
        name: name || "",
        filetype: filetype || "",
        model,
        createdModel: true,
        shadowLines: null,
        pendingBufEdits: [],
        pendingFullSync: false,
        pendingCursorSync: false,
      };
      this.buffers.set(id, state);
    }

    if (name) state.name = name;
    if (filetype) state.filetype = filetype;
    if (state.name) this.buffersByName.set(state.name, id);

    this.bufHandle = id;
    const currentModel = this.editor.getModel();
    if (currentModel !== state.model) {
      this.suppressCursorSync = true;
      try { this.editor.setModel(state.model); } catch (_) {}
      this.suppressCursorSync = false;
    }

    if (this.delegateInsertToMonaco) {
      try { state.shadowLines = state.model.getLinesContent(); } catch (_) { state.shadowLines = null; }
      state.pendingBufEdits = [];
      state.pendingFullSync = false;
      state.pendingCursorSync = false;
    }

    if (this.opts.syncTabstop) this.syncTabstopFromMonaco();
    this.scheduleSearchHighlightRefresh();
  }

  private handleBufDelete(arg: Record<string, unknown>): void {
    const id = Number((arg as any).buf);
    if (!Number.isFinite(id) || id <= 0) return;
    const state = this.buffers.get(id);
    if (!state) return;
    this.buffers.delete(id);
    if (state.name) this.buffersByName.delete(state.name);
    if (state.createdModel) {
      try { state.model.dispose(); } catch (_) {}
    }
  }

  private async openText({ path, text }: { path: string; text: string }): Promise<void> {
    if (!this.session || !this.session.isRunning()) return;
    const lines = String(text ?? "").split(/\r?\n/);
    const p = String(path ?? "");
    if (!p) return;

    let bufId = this.buffersByName.get(p) ?? null;
    if (!bufId) {
      try {
        const created = await this.rpcCall("nvim_create_buf", [true, false]);
        bufId = extractBufId(created) ?? Number(created);
      } catch (_) {
        bufId = null;
      }
    }
    if (!bufId || !Number.isFinite(bufId) || bufId <= 0) return;

    try { await this.rpcCall("nvim_buf_set_lines", [bufId, 0, -1, false, lines]); } catch (_) {}
    try { await this.rpcCall("nvim_buf_set_name", [bufId, p]); } catch (_) {}
    try { await this.rpcCall("nvim_buf_set_option", [bufId, "modified", false]); } catch (_) {}
    try { await this.rpcCall("nvim_win_set_buf", [0, bufId]); } catch (_) {}
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
    this.debugLog(`updateCursor: line=${validated.lineNumber} col=${validated.column} (from line=${ln} col=${cl}) visual=${this.visualSelectionActive} mode=${JSON.stringify(this.lastMode)}`);
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
      const applied = this.applyScrolloff(this.lastCursorPos);
      if (!applied) this.editor.revealPositionInCenterIfOutsideViewport(this.lastCursorPos);
      this.suppressCursorSync = false;
    }
    this.scheduleSearchHighlightRefresh();
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
      const { selections, raw, tail } = await this.fetchVisualRanges();
      if (token !== this.visualSelectionToken) return;
      if (!selections.length) return;
      this.applyVisualDecorations(selections, mode, raw, tail);
    } catch (_) {
    }
  }

  private async fetchVisualRanges(): Promise<{ selections: monaco.Selection[]; raw: any[]; tail: string }> {
    const res = await this.execLua(VISUAL_SELECTION_LUA, []);
    let raw: any[] = [];
    let tail = "";
    if (Array.isArray(res)) {
      raw = res as any[];
    } else if (res && typeof res === "object") {
      const obj = res as any;
      tail = typeof obj.tail === "string" ? obj.tail : "";
      raw = Array.isArray(obj.ranges) ? obj.ranges : [];
    }
    const selections = raw
      .map(byteRangeToSelection(this.editor))
      .filter((s): s is monaco.Selection => Boolean(s));
    return { selections, raw, tail };
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

  private setMonacoHighlightsSuppressed(suppress: boolean): void {
    const EditorOption = monaco.editor.EditorOption;
    const next = Boolean(suppress);
    if (next === this.monacoHighlightsSuppressed) return;
    if (next) {
      try {
        this.monacoPrevOccurrencesHighlight = this.editor.getOption(EditorOption.occurrencesHighlight) as any;
        this.monacoPrevSelectionHighlight = this.editor.getOption(EditorOption.selectionHighlight) as any;
        this.monacoPrevSelectionHighlightMultiline = this.editor.getOption(EditorOption.selectionHighlightMultiline) as any;
      } catch (_) {
      }
      try {
        this.editor.updateOptions({
          occurrencesHighlight: "off" as any,
          selectionHighlight: false,
          selectionHighlightMultiline: false,
        } as any);
        this.monacoHighlightsSuppressed = true;
      } catch (_) {
      }
      return;
    }
    try {
      this.editor.updateOptions({
        occurrencesHighlight: (this.monacoPrevOccurrencesHighlight ?? "singleFile") as any,
        selectionHighlight: this.monacoPrevSelectionHighlight ?? true,
        selectionHighlightMultiline: this.monacoPrevSelectionHighlightMultiline ?? true,
      } as any);
    } catch (_) {
    }
    this.monacoHighlightsSuppressed = false;
    this.monacoPrevOccurrencesHighlight = null;
    this.monacoPrevSelectionHighlight = null;
    this.monacoPrevSelectionHighlightMultiline = null;
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

function utf8StringByteLength(text: string): number {
  try {
    return new TextEncoder().encode(String(text ?? "")).length;
  } catch (_) {
    return String(text ?? "").length;
  }
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

function normalizeNvimInputText(text: string, wrapEnter = true): string {
  const payload = String(text ?? "");
  if (!payload) return "";
  // `nvim_input()` treats `<...>` as special key notation.
  // For literal text input, escape `<` and optionally wrap newlines.
  const escaped = payload.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/</g, "<lt>");
  return wrapEnter ? escaped.replace(/\n/g, "<CR>") : escaped;
}

function translateKey(ev: KeyboardEvent): string | null {
  const key = ev.key;
  if (!key || key === "Dead" || key === "Unidentified") return null;

  const isAltGraph = Boolean(ev.getModifierState?.("AltGraph"));
  const isCtrl = ev.ctrlKey && !isAltGraph;
  const isAlt = ev.altKey && !isAltGraph;
  const isMeta = ev.metaKey && !isAltGraph;
  const isShift = ev.shiftKey;

  // Neovim's nvim_input() parses `<...>` key notation, so a literal "<" must be
  // escaped as `<lt>` to avoid being treated as the start of a keycode.
  const normalizeSpecialKeyName = (name: string) => (name === "<" ? "lt" : name);
  const normalizeLiteralChar = (ch: string) => (ch === "<" ? "<lt>" : ch);

  const withMods = (name: string, includeShift = false) => {
    const all: string[] = [];
    if (isCtrl) all.push("C-");
    if (includeShift && isShift) all.push("S-");
    if (isAlt) all.push("A-");
    if (isMeta) all.push("D-");
    const normalized = normalizeSpecialKeyName(name);
    return all.length ? `<${all.join("")}${normalized}>` : `<${normalized}>`;
  };

  const isNumpad = (typeof ev.code === "string" && ev.code.startsWith("Numpad"))
    || (typeof (KeyboardEvent as any)?.DOM_KEY_LOCATION_NUMPAD === "number"
      && ev.location === (KeyboardEvent as any).DOM_KEY_LOCATION_NUMPAD);
  if (isNumpad) {
    switch (ev.code) {
      case "NumpadEnter": return withMods("kEnter", true);
      case "NumpadAdd": return withMods("kPlus", true);
      case "NumpadSubtract": return withMods("kMinus", true);
      case "NumpadMultiply": return withMods("kMultiply", true);
      case "NumpadDivide": return withMods("kDivide", true);
      case "NumpadDecimal": return withMods("kPoint", true);
      default: break;
    }
    if (/^\d$/.test(key)) return withMods(`k${key}`, true);
  }

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
    if (!isCtrl && !isAlt && !isMeta) return normalizeLiteralChar(key);
    if (key === " " && isCtrl && !isAlt && !isMeta) return "<Nul>";
    const ch = /^[A-Za-z]$/.test(key) ? key.toLowerCase() : key;
    const normalized = normalizeSpecialKeyName(ch);
    const prefix = (isCtrl ? "C-" : "") + (isAlt ? "A-" : "") + (isMeta ? "D-" : "");
    return `<${prefix}${normalized}>`;
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
    // If the requested byte offset falls in the middle of a multibyte
    // character, clamp to the *start* of that character.
    if (totalBytes + bytes > target) return charIndex;
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
  // Treat only insert-family modes as "insert-like" for Monaco delegation.
  // Replace mode (`R`) must be handled by Neovim directly; delegating it to
  // Monaco breaks `r{char}` and `R` semantics (replace vs insert).
  return m.startsWith("i");
}

function getModeTail(mode: string): string {
  const m = typeof mode === "string" ? mode : "";
  return m.length ? m[m.length - 1] : "";
}

function isCmdlineLike(mode: string): boolean {
  const m = typeof mode === "string" ? mode : "";
  return m === "c" || m.startsWith("c");
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

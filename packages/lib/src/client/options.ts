import { DEFAULT_SHARED_INPUT_BYTES } from "../sharedInput";
import type { NeovimWasmInputMode } from "../neovimWasmSession";
import type { ClipboardAdapter, FileSystemAdapter, HostCommand, MonacoNeovimOptions, PopupMenuItem, StatusEmitter } from "../types";

export type MonacoNeovimResolvedOptions = {
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
  seedFromMonaco: boolean;
  seedMarkModified: boolean;
  initialSync: "monacoToNvim" | "nvimToMonaco" | "none";
  syncModelFromMonaco: "insertOnly" | "always" | "never";
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

export function resolveOptions(
  options: MonacoNeovimOptions,
  deps: { translateKey: (ev: KeyboardEvent) => string | null },
): MonacoNeovimResolvedOptions {
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

  const initialSync = options.initialSync ?? "monacoToNvim";
  const syncModelFromMonaco = options.syncModelFromMonaco ?? (initialSync === "monacoToNvim" ? "always" : "insertOnly");

  return {
    worker: options.worker ?? null,
    workerUrl: options.workerUrl ?? new URL("./nvimWorker.worker.js", import.meta.url),
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
    seedLines: options.seedLines ?? [],
    seedFromMonaco: options.seedFromMonaco ?? true,
    seedMarkModified: options.seedMarkModified ?? false,
    initialSync,
    syncModelFromMonaco,
    // Important: avoid a non-unique default name/filetype. If callers rely on hostCommands
    // + fileSystem and run `:w` without an explicit path, a shared default can overwrite
    // unrelated documents/files.
    seedName: options.seedName ?? "",
    seedFiletype: options.seedFiletype ?? "",
    uiAttach: options.uiAttach ?? true,
    uiAttachOptions: {
      ext_cmdline: options.uiAttachOptions?.ext_cmdline ?? true,
      ext_messages: options.uiAttachOptions?.ext_messages ?? true,
      ext_popupmenu: options.uiAttachOptions?.ext_popupmenu ?? true,
      rgb: options.uiAttachOptions?.rgb ?? true,
    },
    startupCommands: options.startupCommands ?? [
      "set noswapfile signcolumn=no nonumber norelativenumber",
      "set mouse=a nowrap laststatus=0 cmdheight=1",
      "set shortmess+=F",
      ...(options.clipboard === null ? [] : ["set clipboard=unnamedplus"]),
    ],
    startupLua: options.startupLua ?? "",
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
    translateKey: options.translateKey ?? deps.translateKey,
  };
}

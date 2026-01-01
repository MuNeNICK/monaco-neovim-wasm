import type { NeovimWasmInputMode } from "./neovimWasmSession";

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

export type PopupMenuItem = { word: string; kind?: string; menu?: string; info?: string };

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
  seedFromMonaco?: boolean;
  seedMarkModified?: boolean;
  initialSync?: "monacoToNvim" | "nvimToMonaco" | "none";
  syncModelFromMonaco?: "insertOnly" | "always" | "never";
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


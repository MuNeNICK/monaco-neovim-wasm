import type { editor as MonacoEditor } from "monaco-editor";
import type { MonacoNeovimOptions } from "@monaco-neovim-wasm/lib";

export {
  MonacoNeovimClient,
  NeovimWasmSession,
  isSharedArrayBufferAvailable,
  defaultWorkerUrl,
  defaultWorkerUrlAsyncify,
} from "@monaco-neovim-wasm/lib";
export type {
  MonacoNeovimOptions,
  StatusEmitter,
  PopupMenuItem,
  ClipboardAdapter,
  FileSystemAdapter,
  HostCommand,
} from "@monaco-neovim-wasm/lib";
export type {
  NeovimWasmSessionInit,
  NeovimWasmSessionHandlers,
  NeovimWasmSessionStartOptions,
  NeovimWasmInputMode,
} from "@monaco-neovim-wasm/lib";

export declare const defaultWasmPath: string;
export declare const defaultRuntimePath: string;

export declare function createMonacoNeovim(
  editor: MonacoEditor.IStandaloneCodeEditor,
  options?: MonacoNeovimOptions,
): import("@monaco-neovim-wasm/lib").MonacoNeovimClient;

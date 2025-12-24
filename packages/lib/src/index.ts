export { MonacoNeovimClient, createMonacoNeovim } from "./monacoNeovim";
export type { MonacoNeovimOptions, StatusEmitter, PopupMenuItem, ClipboardAdapter, FileSystemAdapter, HostCommand } from "./monacoNeovim";
export { NeovimWasmSession, isSharedArrayBufferAvailable } from "./neovimWasmSession";
export type { NeovimWasmSessionInit, NeovimWasmSessionHandlers, NeovimWasmSessionStartOptions, NeovimWasmInputMode } from "./neovimWasmSession";

const resolveDistUrl = (relPath: string) => new URL(relPath, import.meta.url);

export const defaultWorkerUrl = resolveDistUrl("./nvimWorker.js");
export const defaultWorkerUrlAsyncify = resolveDistUrl("./nvimWorkerAsyncify.js");

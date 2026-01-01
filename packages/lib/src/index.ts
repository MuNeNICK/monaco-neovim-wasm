export { MonacoNeovimClient, createMonacoNeovim } from "./client/monacoNeovimClient";
export type { MonacoNeovimOptions, StatusEmitter, PopupMenuItem, ClipboardAdapter, FileSystemAdapter, HostCommand } from "./types";
export { NeovimWasmSession, isSharedArrayBufferAvailable } from "./neovimWasmSession";
export type { NeovimWasmSessionInit, NeovimWasmSessionHandlers, NeovimWasmSessionStartOptions, NeovimWasmInputMode } from "./neovimWasmSession";

// Must stay as a literal `new URL("...", import.meta.url)` so consumer bundlers
// (ex: Vite) can statically detect + copy the worker file into their build.
// The `.worker.js` suffix avoids Vite resolving to our TypeScript sources.
export const defaultWorkerUrl = new URL("./nvimWorker.worker.js", import.meta.url);
export const defaultWorkerUrlAsyncify = new URL("./nvimWorkerAsyncify.worker.js", import.meta.url);

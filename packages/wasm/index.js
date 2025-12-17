import { createMonacoNeovim as createMonacoNeovimBase, defaultWorkerUrl } from "@monaco-neovim-wasm/lib";

export {
  MonacoNeovimClient,
  NeovimWasmSession,
  isSharedArrayBufferAvailable,
  defaultWorkerUrl,
  defaultWorkerUrlAsyncify,
} from "@monaco-neovim-wasm/lib";

export const defaultWasmPath = new URL("./nvim.wasm", import.meta.url).toString();
export const defaultRuntimePath = new URL("./nvim-runtime.tar.gz", import.meta.url).toString();

export function createMonacoNeovim(editor, options = {}) {
  return createMonacoNeovimBase(editor, {
    ...options,
    searchHighlights: options.searchHighlights ?? true,
    inputMode: options.inputMode ?? "shared",
    workerUrl: options.workerUrl ?? defaultWorkerUrl,
    wasmPath: options.wasmPath ?? defaultWasmPath,
    runtimePath: options.runtimePath ?? defaultRuntimePath,
  });
}

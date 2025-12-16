export { MonacoNeovimClient, createMonacoNeovim } from "./monacoNeovim";
export type { MonacoNeovimOptions, StatusEmitter } from "./monacoNeovim";
export const defaultWorkerUrl = new URL("./nvimWorker.ts", import.meta.url);

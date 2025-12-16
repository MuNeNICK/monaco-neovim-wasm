export { MonacoNeovimClient, createMonacoNeovim } from "./monacoNeovim";
export type { MonacoNeovimOptions, StatusEmitter } from "./monacoNeovim";

// Helpful for custom bootstrapping if consumers want to control worker creation.
export const defaultWorkerUrl = new URL("./nvimWorker.ts", import.meta.url);

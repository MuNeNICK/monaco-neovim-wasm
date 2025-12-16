// Vite/rollup leave these runtime-resolved; assets are copied to dist/ in postbuild.
export const defaultWasmPath = /* @vite-ignore */ new URL("./nvim.wasm", import.meta.url).toString();
export const defaultRuntimePath = /* @vite-ignore */ new URL("./nvim-runtime.tar.gz", import.meta.url).toString();

import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const wasmPublicDir = fileURLToPath(new URL("../../packages/wasm-async", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: wasmPublicDir,
  server: {
    port: 4173,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  optimizeDeps: {
    exclude: ["@monaco-neovim-wasm/lib"],
  },
  worker: {
    format: "es",
  },
});


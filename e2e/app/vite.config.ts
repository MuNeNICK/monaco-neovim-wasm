import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: {
    port: 4173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: ".e2e-dist",
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ["@monaco-neovim-wasm/wasm-async", "@monaco-neovim-wasm/lib"],
  },
  worker: {
    format: "es",
  },
});

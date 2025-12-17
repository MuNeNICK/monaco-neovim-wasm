import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    exclude: ["@monaco-neovim-wasm/wasm-async", "@monaco-neovim-wasm/lib"],
  },
  server: {
    port: 8080,
  },
  preview: {
    port: 8080,
  },
  worker: {
    format: "es",
  },
});

import { defineConfig } from "vite";

const crossOriginHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  optimizeDeps: {
    exclude: ["monaco-neovim-wasm"],
  },
  server: {
    port: 8080,
    headers: crossOriginHeaders,
  },
  preview: {
    port: 8080,
    headers: crossOriginHeaders,
  },
  worker: {
    format: "es",
  },
});

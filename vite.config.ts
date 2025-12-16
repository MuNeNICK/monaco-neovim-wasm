import { defineConfig } from "vite";

const crossOriginHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  server: {
    port: 8080,
    headers: crossOriginHeaders,
  },
  preview: {
    port: 8080,
    headers: crossOriginHeaders,
  },
  build: {
    target: "esnext",
    lib: {
      entry: "src/index.ts",
      name: "monacoNeovimWasm",
      formats: ["es"],
      fileName: (format) => `monaco-neovim-wasm.${format}.js`,
    },
    rollupOptions: {
      external: ["monaco-editor"],
    },
  },
  worker: {
    format: "es",
  },
});

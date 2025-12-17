import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext",
    emptyOutDir: true,
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


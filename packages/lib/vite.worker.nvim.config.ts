import { defineConfig } from "vite";

// Build a self-contained worker (no extra chunks) so bundlers can copy the
// worker file without needing to understand its internal imports.
export default defineConfig({
  build: {
    target: "esnext",
    emptyOutDir: false,
    lib: {
      entry: "src/nvimWorker.ts",
      formats: ["es"],
      fileName: () => "nvimWorker.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});

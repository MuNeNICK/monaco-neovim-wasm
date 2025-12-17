import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext",
    emptyOutDir: false,
    lib: {
      entry: "src/nvimWorker.ts",
      formats: ["es"],
      fileName: () => "nvimWorker.js",
    },
  },
});

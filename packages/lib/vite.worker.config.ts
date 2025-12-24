import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext",
    emptyOutDir: false,
    lib: {
      entry: {
        nvimWorker: "src/nvimWorker.ts",
        nvimWorkerAsyncify: "src/nvimWorkerAsyncify.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => (
        entryName === "nvimWorkerAsyncify" ? "nvimWorkerAsyncify.worker.js" : "nvimWorker.worker.js"
      ),
    },
  },
});

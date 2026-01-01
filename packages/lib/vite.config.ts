import { createLogger, defineConfig } from "vite";

export default defineConfig({
  customLogger: (() => {
    const base = createLogger();
    return {
      ...base,
      warn(msg, opts) {
        const text = String(msg ?? "");
        if (/new URL\(\"\.\/nvimWorker(Asyncify)?\.worker\.js\", import\.meta\.url\) doesn't exist at build time/.test(text)) {
          return;
        }
        base.warn(msg, opts);
      },
      warnOnce(msg, opts) {
        const text = String(msg ?? "");
        if (/new URL\(\"\.\/nvimWorker(Asyncify)?\.worker\.js\", import\.meta\.url\) doesn't exist at build time/.test(text)) {
          return;
        }
        base.warnOnce(msg, opts);
      },
    };
  })(),
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

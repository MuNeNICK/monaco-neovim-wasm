import { defineConfig } from "vite";

export default defineConfig({
  // Use relative asset URLs so the demo works when hosted under a subpath (e.g. Cloudflare Pages).
  base: "./",
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

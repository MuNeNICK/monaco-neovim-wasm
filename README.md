# monaco-neovim-wasm

Run the actual Neovim core (WASM, headless) behind Monaco. This is inspired by `monaco-vim`, but uses Neovim's native msgpack-RPC instead of a keybinding shim.

## Quick start
1) Build WASM + runtime from `./nvim-wasm`:
```sh
npm run build:assets
```
2) Install deps and run:
```sh
cd monaco-neovim-wasm
npm install
npm run dev
```
3) Open http://localhost:8080, press `i`, type. Vim toggle is in the top bar.
4) Serve with COOP/COEP so `SharedArrayBuffer` works (dev server already does).

## Usage in code
```ts
import * as monaco from "monaco-editor";
import "monaco-editor/min/vs/editor/editor.main.css";
import { createMonacoNeovim } from "./src";

const editor = monaco.editor.create(document.getElementById("root")!, { language: "lua", readOnly: true });
const client = createMonacoNeovim(editor, {
  wasmPath: "/nvim.wasm",
  runtimePath: "/nvim-runtime.tar.gz",
  status: (text, warn) => console.log(warn ? "WARN" : "OK", text),
});
await client.start();
```
- `client.stop()` tears down the worker; `client.dispose()` cleans up listeners.
- Custom worker URLs are supported via `workerUrl`/`worker` options; `defaultWorkerUrl` is exported from `src/index.ts`.

## Cross-origin isolation
- The transport now uses `SharedArrayBuffer` for main-thread → worker input, so pages must be `crossOriginIsolated`.
- Serve with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (and ensure subresources are CORP/CORS compatible). The Vite dev/preview servers already send these headers.
- Neovim clipboard calls go through the browser Clipboard API; a prompt is used as a fallback.
- The demo sets Neovim options for a minimal UI (`noswapfile`, `norelativenumber`, etc.) and seeds a Lua buffer; adjust in `src/monacoNeovim.ts` if needed.

# monaco-neovim-wasm

Run the actual Neovim core (WASM, headless) behind Monaco. This is inspired by `monaco-vim`, but uses Neovim's native msgpack-RPC instead of a keybinding shim.

## Usage in code
```ts
import * as monaco from "monaco-editor";
import "monaco-editor/min/vs/editor/editor.main.css";
import { createMonacoNeovim } from "monaco-neovim-wasm";

const editor = monaco.editor.create(document.getElementById("root")!, { language: "lua", readOnly: true });
const client = createMonacoNeovim(editor, { status: (text, warn) => console.log(warn ? "WARN" : "OK", text) });
await client.start();
```
- `monaco-editor` is a peer dependency; install it in your app.
- `client.stop()` tears down the worker; `client.dispose()` cleans up listeners.
- Convenience helpers: `client.input(keys)` / `client.paste(text)` / `client.execLua(code)` / `client.command(cmd)`.
- Default behavior auto-resizes Neovim UI to the Monaco viewport; disable via `autoResize: false`.
- Custom worker URLs are supported via `workerUrl`/`worker` options; `defaultWorkerUrl` is exported.
- Cmdline display: provide `onCmdline` (or set `cmdlineContainer: null` to disable the built-in overlay).
- Messages/popupmenu: use `onMessage`/`onPopupmenu` (or rely on the built-in overlays).
- If you need to reserve specific shortcuts for the host app, use `shouldHandleKey`.
- If you host assets separately, set `wasmPath`/`runtimePath`.
- To customize startup, use `startupCommands` / `startupLua`, and seed via `seedLines` / `seedFiletype` / `seedName`.
- Clipboard can be customized or disabled with `clipboard` (or set `clipboard: null`).

## Session-only (non-Monaco) usage
If you want a reusable building block for other editors (or headless automation), use `NeovimWasmSession`:
```ts
import { NeovimWasmSession, defaultWorkerUrl } from "monaco-neovim-wasm";

const session = new NeovimWasmSession({
  workerUrl: defaultWorkerUrl,
  handlers: { onNotify: (m, p) => console.log("notify", m, p) },
});
await session.start({ cols: 120, rows: 40, wasmPath: "/nvim.wasm", runtimePath: "/nvim-runtime.tar.gz" });
await session.waitForApi();
await session.call("nvim_command", ["echo 'hello'"]);
```

## Demo
The demo is a separate package under `demo/` and is meant to run against the published `monaco-neovim-wasm` package.

```sh
cd demo
npm install
npm run dev
```

Open http://localhost:8080, press `i`, type. Vim toggle is in the top bar.
If Vite errors with `431`, clear `localhost` cookies or use http://127.0.0.1:8080.

## Build (maintainers)
Build the bundled Neovim WASM + runtime from `./nvim-wasm` and produce `dist/` for publishing:

```sh
npm run build:assets
npm run build
```

## Cross-origin isolation
- The transport now uses `SharedArrayBuffer` for main-thread → worker input, so pages must be `crossOriginIsolated`.
- Serve with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (and ensure subresources are CORP/CORS compatible). The demo's Vite dev/preview servers send these headers.
- Neovim clipboard calls go through the browser Clipboard API; a prompt is used as a fallback.
- The demo sets Neovim options for a minimal UI (`noswapfile`, `norelativenumber`, etc.) and seeds a Lua buffer; adjust in `src/monacoNeovim.ts` if needed.

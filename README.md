# monaco-neovim-wasm

Run the actual Neovim core (WASM, headless) behind Monaco, using Neovim's native msgpack-RPC instead of a keybinding shim.

## Packages
- `@monaco-neovim-wasm/wasm`: normal build (SharedArrayBuffer; requires COOP/COEP)
- `@monaco-neovim-wasm/wasm-async`: asyncify build (postMessage input; no COOP/COEP)
- `@monaco-neovim-wasm/lib`: core API (bring your own `wasmPath`/`runtimePath`)

## Usage in code
```ts
import * as monaco from "monaco-editor";
import "monaco-editor/min/vs/editor/editor.main.css";
import { createMonacoNeovim } from "@monaco-neovim-wasm/wasm";

const editor = monaco.editor.create(document.getElementById("root")!, { language: "lua", readOnly: true });
const client = createMonacoNeovim(editor, { status: (text, warn) => console.log(warn ? "WARN" : "OK", text) });
await client.start();
```
- If you cannot (or don't want to) enable COOP/COEP, use the asyncify build instead:
  - `import { createMonacoNeovim } from "@monaco-neovim-wasm/wasm-async";`
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
- For accurate wrapped-motion like `gj`/`gk`/`g0`/`g$`, enable Neovim `set wrap` and set `syncWrap: true` + `wrappedLineMotions: true` (uses Monaco wrapped-line movement as a workaround).
- For scroll/reveal motions like `zt`/`zz`/`zb` (and cursor-to-screen-line `H`/`M`/`L`), set `scrollMotions: true` (delegates viewport positioning to Monaco and optionally moves cursor for `z<CR>`/`z.`/`z-`). It also provides delegated scroll keys `<C-e>/<C-y>/<C-d>/<C-u>/<C-f>/<C-b>` for wrap-friendly scrolling.
- `scrolloff`: when set, enforces a Vim-like scroll margin on the Monaco viewport (in screen lines).
- `syncScrolloff`: when `true`, mirrors Neovim’s `:set scrolloff?` into Monaco (defaults to `true` when `scrollMotions: true`).
- Reserved Monaco shortcuts: the library captures `Ctrl+F/B/D/U/E/Y` in the capture phase (when not delegating insert-mode to Monaco) so Vim scrolling works even if Monaco has default bindings.
- `ctrlKeysForNormalMode` / `ctrlKeysForInsertMode`: optional allowlists for `Ctrl+key`. When set, only listed `Ctrl` combinations are forwarded to Neovim; others are left for Monaco/browser. (Browser-reserved shortcuts like `Ctrl+W` may still win.)
- `altKeysForNormalMode` / `altKeysForInsertMode`: optional allowlists for `Alt+key` (same behavior as the Ctrl allowlists).
- `metaKeysForNormalMode` / `metaKeysForInsertMode`: optional allowlists for `Meta(Command)+key` (same behavior as the Ctrl allowlists).
- `searchHighlights`: when `true`, renders Neovim search highlights as Monaco decorations in the visible viewport (persistent highlights follow `:set hlsearch`, and incremental highlights appear while typing `/` or `?`).
- `hostCommands`: when `true`, sources `$HOME/.config/nvim/monaco-neovim-wasm/host-commands.vim` and enables `:e/:w/:q`-style delegation to the host.
- `fileSystem`: optional adapter used by the built-in host-command handler to implement `:e` and `:w` without wiring `onHostCommand`.
- `onHostCommand`: optional callback that receives host commands like `{ action: "edit", path }` / `{ action: "write", path }`.
- Multiple buffers: when Neovim switches buffers (e.g. `:bnext`, `:bprev`, `:buffer`), the client swaps the Monaco model accordingly.

## Loading Vimscript overrides
This package keeps host-aware mappings as Vimscript, but still ships as a single JS dependency by embedding those `.vim` files into Neovim’s in-memory filesystem and sourcing them when needed.

Built-in overrides are mounted at `$HOME/.config/nvim/monaco-neovim-wasm/motion.vim` and `$HOME/.config/nvim/monaco-neovim-wasm/scrolling.vim`.

You can also provide your own overrides by placing files into the in-memory FS and `:source`-ing them via startup hooks:
```ts
const client = createMonacoNeovim(editor, {
  files: [
    {
      // becomes /nvim/home/.config/nvim/overrides.vim inside Neovim
      path: "home/.config/nvim/overrides.vim",
      data: `
nnoremap gj <Cmd>call rpcnotify(g:monaco_neovim_wasm_chan, "monaco_cursorMove", { "to": "down", "by": "wrappedLine", "value": v:count1 })<CR>
`,
    },
  ],
  startupCommands: [
    "source $HOME/.config/nvim/overrides.vim",
  ],
});
```
Note: Neovim is launched with `-u NORC --noplugin`, so it won’t auto-load your config unless you explicitly `:source` it.

## Session-only (non-Monaco) usage
If you want a reusable building block for other editors (or headless automation), use `NeovimWasmSession`:
```ts
import { NeovimWasmSession, defaultWorkerUrl, defaultWasmPath, defaultRuntimePath } from "@monaco-neovim-wasm/wasm";

const session = new NeovimWasmSession({
  workerUrl: defaultWorkerUrl,
  handlers: { onNotify: (m, p) => console.log("notify", m, p) },
});
await session.start({ cols: 120, rows: 40, wasmPath: defaultWasmPath, runtimePath: defaultRuntimePath });
await session.waitForApi();
await session.call("nvim_command", ["echo 'hello'"]);
```

Asyncify (SAB-free) session usage:
```ts
import { NeovimWasmSession, defaultWorkerUrlAsyncify, defaultWasmPath, defaultRuntimePath } from "@monaco-neovim-wasm/wasm-async";

const session = new NeovimWasmSession({ workerUrl: defaultWorkerUrlAsyncify, inputMode: "message" });
await session.start({ cols: 120, rows: 40, wasmPath: defaultWasmPath, runtimePath: defaultRuntimePath, inputMode: "message" });
```

## Demo
The demo is a separate package under `demo/` and is meant to run against the published `@monaco-neovim-wasm/*` packages.

```sh
cd demo
npm install
npm run dev
```

Open http://localhost:8080, press `i`, type. Vim toggle is in the top bar.
If Vite errors with `431`, clear `localhost` cookies or use http://127.0.0.1:8080.

## Build (maintainers)
Build the bundled Neovim WASM + runtime from `./nvim-wasm` and produce outputs for publishing:

```sh
npm run build:assets
npm run build
```

## Cross-origin isolation
- `@monaco-neovim-wasm/wasm` uses `SharedArrayBuffer` for main-thread → worker input, so pages must be `crossOriginIsolated` (COOP/COEP).
- `@monaco-neovim-wasm/wasm-async` uses `postMessage` input and does not require COOP/COEP.
- Neovim clipboard calls go through the browser Clipboard API; a prompt is used as a fallback.
- The demo sets Neovim options for a minimal UI (`noswapfile`, `norelativenumber`, etc.) and seeds a Lua buffer; adjust in `packages/lib/src/monacoNeovim.ts` if needed.

## Vite notes
- If you use Vite, add the used packages to `optimizeDeps.exclude` (example: `@monaco-neovim-wasm/wasm-async` and `@monaco-neovim-wasm/lib`) so `import.meta.url` URLs for the worker/wasm files resolve correctly.

## Acknowledgements
- https://github.com/brijeshb42/monaco-vim
- https://github.com/vscode-neovim/vscode-neovim

# Usage

## Pick a package

- `@monaco-neovim-wasm/wasm`: SharedArrayBuffer input (requires COOP/COEP; `crossOriginIsolated === true`)
- `@monaco-neovim-wasm/wasm-async`: Asyncify build + `postMessage` input (no COOP/COEP required)
- `@monaco-neovim-wasm/lib`: core APIs (bring your own `wasmPath`/`runtimePath`)

## Install

`monaco-editor` is a peer dependency.

```sh
npm i monaco-editor @monaco-neovim-wasm/wasm
```

## Minimal example

```ts
import * as monaco from "monaco-editor";
import "monaco-editor/min/vs/editor/editor.main.css";
import { createMonacoNeovim } from "@monaco-neovim-wasm/wasm";

const editor = monaco.editor.create(document.getElementById("root")!, {
  language: "lua",
  readOnly: true,
});
const client = createMonacoNeovim(editor, {
  status: (text, warn) => console.log(warn ? "WARN" : "OK", text),
});
await client.start();
```

If you cannot (or don't want to) enable COOP/COEP, use the asyncify package instead:

```ts
import { createMonacoNeovim } from "@monaco-neovim-wasm/wasm-async";
```

## API basics

- Lifecycle: `await client.start()` / `client.stop()` / `client.dispose()`
- Convenience helpers: `client.input(keys)` / `client.type(text)` / `client.paste(text)` / `client.execLua(code)` / `client.command(cmd)`
- Session-only (non-Monaco): use `NeovimWasmSession` (see "Session-only usage" below)

## Common options

### Assets / worker

- `wasmPath` / `runtimePath`: override the shipped asset URLs (required when using `@monaco-neovim-wasm/lib`)
- `workerUrl` / `worker`: customize how the Neovim worker is created
- `reuseWorker`: reuse the existing worker between `start()` calls

### Input mode

- `inputMode: "shared"`: faster input via `SharedArrayBuffer` (requires `crossOriginIsolated`)
- `inputMode: "message"`: SAB-free input via `postMessage` (default for `wasm-async`)

### UI / overlays

- `autoResize`: track Monaco viewport size and call `nvim_ui_try_resize`
- `uiAttach` / `uiAttachOptions`: control `nvim_ui_attach` and ext_* features
- `onCmdline` / `cmdlineContainer`: cmdline overlay control
- `onMessage`: messages overlay control
- `onPopupmenu`: popupmenu overlay control

### Key handling

- `shouldHandleKey(ev)`: reserve host shortcuts (return `false` to let Monaco/browser handle it)
- `ctrlKeysForNormalMode` / `ctrlKeysForInsertMode`: allowlist `Ctrl+key` forwarding
- `altKeysForNormalMode` / `altKeysForInsertMode`: allowlist `Alt+key` forwarding
- `metaKeysForNormalMode` / `metaKeysForInsertMode`: allowlist `Meta(Command)+key` forwarding
- `translateKey(ev)`: override key → Neovim `<...>` translation
- Note: a literal `<` must be sent as `<lt>` (the default `translateKey` handles this).
- Note: use `shouldHandleKey` / `*KeysFor*Mode` to keep host shortcuts like paste (`Ctrl+V`) working.
- Note: `client.input(keys)` expects Neovim key notation; to send literal text use `client.type(text)` (it escapes `<` and wraps newlines as `<CR>`).

#### Recommended Ctrl allowlist defaults

These are balanced defaults (Normal/Visual/Operator vs Insert):
`Ctrl+V` works as visual-block in non-insert modes, while insert-mode paste stays available by default.

```ts
const ctrlKeysForNormalMode = [
  "a","b","c","d","e","f","h","i","j","k","l","m","o","r","t","u","v","w","x","y","z",
  "/",
  "]",
  "right","left","up","down",
  "backspace","delete",
];
const ctrlKeysForInsertMode = ["a","c","d","h","j","m","o","r","t","u","w"];

const client = createMonacoNeovim(editor, { ctrlKeysForNormalMode, ctrlKeysForInsertMode });
```

### Wrapped lines / scrolling

These features delegate some "screen line / viewport" behavior to Monaco for better wrapped-line behavior:

- `syncWrap`: apply Monaco wrapping based on the current grid width
- `wrappedLineMotions`: `gj/gk/g0/g$` delegation (implemented via Vimscript overrides)
- `scrollMotions`: `zt/zz/zb`, `H/M/L`, and `<C-e>/<C-y>/<C-d>/<C-u>/<C-f>/<C-b>` delegation
- `scrolloff`: enforce a Vim-like scroll margin on the Monaco viewport (in screen lines)
- `syncScrolloff`: mirror Neovim `:set scrolloff?` into Monaco

### Search highlights

- `searchHighlights`: render Neovim search highlights as Monaco decorations (visible viewport)

### Clipboard (yank / paste)

- By default, yanks to `"+`/`"*` are bridged to the browser clipboard (Clipboard API), so they can be pasted into the OS.
- If `navigator.clipboard` is unavailable, a best-effort legacy copy fallback is used.
- You can override clipboard behavior via `clipboard: { readText, writeText }`, or disable it with `clipboard: null`.

### Host commands (`:e`, `:w`, `:q`)

Enable "host-delegated" file commands:

- `hostCommands: true`: sources `$HOME/.config/nvim/monaco-neovim-wasm/host-commands.vim` inside the in-memory FS
- `onHostCommand(cmd)`: handle actions like `{ action: "edit", path }` / `{ action: "write", path }`
- `fileSystem`: optional adapter used by the built-in host-command handler (`readFile` / `writeFile`)

Notes:
- This is delegation, not a full POSIX filesystem; see [Architecture](./architecture.md) for how the runtime FS works.
- `wq`/`q` require host behavior (close the tab/editor) via `onHostCommand`.

### Multiple buffers

When Neovim switches buffers (`:bnext`, `:buffer`, …), the client swaps Monaco models accordingly.

## Loading Vimscript overrides

Built-in overrides are mounted in the in-memory FS at:

- `$HOME/.config/nvim/monaco-neovim-wasm/motion.vim`
- `$HOME/.config/nvim/monaco-neovim-wasm/scrolling.vim`
- `$HOME/.config/nvim/monaco-neovim-wasm/host-commands.vim`

You can provide additional overrides via `files` + startup hooks:

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
  startupCommands: ["source $HOME/.config/nvim/overrides.vim"],
});
```

Neovim is launched with `-u NORC --noplugin`, so it won't auto-load your config unless you explicitly `:source` it.

## Session-only usage

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

## Vite notes

If you use Vite, exclude used packages from pre-bundling so `import.meta.url` asset URLs resolve correctly:

```ts
// vite.config.ts
export default {
  optimizeDeps: {
    exclude: ["@monaco-neovim-wasm/wasm-async", "@monaco-neovim-wasm/lib"],
  },
};
```

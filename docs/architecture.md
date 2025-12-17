# Architecture

This project runs Neovim (headless) compiled to WASM in a Web Worker, and connects it to Monaco via Neovim's native msgpack-RPC protocol (no "keybinding shim").

## Components

### `MonacoNeovimClient`

High-level integration:

- Owns Monaco listeners (keyboard/mouse/model changes)
- Owns a `NeovimWasmSession`
- Translates input events into `nvim_input` / `nvim_paste` / RPC calls
- Applies buffer updates from Neovim to Monaco models
- Provides optional overlays: cmdline, messages, popupmenu, preedit (IME)
- Implements "delegation" features (wrapped-line motions, scroll motions, scrolloff, search highlights)

### `NeovimWasmSession`

Transport + lifecycle:

- Creates (or reuses) a worker and starts Neovim inside it
- Implements msgpack-RPC request/response/notify
- Supports two input strategies:
  - `inputMode: "shared"`: ring buffer in `SharedArrayBuffer` (fast, requires COOP/COEP)
  - `inputMode: "message"`: `postMessage` input (SAB-free; used by asyncify build)

### Worker (`nvimWorker` / `nvimWorkerAsyncify`)

Runtime inside a Web Worker:

- Fetches the `nvim.wasm` module and `nvim-runtime.tar(.gz)` archive
- Unpacks the runtime into an in-memory filesystem used by WASI
- Starts Neovim with WASI (`--headless --embed -u NORC --noplugin`)
- Reads msgpack-RPC frames from Neovim stdout and forwards them to the main thread

## Filesystem model

At startup, the worker:

1. Fetches `runtimePath` (a tar or tar.gz)
2. Untars it into an in-memory FS
3. Ensures a minimal `$HOME` layout:
   - `/nvim/home/.config`
   - `/nvim/home/.local/share`
   - `/nvim/home/.local/state`
   - `/nvim/tmp`
4. Optionally overlays user-provided `files` (virtual files you want to `:source`, etc.)

This is not a "real" host filesystem; it's a virtual FS that exists inside the worker.

## RPC flow (msgpack-RPC)

Neovim talks msgpack-RPC over stdio (`--embed`):

- Main thread → worker: input bytes + RPC calls
- Worker → main thread: decoded msgpack messages:
  - `rpc-notify`
  - `rpc-request` (rare; e.g. clipboard paste request)
  - `rpc-response`

`MonacoNeovimClient` consumes notify events like:

- `nvim_buf_lines_event`: apply incremental line patches to Monaco models
- `redraw`: update overlays (cmdline/messages/popupmenu) and mode changes

## Key handling & IME

The client translates browser key events to Neovim key strings (e.g. `<C-f>`, `<Esc>`) via `translateKey`.

IME composition is handled carefully:

- Monaco remains editable (`readOnly: false`) so IME works
- During composition, the client avoids mutating the Monaco model from Neovim events
- Optionally, insert-mode typing is delegated to Monaco and later synced back to Neovim (IME-friendly)

## Multi-buffer mapping

When Neovim changes buffers, the client:

- Creates/updates a Monaco model for the Neovim buffer id
- Switches the editor model
- Keeps a name→buffer map to support host command helpers (`:e` / `:w`)

## Vimscript overrides (host-aware mappings)

Some behaviors are easier (and more compatible) as Vimscript:

- Wrapped line motions: `gj/gk/g0/g$`
- Scroll/reveal motions: `zt/zz/zb`, `H/M/L`, scroll keys
- Host commands: `:e/:w/:q/:wq` delegation (`MonacoEdit/MonacoWrite/...`)

These `.vim` files are embedded into the virtual FS and sourced on startup when enabled.

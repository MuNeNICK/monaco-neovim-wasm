# @monaco-neovim-wasm/wasm

Batteries-included package: ships `nvim.wasm` + `nvim-runtime.tar.gz` and re-exports `@monaco-neovim-wasm/lib` with defaults wired for SharedArrayBuffer input (COOP/COEP).

Defaults:
- `searchHighlights: true` (pass `false` to disable)
- `wrappedLineMotions: true` (pass `false` to disable)
- `scrollMotions: true` (pass `false` to disable)
- `syncScrolloff: true` (pass `false` to disable)

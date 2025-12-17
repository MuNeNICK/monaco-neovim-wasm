# Development

## Build assets (maintainers)

Build the bundled Neovim WASM + runtime from `./nvim-wasm` and produce outputs for publishing:

```sh
npm run build:assets
npm run build
```

## Cross-origin isolation

- `@monaco-neovim-wasm/wasm` uses `SharedArrayBuffer` for main-thread → worker input, so pages must be `crossOriginIsolated` (COOP/COEP).
- `@monaco-neovim-wasm/wasm-async` uses `postMessage` input and does not require COOP/COEP.
- Neovim clipboard calls go through the browser Clipboard API; a prompt is used as a fallback.


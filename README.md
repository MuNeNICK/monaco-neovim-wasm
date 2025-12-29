# monaco-neovim-wasm

Run the actual Neovim core (WASM, headless) behind Monaco, using Neovim's native msgpack-RPC instead of a keybinding shim.

Docs: `docs/README.md`

## Install
```sh
# Works without COOP/COEP:
npm i monaco-editor @monaco-neovim-wasm/wasm-async

# Faster input (requires COOP/COEP / crossOriginIsolated):
# npm i monaco-editor @monaco-neovim-wasm/wasm
```

## Quick start
```ts
import * as monaco from "monaco-editor";
import "monaco-editor/min/vs/editor/editor.main.css";
import { createMonacoNeovim } from "@monaco-neovim-wasm/wasm-async";

const editor = monaco.editor.create(document.getElementById("root")!, { language: "lua" });
const client = createMonacoNeovim(editor);
await client.start();
```

- You must also configure Monaco's web worker in your bundler/app; see `demo/` or `docs/usage.md`.
- For `SharedArrayBuffer` input (requires COOP/COEP), switch to `@monaco-neovim-wasm/wasm`.
- If your editor is externally bound (e.g. Yjs/CRDT), see "Sync strategy (Monaco ↔ Neovim)" in `docs/usage.md`.

## Packages
- `@monaco-neovim-wasm/wasm`: normal build (SharedArrayBuffer; requires COOP/COEP)
- `@monaco-neovim-wasm/wasm-async`: asyncify build (postMessage input; no COOP/COEP)
- `@monaco-neovim-wasm/lib`: core API (bring your own `wasmPath`/`runtimePath`)

## Links
- Usage: `docs/usage.md`
- Architecture: `docs/architecture.md`
- Demo: `docs/demo.md`
- Development: `docs/development.md`

## Acknowledgements
- https://github.com/brijeshb42/monaco-vim
- https://github.com/vscode-neovim/vscode-neovim

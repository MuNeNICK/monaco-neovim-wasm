# Demo

The demo is a separate package under `demo/` and is meant to run against the published `@monaco-neovim-wasm/*` packages.

```sh
cd demo
npm install
npm run dev
```

Open http://localhost:8080, press `i`, type. Vim toggle is in the top bar.

If Vite errors with `431`, clear `localhost` cookies or use http://127.0.0.1:8080.


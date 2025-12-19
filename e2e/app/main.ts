import * as monaco from "monaco-editor";
import "monaco-editor/min/vs/editor/editor.main.css";
import { createMonacoNeovim } from "../../packages/lib/src";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker&url";

(self as any).MonacoEnvironment = {
  getWorker: () => new Worker(editorWorker, { type: "module" }),
  getWorkerUrl: () => editorWorker as string,
};

type StatusEl = HTMLElement & { className: string };

const statusEl = document.getElementById("status") as StatusEl | null;
const modeEl = document.getElementById("mode") as HTMLElement | null;
const editorHost = document.getElementById("editor") as HTMLElement | null;

if (!statusEl || !modeEl || !editorHost) {
  throw new Error("e2e app nodes missing");
}

const editor = monaco.editor.create(editorHost, {
  value: "",
  language: "lua",
  theme: "vs-dark",
  fontSize: 14,
  readOnly: false,
  minimap: { enabled: false },
  automaticLayout: true,
});

const client = createMonacoNeovim(editor, {
  worker: new Worker(new URL("../../packages/lib/src/nvimWorkerAsyncify.ts", import.meta.url), { type: "module" }),
  inputMode: "message",
  wasmPath: "/nvim-asyncify.wasm",
  runtimePath: "/nvim-runtime.tar.gz",
  status: (text: string, warn?: boolean) => {
    statusEl.textContent = warn ? `WARN: ${text}` : text;
  },
  onModeChange: (mode: string) => { modeEl.textContent = `mode: ${mode}`; },
});

(window as any).nvimClient = client;

async function start() {
  statusEl.textContent = "starting...";
  try {
    await client.start([]);
    statusEl.textContent = "ready";
  } catch (err) {
    statusEl.textContent = `start failed: ${(err as Error)?.message ?? err}`;
  }
}

void start();


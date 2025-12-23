import * as monaco from "monaco-editor";
import "monaco-editor/min/vs/editor/editor.main.css";
import { createMonacoNeovim } from "@monaco-neovim-wasm/wasm-async";
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
  // Avoid flaky <Enter> behavior in delegated insert: Monaco suggestions can
  // steal Enter and change the resulting buffer in ways unrelated to Neovim.
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  acceptSuggestionOnEnter: "off",
  minimap: { enabled: false },
  automaticLayout: true,
});
editor.focus();

function setStatus(text: string, warn = false) {
  statusEl.textContent = String(text ?? "");
  statusEl.className = warn ? "warn" : "ok";
}

const client = createMonacoNeovim(editor, {
  status: setStatus,
  onModeChange: (mode: string) => { modeEl.textContent = `mode: ${mode}`; },
});

(window as any).nvimClient = client;
(window as any).monacoEditor = editor;

async function start() {
  setStatus("starting...", false);
  try {
    await client.start([]);
    setStatus("ready", false);
    editor.focus();
  } catch (err) {
    setStatus(`start failed: ${(err as Error)?.message ?? err}`, true);
  }
}

void start();

import * as monaco from "monaco-editor";
import "monaco-editor/min/vs/editor/editor.main.css";
import { createMonacoNeovim } from "@monaco-neovim-wasm/wasm-async";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker&url";

(self as any).MonacoEnvironment = {
  getWorker: () => new Worker(editorWorker, { type: "module" }),
  getWorkerUrl: () => editorWorker as string,
};

type StatusEl = HTMLElement & { className: string };

const statusEl = document.getElementById("status") as StatusEl;
const modeEl = document.getElementById("mode") as HTMLElement;
const editorHost = document.getElementById("editor") as HTMLElement;
const toggleBtn = document.getElementById("toggle") as HTMLButtonElement | null;

if (!statusEl || !modeEl || !editorHost) {
  throw new Error("demo nodes missing");
}

const editor = monaco.editor.create(editorHost, {
  value: "",
  language: "lua",
  theme: "vs-dark",
  fontSize: 14,
  fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular",
  readOnly: false,
  minimap: { enabled: false },
  automaticLayout: true,
  smoothScrolling: true,
  scrollBeyondLastLine: false,
  padding: { top: 12, bottom: 12 },
  cursorSmoothCaretAnimation: "on",
});
const baseCursorStyle = editor.getOption(monaco.editor.EditorOption.cursorStyle) as unknown as monaco.editor.IStandaloneEditorConstructionOptions["cursorStyle"];
const baseCursorBlink = editor.getOption(monaco.editor.EditorOption.cursorBlinking) as unknown as monaco.editor.IStandaloneEditorConstructionOptions["cursorBlinking"];
const baseCursorWidth = editor.getOption(monaco.editor.EditorOption.cursorWidth);
const baseReadOnly = editor.getOption(monaco.editor.EditorOption.readOnly);
editor.onDidChangeModelContent(() => {
  const snapshot = editor.getModel()?.getValue().split(/\r?\n/) ?? null;
  if (snapshot && snapshot.length) cachedLines = snapshot;
});

const client = createMonacoNeovim(editor, {
  status: (text: string, warn?: boolean) => setStatus(text, !!warn),
  onModeChange: (mode: string) => { modeEl.textContent = `mode: ${mode}`; },
});

let starting = false;
let vimEnabled = true;
let cachedLines: string[] | null = null;

async function start() {
  if (starting) return;
  if (!vimEnabled) return;
  starting = true;
  setStatus("starting...");
  try {
    const seed = (cachedLines && cachedLines.some((l) => l.length > 0))
      ? cachedLines
      : undefined;
    await client.start(seed);
    setStatus("ready");
  } catch (err) {
    setStatus(`start failed: ${(err as Error)?.message ?? err}`, true);
  } finally {
    starting = false;
  }
}

function stop() {
  client.stop();
  setStatus("stopped", true);
  modeEl.textContent = "mode: -";
  const snapshot = editor.getModel()?.getValue().split(/\r?\n/) ?? null;
  cachedLines = snapshot && snapshot.some((l) => l.length > 0) ? snapshot : cachedLines;
  editor.updateOptions({
    readOnly: baseReadOnly,
    cursorStyle: baseCursorStyle,
    cursorBlinking: baseCursorBlink,
    cursorWidth: baseCursorWidth,
  });
}

function setStatus(text: string, warn = false) {
  statusEl.textContent = text;
  statusEl.className = warn ? "warn" : "ok";
}

void start();

function toggleVim() {
  vimEnabled = !vimEnabled;
  if (toggleBtn) toggleBtn.textContent = vimEnabled ? "Vim: on" : "Vim: off";
  if (vimEnabled) {
    void start();
  } else {
    stop();
  }
}

toggleBtn?.addEventListener("click", () => toggleVim());

(window as any).nvimClient = client;

import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

import type { BufferState } from "./bufferSync";

export type BufferManagerInit = {
  editor: MonacoEditor.IStandaloneCodeEditor;
};

export class BufferManager {
  private readonly editor: MonacoEditor.IStandaloneCodeEditor;
  private readonly buffers = new Map<number, BufferState>();
  private readonly buffersByName = new Map<string, number>();

  constructor(init: BufferManagerInit) {
    this.editor = init.editor;
  }

  getById(id: number): BufferState | null {
    return this.buffers.get(id) ?? null;
  }

  getIdByName(name: string): number | null {
    const n = String(name ?? "");
    if (!n) return null;
    return this.buffersByName.get(n) ?? null;
  }

  getActiveState(bufHandle: number | null): BufferState | null {
    if (!bufHandle) return null;
    return this.buffers.get(bufHandle) ?? null;
  }

  ensureState(bufHandle: number | null): BufferState | null {
    if (!bufHandle) return null;
    const model = this.editor.getModel();
    if (!model) return null;
    const existing = this.buffers.get(bufHandle);
    if (existing) {
      if (existing.model !== model) {
        existing.model = model;
        existing.createdModel = false;
      }
      return existing;
    }
    const state: BufferState = {
      id: bufHandle,
      name: "",
      filetype: "",
      model,
      createdModel: false,
      shadowLines: null,
      pendingBufEdits: [],
      pendingFullSync: false,
      pendingCursorSync: false,
    };
    this.buffers.set(state.id, state);
    return state;
  }

  clear(): void {
    for (const state of this.buffers.values()) {
      if (state.createdModel) {
        try { state.model.dispose(); } catch (_) {}
      }
    }
    this.buffers.clear();
    this.buffersByName.clear();
  }

  detach(id: number): void {
    const state = this.buffers.get(id);
    if (!state) return;
    if (state.name) this.buffersByName.delete(state.name);
    if (state.createdModel) {
      try { state.model.dispose(); } catch (_) {}
    }
    this.buffers.delete(id);
  }

  delete(id: number): void {
    this.detach(id);
  }

  setName(id: number, name: string): void {
    const state = this.buffers.get(id);
    if (!state) return;
    const next = String(name ?? "");
    if (state.name && state.name !== next) this.buffersByName.delete(state.name);
    state.name = next;
    if (state.name) this.buffersByName.set(state.name, id);
  }

  setFiletype(id: number, filetype: string): void {
    const state = this.buffers.get(id);
    if (!state) return;
    state.filetype = String(filetype ?? "");
  }

  async enterBuffer(
    arg: { buf: number; name?: string; filetype?: string },
    deps: {
      bufHandle: number | null;
      setBufHandle: (id: number) => void;
      rpcCall: (method: string, params: unknown[]) => Promise<any>;
      setSuppressCursorSync: (suppress: boolean) => void;
      delegateInsertToMonaco: boolean;
      flushPendingBeforeSwitch?: () => void;
      syncTabstopFromMonaco?: () => void;
      syncTabstop: boolean;
      requestSearchHighlightRefresh: () => void;
    },
  ): Promise<void> {
    const id = Number(arg.buf);
    if (!Number.isFinite(id) || id <= 0) return;
    const name = typeof arg.name === "string" ? String(arg.name) : "";
    const filetype = typeof arg.filetype === "string" ? String(arg.filetype) : "";

    if (deps.delegateInsertToMonaco) {
      deps.flushPendingBeforeSwitch?.();
    }

    let state = this.buffers.get(id) ?? null;
    if (!state && deps.bufHandle === id) {
      state = this.ensureState(id);
    }
    if (!state) {
      try { await deps.rpcCall("nvim_buf_attach", [id, false, {}]); } catch (_) {}
      let lines: string[] = [""];
      try {
        const all = await deps.rpcCall("nvim_buf_get_lines", [id, 0, -1, false]);
        if (Array.isArray(all)) lines = (all as unknown[]).map((l) => String(l ?? ""));
      } catch (_) {
      }
      const uri = monaco.Uri.from({ scheme: "nvim", authority: "buf", path: `/${id}` });
      const text = lines.join("\n");
      const hasLang = filetype && monaco.languages.getLanguages().some((l) => l.id === filetype);
      const model = monaco.editor.createModel(text, hasLang ? filetype : undefined, uri);
      state = {
        id,
        name: name || "",
        filetype: filetype || "",
        model,
        createdModel: true,
        shadowLines: null,
        pendingBufEdits: [],
        pendingFullSync: false,
        pendingCursorSync: false,
      };
      this.buffers.set(id, state);
    }

    if (name) this.setName(id, name);
    if (filetype) this.setFiletype(id, filetype);

    deps.setBufHandle(id);
    const currentModel = this.editor.getModel();
    if (currentModel !== state.model) {
      deps.setSuppressCursorSync(true);
      try { this.editor.setModel(state.model); } catch (_) {}
      deps.setSuppressCursorSync(false);
    }

    if (deps.delegateInsertToMonaco) {
      try { state.shadowLines = state.model.getLinesContent(); } catch (_) { state.shadowLines = null; }
      state.pendingBufEdits = [];
      state.pendingFullSync = false;
      state.pendingCursorSync = false;
    }

    if (deps.syncTabstop) deps.syncTabstopFromMonaco?.();
    deps.requestSearchHighlightRefresh();
  }

  async openText(
    input: { path: string; text: string },
    deps: { rpcCall: (method: string, params: unknown[]) => Promise<any>; extractBufId: (val: unknown) => number | null },
  ): Promise<void> {
    const lines = String(input.text ?? "").split(/\r?\n/);
    const p = String(input.path ?? "");
    if (!p) return;

    let bufId = this.getIdByName(p);
    if (!bufId) {
      try {
        const created = await deps.rpcCall("nvim_create_buf", [true, false]);
        bufId = deps.extractBufId(created) ?? Number(created);
      } catch (_) {
        bufId = null;
      }
    }
    if (!bufId || !Number.isFinite(bufId) || bufId <= 0) return;

    try { await deps.rpcCall("nvim_buf_set_lines", [bufId, 0, -1, false, lines]); } catch (_) {}
    try { await deps.rpcCall("nvim_buf_set_name", [bufId, p]); } catch (_) {}
    try { await deps.rpcCall("nvim_buf_set_option", [bufId, "modified", false]); } catch (_) {}
    try { await deps.rpcCall("nvim_win_set_buf", [0, bufId]); } catch (_) {}
  }
}


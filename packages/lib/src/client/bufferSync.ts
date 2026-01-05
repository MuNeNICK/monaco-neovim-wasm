import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

import { charIndexToByteIndex } from "../utils/utf8";
import { applyShadowLinesChange } from "../utils/shadowLines";

export type PendingBufSetText = {
  startRow: number;
  startColByte: number;
  endRow: number;
  endColByte: number;
  lines: string[];
};

export type BufferState = {
  id: number;
  name: string;
  filetype: string;
  model: monaco.editor.ITextModel;
  createdModel: boolean;
  shadowLines: string[] | null;
  pendingBufEdits: PendingBufSetText[];
  pendingFullSync: boolean;
  pendingCursorSync: boolean;
};

export type BufferSyncManagerInit = {
  editor: MonacoEditor.IStandaloneCodeEditor;
  nowMs: () => number;
  debugLog: (line: string) => void;

  rpcCall: (method: string, params: unknown[]) => Promise<any>;
  sendNotify: (method: string, params: unknown[]) => void;

  isSessionRunning: () => boolean;
  getBufHandle: () => number | null;

  getActiveState: () => BufferState | null;
  ensureActiveState: () => BufferState | null;
  getBufferState: (id: number) => BufferState | null;

  isDelegateInsertToMonaco: () => boolean;
  isExitingInsertMode: () => boolean;
  shouldAcceptNvimBufLinesDuringDelegatedInsert: () => boolean;
  isCompositionActive: () => boolean;
  setPendingResyncAfterComposition: (pending: boolean) => void;

  getSyncModelFromMonaco: () => "insertOnly" | "always" | "never";
  getInsertSyncDebounceMs: () => number;

  scheduleVisualSelectionRefresh: () => void;
  scheduleCursorRefresh: () => void;
  getLastMode: () => string;
  isVisualMode: (mode: string) => boolean;

  incrementPendingNvimBufUpdates: () => void;
  decrementPendingNvimBufUpdates: () => number;
  isPendingVisualRefresh: () => boolean;
  setPendingVisualRefresh: (pending: boolean) => void;

  getLastCursorPos: () => monaco.Position | null;
  getEditorPosition: () => monaco.Position | null;
  setSuppressCursorSync: (suppress: boolean) => void;
  setApplyingFromNvim: (applying: boolean) => void;
  isApplyingFromNvim: () => boolean;

  syncCursorToNvimNow: () => void;
};

export type MonacoModelChangeResult =
  | { kind: "noop" }
  | { kind: "resyncScheduled" }
  | { kind: "syncToNvimScheduled" }
  | { kind: "delegatedInsertPatched"; dotRepeat?: { deleted: number; text: string; simple: boolean }; resetDotRepeat?: boolean; resetReplayPossible?: boolean };

export class BufferSyncManager {
  private readonly init: BufferSyncManagerInit;

  private resyncTimer: number | null = null;
  private monacoToNvimTimer: number | null = null;
  private flushTimer: number | null = null;

  private ignoreActiveBufLinesEventsUntil = 0;

  constructor(init: BufferSyncManagerInit) {
    this.init = init;
  }

  reset(): void {
    if (this.resyncTimer) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
    if (this.monacoToNvimTimer) {
      clearTimeout(this.monacoToNvimTimer);
      this.monacoToNvimTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.ignoreActiveBufLinesEventsUntil = 0;
  }

  cancelPendingFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  scheduleResync(): void {
    if (this.resyncTimer) return;
    this.resyncTimer = globalThis.setTimeout(() => {
      this.resyncTimer = null;
      void this.resyncBufferFromNvim();
    }, 50);
  }

  private async resyncBufferFromNvim(): Promise<void> {
    if (this.init.isCompositionActive()) return;
    if (!this.init.isSessionRunning()) return;
    const bufHandle = this.init.getBufHandle();
    if (!bufHandle) return;
    try {
      const lines = await this.init.rpcCall("nvim_buf_get_lines", [bufHandle, 0, -1, false]);
      this.applyBuffer(Array.isArray(lines) ? (lines as string[]) : [""]);
    } catch (_) {
    }
  }

  scheduleSyncBufferToNvim(): void {
    if (this.monacoToNvimTimer) return;
    this.monacoToNvimTimer = globalThis.setTimeout(() => {
      this.monacoToNvimTimer = null;
      this.syncBufferToNvimNow();
    }, 60);
  }

  syncBufferToNvimNow(): void {
    if (!this.init.isSessionRunning()) return;
    const bufHandle = this.init.getBufHandle();
    if (!bufHandle) return;
    const model = this.init.editor.getModel();
    if (!model) return;
    try {
      const lines = model.getLinesContent?.() ?? model.getValue().split(/\r?\n/);
      this.init.sendNotify("nvim_buf_set_lines", [bufHandle, 0, -1, false, lines]);
    } catch (_) {
    }
  }

  applyBuffer(lines: string[] = [""]): void {
    const model = this.init.editor.getModel();
    if (!model) return;
    const joined = (lines && lines.length ? lines : [""]).join("\n");
    try {
      if (model.getValue() === joined) return;
    } catch (_) {
    }
    const pos = this.init.isDelegateInsertToMonaco()
      ? (this.init.getEditorPosition() ?? this.init.getLastCursorPos() ?? new monaco.Position(1, 1))
      : (this.init.getLastCursorPos() ?? this.init.getEditorPosition() ?? new monaco.Position(1, 1));
    this.init.setSuppressCursorSync(true);
    this.init.setApplyingFromNvim(true);
    try { model.setValue(joined); } catch (_) {}
    this.init.setApplyingFromNvim(false);
    try { if (pos) this.init.editor.setPosition(pos); } catch (_) {}
    this.init.setSuppressCursorSync(false);
    if (!this.init.isDelegateInsertToMonaco()) {
      // `buf_set_lines` can update the model without necessarily triggering a
      // CursorMoved notify (e.g. when Neovim cursor did not change but Monaco
      // drifted). Always refresh the cursor after applying a full buffer update.
      this.init.scheduleCursorRefresh();
    }
    if (this.init.isDelegateInsertToMonaco()) {
      const state = this.init.getActiveState();
      if (state && state.model === model) {
        try { state.shadowLines = model.getLinesContent(); } catch (_) {}
      }
    }
  }

  handleMonacoModelChange(ev: monaco.editor.IModelContentChangedEvent): MonacoModelChangeResult {
    if (!this.init.isDelegateInsertToMonaco()) {
      if (this.init.isApplyingFromNvim()) return { kind: "noop" };
      if (!this.init.isSessionRunning()) return { kind: "noop" };
      const bufHandle = this.init.getBufHandle();
      if (!bufHandle) return { kind: "noop" };
      if (this.init.isCompositionActive() || (ev as any)?.isComposing) return { kind: "noop" };
      if (!ev?.changes?.length) return { kind: "noop" };
      const mode = this.init.getSyncModelFromMonaco();
      if (mode === "always") {
        this.scheduleSyncBufferToNvim();
        return { kind: "syncToNvimScheduled" };
      }
      if (mode !== "never") {
        this.scheduleResync();
        return { kind: "resyncScheduled" };
      }
      return { kind: "noop" };
    }

    if (this.init.isApplyingFromNvim()) return { kind: "noop" };
    if (!this.init.isSessionRunning()) return { kind: "noop" };
    const bufHandle = this.init.getBufHandle();
    if (!bufHandle) return { kind: "noop" };
    const model = this.init.editor.getModel();
    if (!model) return { kind: "noop" };
    const state = this.init.ensureActiveState();
    if (!state || state.model !== model) return { kind: "noop" };

    if (!state.shadowLines || state.pendingFullSync) {
      state.pendingFullSync = true;
      state.pendingCursorSync = true;
      state.pendingBufEdits = [];
      try { state.shadowLines = model.getLinesContent(); } catch (_) { state.shadowLines = null; }
      this.scheduleFlushPendingMonacoSync();
      return { kind: "delegatedInsertPatched", resetDotRepeat: true, resetReplayPossible: true };
    }

    if (!ev.changes || ev.changes.length !== 1) {
      state.pendingFullSync = true;
      state.pendingCursorSync = true;
      state.pendingBufEdits = [];
      try { state.shadowLines = model.getLinesContent(); } catch (_) { state.shadowLines = null; }
      this.scheduleFlushPendingMonacoSync();
      return { kind: "delegatedInsertPatched", resetDotRepeat: true, resetReplayPossible: true };
    }

    const change = ev.changes[0];
    const range = change.range;
    const startRow = range.startLineNumber - 1;
    const endRow = range.endLineNumber - 1;
    if (startRow < 0 || endRow < 0) return { kind: "noop" };

    if (state.shadowLines[startRow] == null || state.shadowLines[endRow] == null) {
      state.pendingFullSync = true;
      state.pendingCursorSync = true;
      try { state.shadowLines = model.getLinesContent(); } catch (_) { state.shadowLines = null; }
      this.scheduleFlushPendingMonacoSync();
      return { kind: "delegatedInsertPatched", resetDotRepeat: true, resetReplayPossible: true };
    }

    const oldStartLine = state.shadowLines[startRow] ?? "";
    const oldEndLine = state.shadowLines[endRow] ?? "";
    const startColChar = Math.max(0, range.startColumn - 1);
    const endColChar = Math.max(0, range.endColumn - 1);
    const startColByte = charIndexToByteIndex(oldStartLine, startColChar);
    const endColByte = charIndexToByteIndex(oldEndLine, endColChar);
    const text = String(change.text ?? "");
    const lines = text.length ? text.split(/\r?\n/) : [];

    state.pendingBufEdits.push({ startRow, startColByte, endRow, endColByte, lines });
    applyShadowLinesChange(state.shadowLines, startRow, startColChar, endRow, endColChar, text);

    state.pendingCursorSync = true;
    this.scheduleFlushPendingMonacoSync();

    const deleted = Math.max(0, Number((change as any).rangeLength ?? 0) || 0);
    const simple = startRow === endRow && !text.includes("\n");
    return { kind: "delegatedInsertPatched", dotRepeat: { deleted, text, simple }, resetDotRepeat: !simple };
  }

  scheduleCursorSyncToNvim(): void {
    if (!this.init.isDelegateInsertToMonaco()) return;
    if (this.init.isExitingInsertMode()) return;
    const state = this.init.getActiveState();
    if (!state) return;
    state.pendingCursorSync = true;
    state.pendingFullSync = true;
    try { state.shadowLines = state.model.getLinesContent(); } catch (_) { state.shadowLines = null; }
    this.scheduleFlushPendingMonacoSync();
  }

  private scheduleFlushPendingMonacoSync(): void {
    if (this.flushTimer) return;
    const delay = Math.max(0, Number(this.init.getInsertSyncDebounceMs()) || 0);
    this.flushTimer = globalThis.setTimeout(() => {
      this.flushTimer = null;
      this.flushPendingMonacoSync();
    }, delay);
  }

  flushPendingMonacoSync(): void {
    if (!this.init.isSessionRunning()) return;
    const bufHandle = this.init.getBufHandle();
    if (!bufHandle) return;
    const state = this.init.getActiveState();
    if (!state) return;
    const model = this.init.editor.getModel();
    if (!model) return;
    if (state.model !== model) return;

    this.init.debugLog(
      `flushPendingMonacoSync: full=${state.pendingFullSync} edits=${state.pendingBufEdits.length} cursor=${state.pendingCursorSync} delegateInsert=${this.init.isDelegateInsertToMonaco()} exitingInsert=${this.init.isExitingInsertMode()}`,
    );

    if (this.init.isDelegateInsertToMonaco() && state.pendingBufEdits.length) {
      // In delegated insert, Monaco is the source of truth. Prefer full-buffer
      // sync so Neovim never applies stale byte offsets from incremental edits.
      state.pendingFullSync = true;
    }

    if (!state.pendingFullSync && state.pendingBufEdits.length > 1) {
      state.pendingFullSync = true;
    }

    if (state.pendingFullSync) {
      const lines = model.getLinesContent();
      this.init.sendNotify("nvim_buf_set_lines", [bufHandle, 0, -1, false, lines]);
      if (this.init.isDelegateInsertToMonaco()) this.ignoreActiveBufLinesEventsUntil = this.init.nowMs() + 120;
      state.pendingFullSync = false;
      state.pendingBufEdits = [];
      state.shadowLines = lines.slice();
    } else if (state.pendingBufEdits.length) {
      for (const edit of state.pendingBufEdits) {
        this.init.sendNotify("nvim_buf_set_text", [bufHandle, edit.startRow, edit.startColByte, edit.endRow, edit.endColByte, edit.lines]);
      }
      if (this.init.isDelegateInsertToMonaco()) this.ignoreActiveBufLinesEventsUntil = this.init.nowMs() + 120;
      state.pendingBufEdits = [];
    }

    if (state.pendingCursorSync) {
      state.pendingCursorSync = false;
      if (this.init.isDelegateInsertToMonaco() && !this.init.isExitingInsertMode()) {
        this.init.syncCursorToNvimNow();
      }
    }
  }

  async flushPendingMonacoSyncBlocking(): Promise<void> {
    if (!this.init.isSessionRunning()) return;
    const bufHandle = this.init.getBufHandle();
    if (!bufHandle) return;
    const state = this.init.getActiveState();
    if (!state) return;
    const model = this.init.editor.getModel();
    if (!model) return;
    if (state.model !== model) return;

    try {
      this.init.debugLog(
        `flushPendingMonacoSyncBlocking: full=${state.pendingFullSync} edits=${state.pendingBufEdits.length} cursor=${state.pendingCursorSync} buf=${bufHandle}`,
      );
    } catch (_) {
    }

    if (this.init.isDelegateInsertToMonaco() && state.pendingBufEdits.length) {
      state.pendingFullSync = true;
    }

    if (!state.pendingFullSync && state.pendingBufEdits.length > 1) {
      state.pendingFullSync = true;
    }

    if (state.pendingFullSync) {
      const lines = model.getLinesContent();
      state.pendingFullSync = false;
      state.pendingBufEdits = [];
      state.pendingCursorSync = false;
      state.shadowLines = lines.slice();
      if (this.init.isDelegateInsertToMonaco()) this.ignoreActiveBufLinesEventsUntil = this.init.nowMs() + 120;
      await this.init.rpcCall("nvim_buf_set_lines", [bufHandle, 0, -1, false, lines]);
      return;
    }

    if (state.pendingBufEdits.length) {
      const edits = state.pendingBufEdits.slice();
      state.pendingBufEdits = [];
      state.pendingCursorSync = false;
      if (this.init.isDelegateInsertToMonaco()) this.ignoreActiveBufLinesEventsUntil = this.init.nowMs() + 120;
      for (const edit of edits) {
        await this.init.rpcCall("nvim_buf_set_text", [bufHandle, edit.startRow, edit.startColByte, edit.endRow, edit.endColByte, edit.lines]);
      }
      return;
    }

    if (state.pendingCursorSync) {
      state.pendingCursorSync = false;
    }
  }

  async handleNvimBufLinesEvent(params: unknown[], extractBufId: (val: unknown) => number | null): Promise<void> {
    this.init.incrementPendingNvimBufUpdates();
    let id: number | null = null;
    try {
      const [buf, _changedtick, firstline, lastline, linedata] = params;
      id = extractBufId(buf);
      if (!id) return;
      const bufHandle = this.init.getBufHandle();
      const state = (bufHandle != null && id === bufHandle) ? this.init.ensureActiveState() : (this.init.getBufferState(id) ?? null);
      if (!state) return;

      if (bufHandle != null && id === bufHandle && this.init.isDelegateInsertToMonaco()) {
        if (this.init.nowMs() < this.ignoreActiveBufLinesEventsUntil) return;
      }
      if (bufHandle != null && id === bufHandle && this.init.isCompositionActive()) {
        this.init.setPendingResyncAfterComposition(true);
        return;
      }

      const model = state.model;
      const fl = Number(firstline);
      const ll = Number(lastline);
      const newLines = Array.isArray(linedata) ? (linedata as unknown[]).map((l) => String(l ?? "")) : null;
      const canPatch = model && Number.isInteger(fl) && Number.isInteger(ll) && fl >= 0 && ll >= fl && newLines;
      if (canPatch) {
        try {
          const isActiveModel = bufHandle != null && id === bufHandle && this.init.editor.getModel() === model;
          if (isActiveModel && this.init.isDelegateInsertToMonaco()) {
            const patch = this.computeLinePatch(model!, fl, ll, newLines!);
            let isNoop = false;
            try { isNoop = model!.getValueInRange(patch.range) === patch.text; } catch (_) {}
            if (
              !isNoop
              && !this.init.shouldAcceptNvimBufLinesDuringDelegatedInsert()
            ) {
              // In insert-mode delegation, Monaco owns the buffer text. Neovim
              // can emit late `buf_lines` events for intermediate states that
              // would overwrite newer Monaco edits (leading to character
              // reordering). Ignore non-noop updates unless we explicitly
              // forwarded keys to Neovim and expect it to mutate the buffer.
              this.init.debugLog(`handleNvimBufLinesEvent: ignore active buf_lines during delegated insert fl=${fl} ll=${ll}`);
              return;
            }
            if (!isNoop) {
              if (state.pendingFullSync || state.pendingBufEdits.length) {
                this.scheduleResync();
                return;
              }
              this.applyLinePatchToModel(model!, fl, ll, newLines!);
              try { state.shadowLines = model!.getLinesContent(); } catch (_) {}
            }
          } else if (isActiveModel) {
            this.applyLinePatch(model!, fl, ll, newLines!);
            if (!this.init.isDelegateInsertToMonaco()) this.init.scheduleCursorRefresh();
          } else if (isActiveModel) {
            this.applyLinePatch(model!, fl, ll, newLines!);
          } else {
            this.applyLinePatchToModel(model!, fl, ll, newLines!);
          }
        } catch (_) {
        }
      } else {
        try {
          const allLines = await this.init.rpcCall("nvim_buf_get_lines", [id, 0, -1, false]);
          const lines = Array.isArray(allLines) ? (allLines as string[]) : [""];
          if (bufHandle != null && id === bufHandle && this.init.editor.getModel() === model) {
            this.applyBuffer(lines);
          } else {
            this.setModelText(model!, lines);
          }
        } catch (_) {
        }
      }
    } finally {
      const pending = this.init.decrementPendingNvimBufUpdates();
      if (pending === 0 && this.init.isPendingVisualRefresh()) {
        this.init.setPendingVisualRefresh(false);
        this.init.scheduleVisualSelectionRefresh();
      }
    }
    const bufHandle = this.init.getBufHandle();
    if (bufHandle != null && id != null && id === bufHandle && this.init.isVisualMode(this.init.getLastMode())) {
      this.init.scheduleVisualSelectionRefresh();
    }
  }

  private computeLinePatch(
    model: monaco.editor.ITextModel,
    firstline: number,
    lastline: number,
    newLines: string[],
  ): { range: monaco.Range; text: string } {
    const oldLineCount = model.getLineCount();
    const fl = Math.min(firstline, oldLineCount);
    const ll = Math.min(lastline, oldLineCount);

    const eof = new monaco.Position(oldLineCount, model.getLineMaxColumn(oldLineCount));
    const deletingToEof = ll >= oldLineCount && newLines.length === 0;
    const startPos = (deletingToEof && fl > 0)
      ? new monaco.Position(fl, model.getLineMaxColumn(fl))
      : (fl < oldLineCount ? new monaco.Position(fl + 1, 1) : eof);
    const endPos = ll < oldLineCount ? new monaco.Position(ll + 1, 1) : eof;

    let text = newLines.join("\n");
    const insertingAtEof = firstline >= oldLineCount && lastline >= oldLineCount;
    if (insertingAtEof && newLines.length > 0) text = `\n${text}`;
    const hasFollowingLine = lastline < oldLineCount;
    if (hasFollowingLine && newLines.length > 0) text += "\n";

    const range = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
    return { range, text };
  }

  private applyLinePatch(model: monaco.editor.ITextModel, firstline: number, lastline: number, newLines: string[]): void {
    const pos = this.init.isDelegateInsertToMonaco()
      ? (this.init.getEditorPosition() ?? this.init.getLastCursorPos() ?? new monaco.Position(1, 1))
      : (this.init.getLastCursorPos() ?? this.init.getEditorPosition() ?? new monaco.Position(1, 1));
    const patch = this.computeLinePatch(model, firstline, lastline, newLines);
    try {
      const existing = model.getValueInRange(patch.range);
      if (existing === patch.text) return;
    } catch (_) {
    }

    this.init.setSuppressCursorSync(true);
    this.init.setApplyingFromNvim(true);
    try { model.applyEdits([{ range: patch.range, text: patch.text }]); } catch (_) {}
    this.init.setApplyingFromNvim(false);
    try { if (pos) this.init.editor.setPosition(pos); } catch (_) {}
    this.init.setSuppressCursorSync(false);

    if (this.init.isDelegateInsertToMonaco()) {
      const state = this.init.getActiveState();
      if (state && state.model === model) {
        try { state.shadowLines = model.getLinesContent(); } catch (_) {}
      }
    }
  }

  private applyLinePatchToModel(model: monaco.editor.ITextModel, firstline: number, lastline: number, newLines: string[]): void {
    const patch = this.computeLinePatch(model, firstline, lastline, newLines);
    try {
      const existing = model.getValueInRange(patch.range);
      if (existing === patch.text) return;
    } catch (_) {
    }

    this.init.setApplyingFromNvim(true);
    try { model.applyEdits([{ range: patch.range, text: patch.text }]); } catch (_) {}
    this.init.setApplyingFromNvim(false);
  }

  private setModelText(model: monaco.editor.ITextModel, lines: string[]): void {
    const joined = (lines && lines.length ? lines : [""]).join("\n");
    try {
      if (model.getValue() === joined) return;
    } catch (_) {
    }
    this.init.setApplyingFromNvim(true);
    try { model.setValue(joined); } catch (_) {}
    this.init.setApplyingFromNvim(false);
  }
}

import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

import { isVisualMode } from "./modes";
import { byteIndexToCharIndex } from "../utils/utf8";

export type CursorManagerInit = {
  editor: MonacoEditor.IStandaloneCodeEditor;
  nowMs: () => number;
  debugLog: (line: string) => void;

  isCompositionActive: () => boolean;
  setSuppressCursorSync: (suppress: boolean) => void;

  isSessionRunning: () => boolean;
  rpcCall: (method: string, params: unknown[]) => Promise<any>;

  getLastMode: () => string;
  setLastMode: (mode: string) => void;
  onModeChange?: (mode: string) => void;
};

export class CursorManager {
  private readonly init: CursorManagerInit;

  private lastCursorPos: monaco.Position | null = null;

  private lastCursorStyle: MonacoEditor.IStandaloneEditorConstructionOptions["cursorStyle"] | null = null;
  private lastCursorBlink: MonacoEditor.IStandaloneEditorConstructionOptions["cursorBlinking"] | null = null;
  private lastCursorWidth: number | null = null;
  private initialCursorWidth = 0;
  private typicalFullWidth = 2;

  private optimisticCursorUntil = 0;
  private optimisticCursorPos: monaco.Position | null = null;
  private optimisticCursorPrevPos: monaco.Position | null = null;

  private cursorRefreshTimer: number | null = null;
  private cursorRefreshInFlight = false;
  private cursorRefreshPending = false;

  private cursorUpdateTimer: number | null = null;
  private pendingCursorUpdate: { line: number; col: number } | null = null;

  constructor(init: CursorManagerInit) {
    this.init = init;
  }

  reset(): void {
    this.lastCursorPos = null;
    this.lastCursorStyle = null;
    this.lastCursorBlink = null;
    this.lastCursorWidth = null;
    this.initialCursorWidth = 0;
    this.typicalFullWidth = 2;

    this.optimisticCursorUntil = 0;
    this.optimisticCursorPos = null;
    this.optimisticCursorPrevPos = null;

    this.cursorRefreshInFlight = false;
    this.cursorRefreshPending = false;
    if (this.cursorRefreshTimer) {
      clearTimeout(this.cursorRefreshTimer);
      this.cursorRefreshTimer = null;
    }
    if (this.cursorUpdateTimer) {
      clearTimeout(this.cursorUpdateTimer);
      this.cursorUpdateTimer = null;
    }
    this.pendingCursorUpdate = null;
  }

  setCursorMetricsFromEditor(): void {
    const EditorOption = monaco.editor.EditorOption;
    try {
      const fontInfo = this.init.editor.getOption(EditorOption.fontInfo);
      this.initialCursorWidth = this.init.editor.getOption(EditorOption.cursorWidth) || 0;
      this.typicalFullWidth = (fontInfo as any)?.typicalFullwidthCharacterWidth || 2;
    } catch (_) {
      this.initialCursorWidth = 0;
      this.typicalFullWidth = 2;
    }
  }

  getLastCursorPos(): monaco.Position | null {
    return this.lastCursorPos;
  }

  setLastCursorPos(pos: monaco.Position | null): void {
    this.lastCursorPos = pos ?? null;
  }

  applyCursorStyle(mode: string): void {
    const m = typeof mode === "string" ? mode : "";
    const isVisual = isVisualMode(m);
    const isInsert = m.startsWith("i") || m.startsWith("R");
    const style: MonacoEditor.IStandaloneEditorConstructionOptions["cursorStyle"] = isVisual
      ? "line-thin"
      : (isInsert ? "line" : "block");
    const blink: MonacoEditor.IStandaloneEditorConstructionOptions["cursorBlinking"] = isInsert ? "blink" : "solid";
    const width = isVisual
      ? 1
      : (isInsert ? (this.initialCursorWidth || 1) : this.typicalFullWidth);
    if (style === this.lastCursorStyle && blink === this.lastCursorBlink && width === this.lastCursorWidth) return;
    try {
      this.init.editor.updateOptions({ cursorStyle: style, cursorBlinking: blink, cursorWidth: width });
      this.lastCursorStyle = style;
      this.lastCursorBlink = blink;
      this.lastCursorWidth = width;
    } catch (_) {
    }
  }

  applyOptimisticInsert(text: string, isCmdlineVisible: () => boolean): void {
    const payload = String(text ?? "");
    if (!payload) return;
    if (isCmdlineVisible()) return;
    const model = this.init.editor.getModel();
    if (!model) return;
    const selection = this.init.editor.getSelection();
    const base = selection && !selection.isEmpty() ? selection.getStartPosition() : null;
    const basePos = base ?? this.init.editor.getPosition() ?? this.lastCursorPos ?? new monaco.Position(1, 1);
    const parts = payload.split(/\r?\n/);
    let line = basePos.lineNumber;
    let col = basePos.column;
    if (parts.length <= 1) {
      col += Array.from(parts[0] ?? "").length;
    } else {
      line += parts.length - 1;
      col = 1 + Array.from(parts[parts.length - 1] ?? "").length;
    }
    const next = model.validatePosition(new monaco.Position(line, col));
    const prev = this.init.editor.getPosition() ?? this.lastCursorPos ?? basePos;
    this.optimisticCursorPrevPos = prev;
    this.optimisticCursorPos = next;
    this.optimisticCursorUntil = (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) + 120;
    this.lastCursorPos = next;
    if (this.init.isCompositionActive()) return;
    try {
      this.init.setSuppressCursorSync(true);
      this.init.editor.setPosition(next);
    } catch (_) {
    } finally {
      this.init.setSuppressCursorSync(false);
    }
  }

  scheduleCursorUpdate(lineNumber: number, column: number, applyCursorSelectionFromNvim: (ln: number, col: number) => Promise<void>): void {
    this.pendingCursorUpdate = { line: lineNumber, col: column };
    if (this.cursorUpdateTimer) return;
    this.cursorUpdateTimer = globalThis.setTimeout(() => {
      this.cursorUpdateTimer = null;
      const pending = this.pendingCursorUpdate;
      this.pendingCursorUpdate = null;
      if (!pending) return;
      void applyCursorSelectionFromNvim(pending.line, pending.col);
    }, 5);
  }

  scheduleCursorRefresh(refreshCursorMode: () => Promise<unknown>): void {
    if (this.init.isCompositionActive()) return;
    if (this.cursorRefreshTimer) return;
    const now = (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
    const delay = this.optimisticCursorUntil > now ? Math.max(30, Math.min(180, this.optimisticCursorUntil - now)) : 30;
    this.cursorRefreshTimer = globalThis.setTimeout(() => {
      this.cursorRefreshTimer = null;
      void refreshCursorMode();
    }, delay);
  }

  async refreshCursorMode(applyCursorSelectionFromNvim: (ln: number, col: number) => Promise<void>): Promise<boolean> {
    if (this.init.isCompositionActive()) return false;
    const now = (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
    if (this.optimisticCursorUntil > now) {
      // Avoid overwriting an optimistic caret update with a stale poll result.
      this.scheduleCursorRefresh(() => this.refreshCursorMode(applyCursorSelectionFromNvim));
      return false;
    }
    if (this.cursorRefreshInFlight) {
      this.cursorRefreshPending = true;
      return false;
    }
    this.cursorRefreshInFlight = true;
    try {
      if (!this.init.isSessionRunning()) return false;
      const cursor = await this.init.rpcCall("nvim_win_get_cursor", [0]);
      if (Array.isArray(cursor) && cursor.length >= 2) {
        const ln = Number(cursor[0]);
        const col0 = Number(cursor[1]);
        const clamped = clampCursor(this.init.editor, ln, col0);
        const next = new monaco.Position(clamped.line, clamped.col);
        const now2 = (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
        if (this.optimisticCursorPos && this.optimisticCursorUntil > now2) {
          const prev = this.optimisticCursorPrevPos;
          if (prev && next.lineNumber === prev.lineNumber && next.column === prev.column) {
            // Still seeing the old cursor; keep optimistic.
          } else if (
            next.lineNumber < this.optimisticCursorPos.lineNumber
            || (next.lineNumber === this.optimisticCursorPos.lineNumber && next.column < this.optimisticCursorPos.column)
          ) {
            // Cursor moved backwards relative to optimistic position; likely stale.
          } else {
            this.optimisticCursorPos = null;
            this.optimisticCursorPrevPos = null;
            this.optimisticCursorUntil = 0;
            await applyCursorSelectionFromNvim(next.lineNumber, next.column);
          }
        } else {
          this.optimisticCursorPos = null;
          this.optimisticCursorPrevPos = null;
          this.optimisticCursorUntil = 0;
          await applyCursorSelectionFromNvim(next.lineNumber, next.column);
        }
      }
      if (!this.init.getLastMode()) {
        try {
          const mode = await this.init.rpcCall("nvim_get_mode", []);
          if (mode && typeof (mode as { mode?: string }).mode === "string") {
            const m = (mode as { mode: string }).mode;
            this.init.setLastMode(m);
            this.applyCursorStyle(m);
            try { this.init.onModeChange?.(m); } catch (_) {}
          }
        } catch (_) {
        }
      }
      return true;
    } catch (_) {
      return false;
    } finally {
      this.cursorRefreshInFlight = false;
      if (this.cursorRefreshPending) {
        this.cursorRefreshPending = false;
        void this.refreshCursorMode(applyCursorSelectionFromNvim);
      }
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampCursor(editor: MonacoEditor.IStandaloneCodeEditor, ln: number, col0: number) {
  const fallbackLine = Math.max(1, Number(ln) || 1);
  const fallbackCol = Math.max(1, (Number(col0) || 0) + 1);
  const model = editor.getModel();
  if (!model) {
    return { line: fallbackLine, col: fallbackCol };
  }
  const lineCount = model.getLineCount();
  const line = clamp(fallbackLine, 1, lineCount);
  const text = model.getLineContent(line) ?? "";
  const maxColumn = model.getLineMaxColumn(line);
  const byteCol = Math.max(0, Number(col0) || 0);
  const charIndex = byteIndexToCharIndex(text, byteCol);
  const col = clamp(charIndex + 1, 1, maxColumn);
  return { line, col };
}

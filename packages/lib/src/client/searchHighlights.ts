import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

import { byteIndexToCharIndex } from "../utils/utf8";

export type SearchHighlightManagerInit = {
  editor: MonacoEditor.IStandaloneCodeEditor;
  isEnabled: () => boolean;
  isSessionRunning: () => boolean;
  getBufHandle: () => number | null;
  execLua: (code: string, args: unknown[]) => Promise<unknown>;
  luaScript: string;
  isStagingFrame: () => boolean;
  markSearchRefresh: () => void;
  debugLog?: (line: string) => void;
};

export class SearchHighlightManager {
  private readonly init: SearchHighlightManagerInit;

  private decorationIds: string[] = [];
  private refreshTimer: number | null = null;
  private refreshInFlight = false;
  private refreshPending = false;

  constructor(init: SearchHighlightManagerInit) {
    this.init = init;
  }

  reset(): void {
    this.clear();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.refreshInFlight = false;
    this.refreshPending = false;
  }

  clear(): void {
    if (!this.decorationIds.length) return;
    try {
      this.decorationIds = this.init.editor.deltaDecorations(this.decorationIds, []);
    } catch (_) {
      this.decorationIds = [];
    }
  }

  requestRefresh(): void {
    if (!this.init.isEnabled()) return;
    if (this.init.isStagingFrame()) {
      this.init.markSearchRefresh();
      return;
    }
    this.scheduleRefresh();
  }

  scheduleRefresh(): void {
    if (!this.init.isEnabled()) return;
    if (this.refreshTimer) return;
    this.refreshTimer = globalThis.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshNow();
    }, 60);
  }

  private async refreshNow(): Promise<void> {
    if (!this.init.isEnabled()) return;
    if (!this.init.isSessionRunning()) return;
    if (!this.init.getBufHandle()) return;
    const model = this.init.editor.getModel();
    if (!model) return;
    if (this.refreshInFlight) {
      this.refreshPending = true;
      return;
    }
    this.refreshInFlight = true;
    try {
      let start = 1;
      let end = model.getLineCount();
      try {
        const ranges = this.init.editor.getVisibleRanges();
        if (ranges && ranges.length) {
          start = Math.min(...ranges.map((r) => r.startLineNumber));
          end = Math.max(...ranges.map((r) => r.endLineNumber));
        }
      } catch (_) {
      }
      start = Math.max(1, Math.min(start, model.getLineCount()));
      end = Math.max(1, Math.min(end, model.getLineCount()));
      const res = await this.init.execLua(this.init.luaScript, [start, end]);
      this.applyFromLuaResult(res, model);
    } catch (err) {
      void err;
    }
    this.refreshInFlight = false;
    if (this.refreshPending) {
      this.refreshPending = false;
      this.scheduleRefresh();
    }
  }

  private applyFromLuaResult(res: unknown, model: monaco.editor.ITextModel): void {
    if (!res || typeof res !== "object") {
      this.clear();
      return;
    }
    const obj = res as Record<string, unknown>;
    const enabled = Boolean(obj.enabled);
    if (!enabled) {
      this.clear();
      return;
    }
    const matches = Array.isArray(obj.matches) ? (obj.matches as any[]) : [];
    const current = (obj.current && typeof obj.current === "object") ? (obj.current as any) : null;
    const currentKey = current && Number.isFinite(Number(current.l)) ? `${Number(current.l)}:${Number(current.s)}:${Number(current.e)}` : null;

    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const max = 2000;
    const lineCache = new Map<number, string>();
    const getLine = (ln: number) => {
      if (lineCache.has(ln)) return lineCache.get(ln)!;
      const text = model.getLineContent(ln) ?? "";
      lineCache.set(ln, text);
      return text;
    };

    for (let i = 0; i < matches.length && decorations.length < max; i += 1) {
      const m = matches[i];
      const l0 = Number(m?.l);
      const s0 = Number(m?.s);
      const e0 = Number(m?.e);
      if (!Number.isFinite(l0) || !Number.isFinite(s0) || !Number.isFinite(e0)) continue;
      const lineNumber = l0 + 1;
      if (lineNumber < 1 || lineNumber > model.getLineCount()) continue;
      const text = getLine(lineNumber);
      const startCol = byteIndexToCharIndex(text, Math.max(0, s0)) + 1;
      const endCol = byteIndexToCharIndex(text, Math.max(0, e0)) + 1;
      if (endCol <= startCol) continue;
      const key = `${l0}:${s0}:${e0}`;
      const isCurrent = Boolean(currentKey && key === currentKey);
      const className = isCurrent ? "currentFindMatch" : "findMatch";
      const inlineClassName = isCurrent ? "currentFindMatchInline" : "findMatchInline";
      decorations.push({
        range: new monaco.Range(lineNumber, startCol, lineNumber, endCol),
        options: { className, inlineClassName },
      });
    }

    try {
      this.decorationIds = this.init.editor.deltaDecorations(this.decorationIds, decorations);
    } catch (_) {
      this.decorationIds = [];
    }
  }
}

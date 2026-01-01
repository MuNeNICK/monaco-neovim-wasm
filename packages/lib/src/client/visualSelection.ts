import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

import { isVisualMode } from "./modes";
import { lspRangeToSelection } from "../utils/lsp";
import { charIndexToByteIndex } from "../utils/utf8";

export type VisualSelectionManagerInit = {
  editor: MonacoEditor.IStandaloneCodeEditor;
  nowMs: () => number;
  debugLog: (line: string) => void;
  isDebug: () => boolean;

  isSessionRunning: () => boolean;
  getBufHandle: () => number | null;

  getLastMode: () => string;
  setLastMode: (mode: string) => void;
  applyCursorStyle: (mode: string) => void;
  onModeChange?: (mode: string) => void;

  getPendingNvimBufUpdates: () => number;

  isDelegateInsertToMonaco: () => boolean;
  isSuppressCursorSync: () => boolean;
  isCompositionActive: () => boolean;
  getIgnoreSelectionSyncUntil: () => number;
  setSuppressCursorSync: (suppress: boolean) => void;

  sendInput: (keys: string) => void;
  rpcCall: (method: string, params: unknown[]) => Promise<any>;
  execLua: (code: string, args: unknown[]) => Promise<any>;
  visualSelectionLua: string;
};

export class VisualSelectionManager {
  private readonly init: VisualSelectionManagerInit;

  private visualSelectionToken = 0;
  private visualSelectionActive = false;
  private visualSelectionRefreshTimer: number | null = null;
  private visualModeCheckUntil = 0;
  private pendingVisualRefresh = false;

  private selectionRenderFrame: number | null = null;
  private pendingVisualSelections: monaco.Selection[] | null = null;
  private lastVisualSelectionAt = 0;

  private selectionSyncTimer: number | null = null;
  private pendingSelection: monaco.Selection | null = null;

  constructor(init: VisualSelectionManagerInit) {
    this.init = init;
  }

  createToken(): number {
    this.visualSelectionToken += 1;
    return this.visualSelectionToken;
  }

  isTokenValid(token: number): boolean {
    return token === this.visualSelectionToken;
  }

  reset(): void {
    this.pendingVisualRefresh = false;
    this.visualSelectionToken = 0;
    this.visualSelectionActive = false;
    this.visualModeCheckUntil = 0;
    this.lastVisualSelectionAt = 0;
    this.pendingSelection = null;

    if (this.selectionSyncTimer) {
      clearTimeout(this.selectionSyncTimer);
      this.selectionSyncTimer = null;
    }
    if (this.visualSelectionRefreshTimer) {
      clearTimeout(this.visualSelectionRefreshTimer);
      this.visualSelectionRefreshTimer = null;
    }
    if (this.selectionRenderFrame != null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.selectionRenderFrame);
      this.selectionRenderFrame = null;
    }
    this.pendingVisualSelections = null;
  }

  isPendingRefresh(): boolean {
    return this.pendingVisualRefresh;
  }

  setPendingRefresh(pending: boolean): void {
    this.pendingVisualRefresh = Boolean(pending);
  }

  isActive(): boolean {
    return this.visualSelectionActive;
  }

  deactivate(): void {
    this.visualSelectionActive = false;
    this.pendingVisualSelections = null;
    if (this.selectionRenderFrame != null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.selectionRenderFrame);
      this.selectionRenderFrame = null;
    }
  }

  shouldKeepSelection(nowMs: number, thresholdMs: number): boolean {
    const t = this.lastVisualSelectionAt;
    return Boolean(t && (nowMs - t) < thresholdMs);
  }

  clearVisualSelection(): void {
    this.visualSelectionActive = false;
    this.pendingVisualSelections = null;
    if (this.selectionRenderFrame != null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.selectionRenderFrame);
      this.selectionRenderFrame = null;
    }
    if (this.init.isCompositionActive()) return;
    const pos = this.init.editor.getPosition();
    if (!pos) return;
    const next = [new monaco.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column)];
    const prev = this.init.editor.getSelections();
    if (selectionsEqual(prev, next)) return;
    try {
      this.init.setSuppressCursorSync(true);
      this.init.editor.setSelections(next);
    } catch (_) {
    } finally {
      this.init.setSuppressCursorSync(false);
    }
  }

  scheduleRefresh(): void {
    if (!isVisualMode(this.init.getLastMode())) return;
    if (this.init.getPendingNvimBufUpdates() > 0) {
      this.pendingVisualRefresh = true;
      return;
    }
    if (this.visualSelectionRefreshTimer) return;
    this.visualSelectionRefreshTimer = globalThis.setTimeout(() => {
      this.visualSelectionRefreshTimer = null;
      void this.updateVisualSelection(this.init.getLastMode() || "n");
    }, 16);
  }

  async updateVisualSelection(mode: string): Promise<void> {
    const visual = isVisualMode(mode);
    if (!visual && this.init.isSessionRunning()) {
      const now = this.init.nowMs();
      if (now >= this.visualModeCheckUntil) {
        this.visualModeCheckUntil = now + 80;
        try {
          const info = await this.init.rpcCall("nvim_get_mode", []);
          const m = info && typeof (info as { mode?: string }).mode === "string" ? String((info as { mode: string }).mode) : "";
          if (m && m !== this.init.getLastMode()) {
            this.init.setLastMode(m);
            this.init.applyCursorStyle(m);
            try { this.init.onModeChange?.(m); } catch (_) {}
          }
        } catch (_) {
        }
      }
    }
    if (!visual) return;
    const token = this.createToken();
    try {
      const selections = await this.fetchVisualRanges();
      if (!this.isTokenValid(token)) return;
      if (!selections.length) {
        this.clearVisualSelection();
        return;
      }
      this.applyVisualSelection(selections);
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? String(err);
      this.init.debugLog(`visual selection failed: ${msg}`);
    }
  }

  async fetchVisualRanges(): Promise<monaco.Selection[]> {
    const res = await this.init.execLua(this.init.visualSelectionLua, []);
    let raw: any[] = [];
    if (Array.isArray(res)) {
      raw = res as any[];
    } else if (res && typeof res === "object") {
      const obj = res as any;
      if (Array.isArray(obj.ranges)) {
        raw = obj.ranges;
      } else if (obj.start && obj.end) {
        raw = [obj];
      } else {
        const numeric = Object.keys(obj)
          .filter((k) => /^\d+$/.test(k))
          .sort((a, b) => Number(a) - Number(b));
        if (numeric.length) raw = numeric.map((k) => obj[k]);
        else raw = [];
      }
    }
    if (this.init.isDebug()) {
      let sample = "none";
      if (raw.length) {
        try { sample = JSON.stringify(raw[0]); } catch (_) { sample = "[unserializable]"; }
      }
      this.init.debugLog(`visual ranges raw=${raw.length} sample=${sample}`);
    }
    const selections = raw
      .map(lspRangeToSelection(this.init.editor))
      .filter((s): s is monaco.Selection => Boolean(s));
    if (this.init.isDebug()) {
      this.init.debugLog(`visual selections=${selections.length} ${formatSelections(selections)}`);
    }
    return selections;
  }

  applyVisualSelection(selections: monaco.Selection[]): void {
    if (!selections.length) {
      this.visualSelectionActive = false;
      return;
    }
    if (this.init.isCompositionActive()) return;
    const prev = this.init.editor.getSelections();
    const hasSelection = selections.some(
      (sel) => sel.selectionStartLineNumber !== sel.positionLineNumber
        || sel.selectionStartColumn !== sel.positionColumn,
    );
    if (selectionsEqual(prev, selections)) {
      this.visualSelectionActive = hasSelection;
      this.ensureSelectionVisible(selections);
      if (hasSelection) {
        this.pendingVisualSelections = selections;
        this.scheduleSelectionRender();
      }
      if (hasSelection) this.lastVisualSelectionAt = this.init.nowMs();
      return;
    }
    try {
      this.init.setSuppressCursorSync(true);
      this.init.editor.setSelections(selections);
      this.visualSelectionActive = hasSelection;
      this.ensureSelectionVisible(selections);
      if (hasSelection) {
        this.pendingVisualSelections = selections;
        this.scheduleSelectionRender();
      }
      if (hasSelection) this.lastVisualSelectionAt = this.init.nowMs();
    } catch (_) {
      this.visualSelectionActive = false;
    } finally {
      this.init.setSuppressCursorSync(false);
    }
  }

  restorePendingSelections(): boolean {
    if (!isVisualMode(this.init.getLastMode())) return false;
    const restore = this.pendingVisualSelections;
    if (!restore || !restore.length) return false;
    if (this.init.isCompositionActive()) return false;
    try {
      this.init.setSuppressCursorSync(true);
      this.init.editor.setSelections(restore);
      this.scheduleSelectionRender();
      return true;
    } catch (_) {
      return false;
    } finally {
      this.init.setSuppressCursorSync(false);
    }
  }

  handleSelectionEvent(ev: monaco.editor.ICursorSelectionChangedEvent): void {
    if (this.init.isDelegateInsertToMonaco()) return;
    if (!this.init.isSessionRunning()) return;
    if (!this.init.getBufHandle()) return;
    if (this.init.isSuppressCursorSync()) return;
    if (this.init.isCompositionActive() || (ev as any)?.isComposing) return;
    if (this.init.getIgnoreSelectionSyncUntil() > this.init.nowMs()) return;

    const sel = ev.selection;
    if (!sel) return;
    if (ev.source !== "mouse") return;

    if (sel.isEmpty()) {
      if (isVisualMode(this.init.getLastMode())) this.init.sendInput("<Esc>");
      return;
    }

    this.pendingSelection = new monaco.Selection(
      sel.selectionStartLineNumber,
      sel.selectionStartColumn,
      sel.positionLineNumber,
      sel.positionColumn,
    );
    if (this.selectionSyncTimer) return;
    this.selectionSyncTimer = globalThis.setTimeout(() => {
      this.selectionSyncTimer = null;
      const pending = this.pendingSelection;
      this.pendingSelection = null;
      if (!pending) return;
      void this.syncVisualSelectionToNvim(pending).catch((err) => {
        const msg = (err as { message?: string })?.message ?? String(err);
        this.init.debugLog(`sync visual selection failed: ${msg}`);
      });
    }, 80);
  }

  async syncVisualSelectionToNvim(sel: monaco.Selection): Promise<void> {
    if (this.init.isDelegateInsertToMonaco()) return;
    if (!this.init.isSessionRunning()) return;
    if (!this.init.getBufHandle()) return;
    const model = this.init.editor.getModel();
    if (!model) return;

    const anchorLine = sel.selectionStartLineNumber;
    const anchorCharCol0 = Math.max(0, sel.selectionStartColumn - 1);
    const activeLine = sel.positionLineNumber;
    const activeCharCol0 = Math.max(0, sel.positionColumn - 1);

    const anchorText = model.getLineContent(anchorLine) ?? "";
    const activeText = model.getLineContent(activeLine) ?? "";
    const anchorByteCol0 = charIndexToByteIndex(anchorText, anchorCharCol0);
    const activeByteCol0 = charIndexToByteIndex(activeText, activeCharCol0);

    const lua = `
local api = vim.api
local fn = vim.fn
local a_line, a_col0, b_line, b_col0 = ...
local mode = api.nvim_get_mode().mode or ""
if mode:match("[vV\\022]") then
  local esc = api.nvim_replace_termcodes("<Esc>", true, true, true)
  api.nvim_feedkeys(esc, "n", false)
end
api.nvim_win_set_cursor(0, { a_line, a_col0 })
api.nvim_feedkeys("v", "n", false)
api.nvim_win_set_cursor(0, { b_line, b_col0 })
`;
    await this.init.execLua(lua, [anchorLine, anchorByteCol0, activeLine, activeByteCol0]);
  }

  private scheduleSelectionRender(): void {
    if (typeof window === "undefined") return;
    if (this.selectionRenderFrame != null) return;
    this.selectionRenderFrame = window.requestAnimationFrame(() => {
      this.selectionRenderFrame = null;
      if (!isVisualMode(this.init.getLastMode())) return;
      const pending = this.pendingVisualSelections;
      if (!pending || this.init.isCompositionActive()) return;
      try {
        this.init.editor.setSelections(pending);
        this.init.editor.render();
      } catch (_) {
      }
    });
  }

  private ensureSelectionVisible(selections: monaco.Selection[]): void {
    if (!selections.length) return;
    let visibleRanges: monaco.Range[] = [];
    try {
      visibleRanges = this.init.editor.getVisibleRanges();
    } catch (_) {
      visibleRanges = [];
    }
    if (!visibleRanges.length) return;
    const primary = selections[0];
    if (!primary) return;
    const range = monaco.Range.fromPositions(primary.getStartPosition(), primary.getEndPosition());
    const isVisible = visibleRanges.some((vr) => {
      if (range.endLineNumber < vr.startLineNumber) return false;
      if (range.startLineNumber > vr.endLineNumber) return false;
      return true;
    });
    if (isVisible) return;
    try {
      this.init.editor.revealRangeInCenterIfOutsideViewport(range);
    } catch (_) {
    }
  }
}

function selectionsEqual(
  a: readonly monaco.Selection[] | null | undefined,
  b: readonly monaco.Selection[] | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const sa = a[i];
    const sb = b[i];
    if (!sa || !sb) return false;
    if (
      sa.selectionStartLineNumber !== sb.selectionStartLineNumber
      || sa.selectionStartColumn !== sb.selectionStartColumn
      || sa.positionLineNumber !== sb.positionLineNumber
      || sa.positionColumn !== sb.positionColumn
    ) {
      return false;
    }
  }
  return true;
}

function formatSelections(selections: readonly monaco.Selection[] | null | undefined): string {
  if (!selections || selections.length === 0) return "[]";
  return selections
    .map((sel) => {
      const sLine = sel.selectionStartLineNumber;
      const sCol = sel.selectionStartColumn;
      const eLine = sel.positionLineNumber;
      const eCol = sel.positionColumn;
      return `[${sLine},${sCol} -> ${eLine},${eCol}]`;
    })
    .join(" ");
}

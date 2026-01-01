import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

export type ViewportManagerInit = {
  editor: MonacoEditor.IStandaloneCodeEditor;
  getUiRows: () => number;
  getDefaultRows: () => number;

  getScrolloffOverride: () => number | null | undefined;
  isSyncScrolloffEnabled: () => boolean;
  getNvimScrolloff: () => number;

  isCompositionActive: () => boolean;
  isDelegateInsertToMonaco: () => boolean;

  setSuppressCursorSync: (suppress: boolean) => void;
  setLastCursorPos: (pos: monaco.Position | null) => void;
  requestSearchHighlightRefresh: () => void;
};

export class ViewportManager {
  private readonly init: ViewportManagerInit;

  constructor(init: ViewportManagerInit) {
    this.init = init;
  }

  getScrolloffLines(): number {
    const override = this.init.getScrolloffOverride();
    if (override != null) return Math.max(0, Math.floor(Number(override) || 0));
    if (!this.init.isSyncScrolloffEnabled()) return 0;
    return Math.max(0, Math.floor(this.init.getNvimScrolloff()));
  }

  applyScrolloff(pos?: monaco.Position | null): boolean {
    if (this.init.isCompositionActive()) return false;
    if (this.init.isDelegateInsertToMonaco()) return false;
    const so = this.getScrolloffLines();
    if (so <= 0) return false;

    const p = pos ?? this.init.editor.getPosition();
    if (!p) return false;

    const lineHeight = Math.max(1, Number(this.init.editor.getOption(monaco.editor.EditorOption.lineHeight) as any) || 0);
    const soPx = so * lineHeight;
    if (soPx <= 0) return false;

    let layoutHeight = 0;
    try {
      const layout = this.init.editor.getLayoutInfo() as any;
      layoutHeight = Math.max(0, Number(layout?.contentHeight ?? layout?.height ?? 0) || 0);
    } catch (_) {
    }
    if (layoutHeight <= 0) return false;

    const ensureVisible = () => {
      try { this.init.editor.revealPositionInCenterIfOutsideViewport(p); } catch (_) {}
    };

    let sp: { top: number; height: number } | null = null;
    try { sp = this.init.editor.getScrolledVisiblePosition(p) as any; } catch (_) {}
    if (!sp) {
      ensureVisible();
      try { sp = this.init.editor.getScrolledVisiblePosition(p) as any; } catch (_) {}
    }
    if (!sp || !Number.isFinite(sp.top) || !Number.isFinite(sp.height)) return false;

    const scrollTop = this.init.editor.getScrollTop();
    const cursorTop = sp.top;
    const cursorBottom = sp.top + sp.height;
    const minBottom = Math.max(0, layoutHeight - soPx);

    let delta = 0;
    if (cursorTop < soPx) {
      delta = cursorTop - soPx;
    } else if (cursorBottom > minBottom) {
      delta = cursorBottom - minBottom;
    }
    if (!delta) return false;

    try { this.init.editor.setScrollTop(Math.max(0, scrollTop + delta)); } catch (_) {}
    return true;
  }

  applyMonacoCursorMove(arg: Record<string, unknown>): void {
    const to = typeof arg.to === "string" ? arg.to : "";
    const by = typeof arg.by === "string" ? arg.by : "";
    const value = Math.max(1, Number(arg.value ?? 1) || 1);
    if (!to) return;

    const move = () => {
      try {
        this.init.editor.trigger("monaco-neovim-wasm", "cursorMove", { to, by, value } as any);
        return true;
      } catch (_) {
      }
      if (by === "wrappedLine" && (to === "down" || to === "up")) {
        const action = to === "down" ? "cursorDown" : "cursorUp";
        for (let i = 0; i < value; i += 1) {
          try { this.init.editor.trigger("monaco-neovim-wasm", action, null); } catch (_) {}
        }
        return true;
      }
      return false;
    };

    this.init.setSuppressCursorSync(true);
    void move();
    const pos = this.init.editor.getPosition();
    if (pos) {
      this.init.setLastCursorPos(pos);
      this.applyScrolloff(pos);
    }
    this.init.setSuppressCursorSync(false);
    this.init.requestSearchHighlightRefresh();
  }

  applyMonacoScroll(arg: Record<string, unknown>): boolean {
    const by = typeof arg.by === "string" ? arg.by : "";
    const direction = typeof arg.direction === "string" ? arg.direction : "";
    const value = Math.max(1, Number(arg.value ?? 1) || 1);
    const moveCursor = Boolean(arg.moveCursor);
    const cursorBy = typeof arg.cursorBy === "string" ? arg.cursorBy : "wrappedLine";

    const rows = Math.max(3, this.init.getUiRows() || this.init.getDefaultRows());
    const fontInfo = this.init.editor.getOption(monaco.editor.EditorOption.fontInfo) as any;
    const lineHeight = Math.max(1, Number(fontInfo?.lineHeight ?? 0) || 0);

    const pageLines = Math.max(1, rows - 2);
    const halfPageLines = Math.max(1, Math.floor(pageLines / 2));

    let deltaLines = value;
    if (by === "page") deltaLines = pageLines * value;
    else if (by === "halfPage") deltaLines = halfPageLines * value;
    else if (by === "line") deltaLines = value;
    else return false;

    const sign = direction === "up" ? -1 : direction === "down" ? 1 : 0;
    if (!sign) return false;

    this.init.setSuppressCursorSync(true);
    try {
      const top = this.init.editor.getScrollTop();
      const next = Math.max(0, top + sign * deltaLines * lineHeight);
      this.init.editor.setScrollTop(next);
    } catch (_) {
    }

    let moved = false;
    if (moveCursor) {
      try {
        this.applyMonacoCursorMove({
          to: sign > 0 ? "down" : "up",
          by: cursorBy,
          value: deltaLines,
        });
        moved = true;
      } catch (_) {
      }
    }

    this.init.setSuppressCursorSync(false);
    return moved;
  }

  applyMonacoReveal(arg: Record<string, unknown>): boolean {
    const direction = typeof arg.direction === "string" ? arg.direction : "";
    const resetCursor = Boolean(arg.resetCursor);
    const pos = this.init.editor.getPosition();
    if (!pos) return false;
    const line = pos.lineNumber;

    const rows = Math.max(1, this.init.getUiRows() || this.init.getDefaultRows());
    const fontInfo = this.init.editor.getOption(monaco.editor.EditorOption.fontInfo) as any;
    const lineHeight = Math.max(1, Number(fontInfo?.lineHeight ?? 0) || 0);

    this.init.setSuppressCursorSync(true);
    try {
      if (direction === "top") {
        const top = this.init.editor.getTopForLineNumber(line);
        this.init.editor.setScrollTop(top);
      } else if (direction === "center") {
        this.init.editor.revealLineInCenter(line);
      } else if (direction === "bottom") {
        const top = this.init.editor.getTopForLineNumber(line);
        const target = Math.max(0, top - (rows - 1) * lineHeight);
        this.init.editor.setScrollTop(target);
      }

      if (resetCursor) {
        const model = this.init.editor.getModel();
        if (model) {
          const text = model.getLineContent(line) ?? "";
          const m = /\S/.exec(text);
          const col = m ? (m.index + 1) : 1;
          const next = model.validatePosition(new monaco.Position(line, col));
          this.init.editor.setPosition(next);
          this.init.setLastCursorPos(next);
        }
      }
    } catch (_) {
    }
    this.init.setSuppressCursorSync(false);
    return resetCursor;
  }

  applyMonacoMoveCursor(arg: Record<string, unknown>): void {
    const to = typeof arg.to === "string" ? arg.to : "";
    if (!to) return;
    const model = this.init.editor.getModel();
    if (!model) return;
    const value = Math.max(1, Number(arg.value ?? 1) || 1);

    let top = 1;
    let bottom = model.getLineCount();
    try {
      const ranges = this.init.editor.getVisibleRanges();
      if (ranges && ranges.length) {
        top = Math.min(...ranges.map((r) => r.startLineNumber));
        bottom = Math.max(...ranges.map((r) => r.endLineNumber));
      }
    } catch (_) {
    }
    top = Math.max(1, Math.min(top, model.getLineCount()));
    bottom = Math.max(1, Math.min(bottom, model.getLineCount()));
    if (bottom < top) bottom = top;

    let targetLine = top;
    if (to === "top") {
      targetLine = top + (value - 1);
    } else if (to === "middle") {
      targetLine = Math.floor((top + bottom) / 2);
    } else if (to === "bottom") {
      targetLine = bottom - (value - 1);
    } else {
      return;
    }
    targetLine = Math.max(top, Math.min(bottom, targetLine));

    const text = model.getLineContent(targetLine) ?? "";
    const m = /\S/.exec(text);
    const col = m ? (m.index + 1) : 1;
    const next = model.validatePosition(new monaco.Position(targetLine, col));
    this.init.setSuppressCursorSync(true);
    try { this.init.editor.setPosition(next); } catch (_) {}
    this.init.setLastCursorPos(next);
    this.init.setSuppressCursorSync(false);
  }
}


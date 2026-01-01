import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

export type GridSize = { cols: number; rows: number };

export class ResizeManager {
  private readonly editor: MonacoEditor.IStandaloneCodeEditor;
  private readonly minCols: number;
  private readonly minRows: number;
  private readonly fallback: GridSize;
  private readonly debounceMs: number;
  private timer: number | null = null;

  constructor(args: {
    editor: MonacoEditor.IStandaloneCodeEditor;
    minCols: number;
    minRows: number;
    fallbackCols: number;
    fallbackRows: number;
    debounceMs: number;
  }) {
    this.editor = args.editor;
    this.minCols = args.minCols;
    this.minRows = args.minRows;
    this.fallback = { cols: args.fallbackCols, rows: args.fallbackRows };
    this.debounceMs = Math.max(0, Number(args.debounceMs) || 0);
  }

  cancel(): void {
    if (!this.timer) return;
    try {
      clearTimeout(this.timer);
    } catch (_) {
    }
    this.timer = null;
  }

  computeGridSize(): GridSize {
    try {
      const layout = this.editor.getLayoutInfo() as any;
      const contentWidth = Math.max(0, Number(layout?.contentWidth ?? layout?.width ?? 0) || 0);
      const contentHeight = Math.max(0, Number(layout?.contentHeight ?? layout?.height ?? 0) || 0);

      const fontInfo = this.editor.getOption(monaco.editor.EditorOption.fontInfo) as any;
      const charWidth = Math.max(1, Number(fontInfo?.typicalHalfwidthCharacterWidth ?? fontInfo?.maxDigitWidth ?? 0) || 0);
      const lineHeight = Math.max(1, Number(fontInfo?.lineHeight ?? 0) || 0);

      const cols = Math.max(this.minCols, Math.floor(contentWidth / charWidth));
      const rows = Math.max(this.minRows, Math.floor(contentHeight / lineHeight));
      if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) return { cols, rows };
    } catch (_) {
    }
    return this.fallback;
  }

  scheduleResizeToEditor(onResize: (size: GridSize) => void): void {
    if (this.timer) return;
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      onResize(this.computeGridSize());
    }, this.debounceMs);
  }
}

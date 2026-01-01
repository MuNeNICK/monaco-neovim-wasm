import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

import { isVisualMode } from "./modes";

export type CursorPositionHandlerInit = {
  editor: MonacoEditor.IStandaloneCodeEditor;
  nowMs: () => number;

  getLastCursorPos: () => monaco.Position | null;
  setLastCursorPos: (pos: monaco.Position) => void;

  isDelegatingInsert: () => boolean;
  isSuppressCursorSync: () => boolean;
  getLastMode: () => string;

  getIgnoreMonacoCursorSyncToNvimUntil: () => number;
  isCompositionActive: () => boolean;
  positionPreedit: () => void;
  scheduleCursorSyncToNvim: () => void;
  syncCursorToNvimNow: (force: boolean) => void;

  restorePendingSelections: () => boolean;
};

export class CursorPositionHandler {
  private readonly init: CursorPositionHandlerInit;

  constructor(init: CursorPositionHandlerInit) {
    this.init = init;
  }

  handle(ev: monaco.editor.ICursorPositionChangedEvent): void {
    const prevCursor = this.init.getLastCursorPos();
    const cur = this.init.editor.getPosition();
    if (cur) this.init.setLastCursorPos(cur);

    if (this.init.isDelegatingInsert()) {
      if (this.init.isCompositionActive()) this.init.positionPreedit();
      this.init.scheduleCursorSyncToNvim();
      return;
    }

    if (this.init.nowMs() < this.init.getIgnoreMonacoCursorSyncToNvimUntil() && ev.source !== "mouse") {
      return;
    }

    // During IME composition, Monaco moves its internal cursor/selection.
    // Don't fight it, otherwise the view can glitch until composition ends.
    if (this.init.isCompositionActive()) {
      this.init.positionPreedit();
      return;
    }

    const lastCursor = this.init.getLastCursorPos();
    if (this.init.isSuppressCursorSync() || !lastCursor) return;

    if (ev.source === "mouse") {
      // Keep Neovim's cursor in sync with mouse-driven Monaco cursor moves.
      // Relying solely on `onMouseDown` can miss cases where Monaco moves the
      // caret without a text-target position (e.g. clicking padding/whitespace),
      // which later manifests as a "cursor jump" when entering visual mode.
      const sel = this.init.editor.getSelection();
      if (sel && sel.isEmpty()) this.init.syncCursorToNvimNow(true);
      return;
    }

    if (ev.source === "keyboard") {
      if (isVisualMode(this.init.getLastMode())) {
        const restored = this.init.restorePendingSelections();
        if (restored && prevCursor) this.init.setLastCursorPos(prevCursor);
      }
      return;
    }
  }
}


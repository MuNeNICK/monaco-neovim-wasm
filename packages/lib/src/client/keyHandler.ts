import * as monaco from "monaco-editor";

import { isCmdlineLike, isInsertLike, isVisualMode } from "./modes";

export type KeyHandlerInsertDelegation = {
  isExitingInsertMode: () => boolean;
  isDelegating: () => boolean;
  exitDelegatedInsertMode: (key: string) => void;
  appendPendingKeysAfterExit: (keys: string) => void;
  getLastDelegatedDotRepeat: () => { prefix: string; keys: string } | null;
  clearLastDelegatedDotRepeat: () => void;
  recordRecentNormalKey: (key: string) => void;
};

export type KeyHandlerManagerInit = {
  nowMs: () => number;

  shouldHandleKey: (ev: KeyboardEvent) => boolean;
  translateKey: (ev: KeyboardEvent) => string | null;
  hasExplicitModAllowlist: (insertMode: boolean) => boolean;
  shouldForwardModifiedKeys: (ev: KeyboardEvent, insertMode: boolean) => boolean;

  getLastMode: () => string;

  isCompositionActive: () => boolean;
  setCompositionActive: (active: boolean) => void;
  setPendingEscAfterComposition: (pending: boolean) => void;

  insertDelegation: KeyHandlerInsertDelegation;
  handleNormalModeKey: (key: string) => void;

  armIgnoreNextInputEvent: (target?: EventTarget | null, ms?: number) => void;
  flushPendingMonacoSync: () => void;
  sendInput: (keys: string) => void;
  scheduleCursorRefresh: () => void;
  scheduleVisualSelectionRefresh: () => void;
};

export class KeyHandlerManager {
  private readonly init: KeyHandlerManagerInit;

  private ignoreTextKeydownUntil = 0;

  constructor(init: KeyHandlerManagerInit) {
    this.init = init;
  }

  reset(): void {
    this.ignoreTextKeydownUntil = 0;
  }

  setIgnoreTextKeydownUntil(deadlineMs: number): void {
    const next = Number(deadlineMs) || 0;
    this.ignoreTextKeydownUntil = Math.max(0, next);
  }

  handleKey(ev: monaco.IKeyboardEvent): void {
    const browserEvent = ev.browserEvent as KeyboardEvent;
    const insertDelegation = this.init.insertDelegation;

    if (insertDelegation.isExitingInsertMode()) {
      if (browserEvent.key === "Escape") {
        ev.preventDefault();
        return;
      }
      // IME: don't intercept Process/229 events; they are part of composition flow.
      if (browserEvent.key === "Process" || (browserEvent as any).keyCode === 229) {
        this.init.setCompositionActive(true);
        return;
      }
      if (this.init.isCompositionActive() || browserEvent.isComposing) return;
      if (!this.init.shouldHandleKey(browserEvent)) return;
      if (this.init.hasExplicitModAllowlist(false) && !this.init.shouldForwardModifiedKeys(browserEvent, false)) {
        return;
      }
      const key = this.init.translateKey(browserEvent);
      if (!key) return;
      this.init.armIgnoreNextInputEvent(browserEvent.target, 120);
      ev.preventDefault();
      insertDelegation.appendPendingKeysAfterExit(key);
      return;
    }

    if (insertDelegation.isDelegating()) {
      // While delegating insert-mode typing to Monaco (IME-friendly), only
      // forward "command-like" keys to Neovim after syncing Monaco -> Neovim.
      if (browserEvent.key === "Escape") {
        if (this.init.isCompositionActive() || browserEvent.isComposing) {
          // Let the browser/Monaco finish the IME composition first, then send
          // <Esc> to Neovim from `compositionend`.
          this.init.setPendingEscAfterComposition(true);
          return;
        }
        ev.preventDefault();
        insertDelegation.exitDelegatedInsertMode("<Esc>");
        return;
      }
      if (!this.init.shouldHandleKey(browserEvent)) return;
      if (this.init.hasExplicitModAllowlist(true) && !this.init.shouldForwardModifiedKeys(browserEvent, true)) {
        return;
      }
      if ((browserEvent.ctrlKey || browserEvent.altKey || browserEvent.metaKey) && !browserEvent.getModifierState?.("AltGraph")) {
        const key = this.init.translateKey(browserEvent);
        if (!key) return;
        ev.preventDefault();
        if (key === "<C-[>" || key === "<C-c>") {
          insertDelegation.exitDelegatedInsertMode(key);
        } else {
          this.init.flushPendingMonacoSync();
          this.init.sendInput(key);
        }
        return;
      }
      return;
    }

    const mode = this.init.getLastMode();
    if (
      isCmdlineLike(mode)
      && !this.init.isCompositionActive()
      && !browserEvent.isComposing
      && !(browserEvent.getModifierState?.("AltGraph"))
      && !browserEvent.ctrlKey
      && !browserEvent.metaKey
      && (typeof browserEvent.key === "string" && browserEvent.key.length === 1)
    ) {
      const asciiPrintable = /^[\x20-\x7E]$/.test(browserEvent.key);
      const treatAsAltChord = Boolean(browserEvent.altKey && asciiPrintable);
      if (!treatAsAltChord) {
        if (!this.init.shouldHandleKey(browserEvent)) return;
        return;
      }
    }

    if (
      this.ignoreTextKeydownUntil > 0
      && (typeof browserEvent.key === "string" && browserEvent.key.length === 1)
      && !browserEvent.ctrlKey
      && !browserEvent.metaKey
      && !browserEvent.altKey
      && this.init.nowMs() < this.ignoreTextKeydownUntil
    ) {
      return;
    }

    // IME: don't intercept Process/229 events; they are part of composition flow.
    if (browserEvent.key === "Process" || (browserEvent as any).keyCode === 229) {
      this.init.setCompositionActive(true);
      return;
    }
    if (this.init.isCompositionActive() || browserEvent.isComposing) return;
    if (!this.init.shouldHandleKey(browserEvent)) return;
    if (this.init.hasExplicitModAllowlist(false) && !this.init.shouldForwardModifiedKeys(browserEvent, false)) {
      return;
    }

    if (
      isInsertLike(mode)
      && !insertDelegation.isDelegating()
      && !insertDelegation.isExitingInsertMode()
      && !browserEvent.ctrlKey
      && !browserEvent.metaKey
      && !browserEvent.altKey
      && (browserEvent.key === "Dead" || (typeof browserEvent.key === "string" && browserEvent.key.length === 1))
    ) {
      // In non-delegated insert mode (e.g. blocking/recording), prefer the
      // `beforeinput`/IME pipeline for text so dead keys and IME commits work.
      return;
    }

    const key = this.init.translateKey(browserEvent);
    if (!key) return;

    // Some browsers still dispatch an `input` event even if we preventDefault on
    // keydown. Ignore the next `input` to avoid double-sending text.
    this.init.armIgnoreNextInputEvent(browserEvent.target, 120);
    ev.preventDefault();

    if (mode.startsWith("n")) {
      this.init.handleNormalModeKey(key);

      const dotRepeat = insertDelegation.getLastDelegatedDotRepeat();
      if (key === "." && dotRepeat) {
        const { prefix, keys: replay } = dotRepeat;
        this.init.sendInput(prefix);
        this.init.sendInput(replay);
        this.init.sendInput("<Esc>");
        return;
      }

      if (dotRepeat) {
        const clearOn = new Set(["c", "d", "y", "p", "x", "s", "r", "~", "J", ":"]);
        if (clearOn.has(key)) insertDelegation.clearLastDelegatedDotRepeat();
      }
    }

    if (!isInsertLike(mode) && key.length === 1 && !key.startsWith("<")) {
      insertDelegation.recordRecentNormalKey(key);
    }

    this.init.sendInput(key);
    if (!insertDelegation.isDelegating()) this.init.scheduleCursorRefresh();
    if (isVisualMode(mode)) this.init.scheduleVisualSelectionRefresh();
  }
}

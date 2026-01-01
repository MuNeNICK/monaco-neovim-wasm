import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

import { byteIndexToCharIndex, utf8StringByteLength } from "../utils/utf8";

export type PopupMenuItem = { word: string; kind?: string; menu?: string; info?: string };

export type OverlayCallbacks = {
  onCmdline?: (text: string | null) => void;
  onMessage?: (text: string | null) => void;
  onPopupmenu?: (items: PopupMenuItem[] | null, selected: number) => void;
};

export type OverlayInit = {
  editor: MonacoEditor.IStandaloneCodeEditor;
  cmdlineContainer?: HTMLElement | null;
  callbacks?: OverlayCallbacks;
};

export class OverlayManager {
  private readonly editor: MonacoEditor.IStandaloneCodeEditor;
  private readonly cmdlineContainer?: HTMLElement | null;
  private readonly callbacks: OverlayCallbacks;

  private cmdlineEl: HTMLDivElement | null = null;
  private cmdlineVisible = false;
  private cmdlineTextRaw: string | null = null;
  private cmdlineCursorByte: number | null = null;
  private cmdlineCursorOffsetBytes = 0;
  private cmdlineCursorContentBytes = 0;

  private messageEl: HTMLDivElement | null = null;
  private messageTextRaw: string | null = null;
  private messageTimer: number | null = null;

  private popupEl: HTMLDivElement | null = null;
  private popupItems: PopupMenuItem[] = [];
  private popupSelected = -1;

  private preeditEl: HTMLDivElement | null = null;
  private preeditVisible = false;

  private cmdlineContainerPositionRestore: { el: HTMLElement; prev: string } | null = null;

  constructor(init: OverlayInit) {
    this.editor = init.editor;
    this.cmdlineContainer = init.cmdlineContainer;
    this.callbacks = init.callbacks ?? {};
  }

  isCmdlineVisible(): boolean {
    return this.cmdlineVisible;
  }

  getMessageText(): string {
    return this.messageTextRaw ?? this.messageEl?.textContent ?? "";
  }

  setCmdlineCursorMapping(prefixBytes: number, contentBytes: number): void {
    this.cmdlineCursorOffsetBytes = Math.max(0, Math.floor(Number(prefixBytes) || 0));
    this.cmdlineCursorContentBytes = Math.max(0, Math.floor(Number(contentBytes) || 0));
  }

  mapCmdlinePos(pos: number): number {
    const p = Math.max(0, Math.floor(Number(pos) || 0));
    if (this.cmdlineCursorOffsetBytes > 0 && p <= this.cmdlineCursorContentBytes) {
      return this.cmdlineCursorOffsetBytes + p;
    }
    return p;
  }

  initCmdlineUi(): void {
    if (this.cmdlineContainer === null) return;
    if (this.cmdlineEl || this.messageEl || this.popupEl) return;
    // Intentionally do not render any built-in UI for cmdline/messages/popupmenu.
    // Hosts should provide `onCmdline` / `onMessage` / `onPopupmenu` to render overlays
    // in a way that matches their app's styling.
  }

  setCmdline(text: string | null): void {
    this.cmdlineTextRaw = text;
    this.cmdlineCursorByte = null;
    this.cmdlineCursorOffsetBytes = 0;
    this.cmdlineCursorContentBytes = 0;
    this.cmdlineVisible = Boolean(text && text !== "");
    if (this.callbacks.onCmdline) {
      try { this.callbacks.onCmdline(text); } catch (_) {}
    }
    if (!this.cmdlineEl) return;
    if (text == null || text === "") {
      this.cmdlineEl.textContent = "";
      this.cmdlineEl.style.display = "none";
      return;
    }
    this.cmdlineEl.textContent = text;
    this.cmdlineEl.style.display = "block";
  }

  setCmdlineCursor(bytePos: number | null): void {
    if (!this.cmdlineEl || !this.cmdlineVisible) return;
    if (!this.cmdlineTextRaw) return;
    if (bytePos == null || !Number.isFinite(bytePos)) {
      this.cmdlineEl.textContent = this.cmdlineTextRaw;
      this.cmdlineCursorByte = null;
      return;
    }
    const text = this.cmdlineTextRaw;
    const clampedByte = Math.max(0, Math.min(Number(bytePos) || 0, utf8StringByteLength(text)));
    const idx = Math.max(0, Math.min(text.length, byteIndexToCharIndex(text, clampedByte)));
    this.cmdlineCursorByte = clampedByte;
    this.cmdlineEl.textContent = `${text.slice(0, idx)}▏${text.slice(idx)}`;
  }

  setMessage(text: string | null): void {
    this.messageTextRaw = text == null ? null : String(text);
    if (this.callbacks.onMessage) {
      try { this.callbacks.onMessage(text); } catch (_) {}
    }
    if (!this.messageEl) return;
    if (this.messageTimer) {
      clearTimeout(this.messageTimer);
      this.messageTimer = null;
    }
    if (text == null || text === "") {
      this.messageEl.textContent = "";
      this.messageEl.style.display = "none";
      return;
    }
    this.messageEl.textContent = text;
    this.messageEl.style.display = "block";
    this.messageTimer = globalThis.setTimeout(() => {
      this.messageTimer = null;
      this.setMessage(null);
    }, 4000);
  }

  setPopupmenu(items: PopupMenuItem[] | null, selected: number): void {
    this.popupItems = items ?? [];
    this.popupSelected = selected;
    if (this.callbacks.onPopupmenu) {
      try { this.callbacks.onPopupmenu(items, selected); } catch (_) {}
      return;
    }
  }

  updatePopupmenuSelection(selected: number): void {
    if (this.popupSelected === selected) return;
    this.popupSelected = selected;
    if (this.callbacks.onPopupmenu) {
      try { this.callbacks.onPopupmenu(this.popupItems, selected); } catch (_) {}
      return;
    }
  }

  setPreedit(text: string | null): void {
    this.ensurePreeditUi();
    if (!this.preeditEl) return;
    const t = text == null ? "" : String(text);
    const nextVisible = t.length > 0;
    if (!nextVisible) {
      if (this.preeditVisible) {
        this.preeditEl.style.display = "none";
        this.preeditVisible = false;
      }
      this.preeditEl.textContent = "";
      return;
    }
    this.preeditEl.textContent = t;
    if (!this.preeditVisible) {
      this.preeditEl.style.display = "block";
      this.preeditVisible = true;
    }
    this.positionPreedit();
  }

  positionPreedit(): void {
    if (!this.preeditEl || !this.preeditVisible) return;
    const pos = this.editor.getPosition();
    if (!pos) return;
    const vis = this.editor.getScrolledVisiblePosition(pos);
    if (!vis) return;
    this.preeditEl.style.left = `${Math.max(0, vis.left)}px`;
    this.preeditEl.style.top = `${Math.max(0, vis.top)}px`;
    this.preeditEl.style.height = `${Math.max(0, vis.height)}px`;
  }

  dispose(): void {
    if (this.cmdlineEl) {
      try { this.cmdlineEl.remove(); } catch (_) {}
      this.cmdlineEl = null;
    }
    if (this.messageEl) {
      try { this.messageEl.remove(); } catch (_) {}
      this.messageEl = null;
    }
    if (this.popupEl) {
      try { this.popupEl.remove(); } catch (_) {}
      this.popupEl = null;
    }
    if (this.preeditEl) {
      try { this.preeditEl.remove(); } catch (_) {}
      this.preeditEl = null;
      this.preeditVisible = false;
    }
    if (this.cmdlineContainerPositionRestore) {
      try {
        this.cmdlineContainerPositionRestore.el.style.position = this.cmdlineContainerPositionRestore.prev;
      } catch (_) {
      }
      this.cmdlineContainerPositionRestore = null;
    }
    if (this.messageTimer) {
      clearTimeout(this.messageTimer);
      this.messageTimer = null;
    }
    this.cmdlineVisible = false;
    this.cmdlineTextRaw = null;
    this.cmdlineCursorByte = null;
    this.cmdlineCursorOffsetBytes = 0;
    this.cmdlineCursorContentBytes = 0;
    this.messageTextRaw = null;
    this.popupItems = [];
    this.popupSelected = -1;
  }

  private ensurePreeditUi(): void {
    if (this.preeditEl) return;
    const container = this.cmdlineContainer ?? this.editor.getDomNode();
    if (!container) return;
    this.ensureRelativePosition(container);
    const el = document.createElement("div");
    el.className = "monaco-neovim-wasm-preedit";
    el.style.position = "absolute";
    el.style.display = "none";
    el.style.pointerEvents = "none";
    el.style.zIndex = "40";
    el.style.whiteSpace = "pre";
    try {
      const fontInfo = this.editor.getOption(monaco.editor.EditorOption.fontInfo);
      if (fontInfo?.fontFamily) el.style.fontFamily = fontInfo.fontFamily;
      if (fontInfo?.fontSize) el.style.fontSize = `${fontInfo.fontSize}px`;
      if (fontInfo?.lineHeight) el.style.lineHeight = `${fontInfo.lineHeight}px`;
    } catch (_) {
    }
    container.appendChild(el);
    this.preeditEl = el;
  }

  private ensureRelativePosition(container: HTMLElement): void {
    try {
      const style = window.getComputedStyle(container);
      if (style.position === "static") {
        const el = container as HTMLElement;
        if (!this.cmdlineContainerPositionRestore) {
          this.cmdlineContainerPositionRestore = { el, prev: String(el.style.position ?? "") };
        }
        el.style.position = "relative";
      }
    } catch (_) {
    }
  }
}

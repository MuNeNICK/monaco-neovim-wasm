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
    return this.messageEl?.textContent ?? "";
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
    const container = this.cmdlineContainer ?? this.editor.getDomNode();
    if (!container) return;

    this.ensureRelativePosition(container);

    const baseFont = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
    const baseSize = "12px";
    const baseLine = "1.4";

    if (!this.callbacks.onCmdline) {
      const el = document.createElement("div");
      el.style.position = "absolute";
      el.style.left = "0";
      el.style.right = "0";
      el.style.bottom = "0";
      el.style.padding = "6px 10px";
      el.style.fontFamily = baseFont;
      el.style.fontSize = baseSize;
      el.style.lineHeight = baseLine;
      el.style.background = "rgba(0, 0, 0, 0.72)";
      el.style.color = "#ddd";
      el.style.borderTop = "1px solid rgba(255, 255, 255, 0.08)";
      el.style.whiteSpace = "pre";
      el.style.display = "none";
      el.style.pointerEvents = "none";
      el.style.zIndex = "20";
      container.appendChild(el);
      this.cmdlineEl = el;
    }

    if (!this.callbacks.onMessage) {
      const msg = document.createElement("div");
      msg.style.position = "absolute";
      msg.style.left = "0";
      msg.style.right = "0";
      msg.style.bottom = "34px";
      msg.style.padding = "6px 10px";
      msg.style.fontFamily = baseFont;
      msg.style.fontSize = baseSize;
      msg.style.lineHeight = baseLine;
      msg.style.background = "rgba(0, 0, 0, 0.55)";
      msg.style.color = "#ddd";
      msg.style.whiteSpace = "pre-wrap";
      msg.style.display = "none";
      msg.style.pointerEvents = "none";
      msg.style.zIndex = "19";
      container.appendChild(msg);
      this.messageEl = msg;
    }

    if (!this.callbacks.onPopupmenu) {
      const pop = document.createElement("div");
      pop.style.position = "absolute";
      pop.style.left = "12px";
      pop.style.bottom = "34px";
      pop.style.maxHeight = "40%";
      pop.style.overflow = "auto";
      pop.style.minWidth = "240px";
      pop.style.padding = "4px 0";
      pop.style.fontFamily = baseFont;
      pop.style.fontSize = baseSize;
      pop.style.lineHeight = baseLine;
      pop.style.background = "rgba(0, 0, 0, 0.88)";
      pop.style.border = "1px solid rgba(255, 255, 255, 0.12)";
      pop.style.borderRadius = "6px";
      pop.style.color = "#ddd";
      pop.style.whiteSpace = "pre";
      pop.style.display = "none";
      pop.style.pointerEvents = "none";
      pop.style.zIndex = "21";
      container.appendChild(pop);
      this.popupEl = pop;
    }
  }

  setCmdline(text: string | null): void {
    this.cmdlineTextRaw = text;
    this.cmdlineCursorByte = null;
    this.cmdlineCursorOffsetBytes = 0;
    this.cmdlineCursorContentBytes = 0;
    if (this.callbacks.onCmdline) {
      try { this.callbacks.onCmdline(text); } catch (_) {}
    }
    if (!this.cmdlineEl) return;
    if (text == null || text === "") {
      this.cmdlineEl.textContent = "";
      this.cmdlineEl.style.display = "none";
      this.cmdlineVisible = false;
      return;
    }
    this.cmdlineEl.textContent = text;
    this.cmdlineEl.style.display = "block";
    this.cmdlineVisible = true;
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
    }
    if (!this.popupEl) return;
    if (!items || !items.length) {
      this.popupEl.textContent = "";
      this.popupEl.style.display = "none";
      return;
    }
    this.popupEl.innerHTML = "";
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      const row = document.createElement("div");
      row.style.padding = "2px 10px";
      row.style.display = "flex";
      row.style.gap = "10px";
      row.style.justifyContent = "space-between";
      row.style.background = i === selected ? "rgba(255,255,255,0.12)" : "transparent";
      const left = document.createElement("span");
      left.textContent = it.word ?? "";
      const right = document.createElement("span");
      right.style.opacity = "0.7";
      right.textContent = it.menu ?? it.kind ?? "";
      row.appendChild(left);
      row.appendChild(right);
      this.popupEl.appendChild(row);
    }
    this.popupEl.style.display = "block";
  }

  updatePopupmenuSelection(selected: number): void {
    if (this.popupSelected === selected) return;
    this.popupSelected = selected;
    if (this.callbacks.onPopupmenu) {
      try { this.callbacks.onPopupmenu(this.popupItems, selected); } catch (_) {}
      return;
    }
    if (!this.popupEl) return;
    const children = Array.from(this.popupEl.children) as HTMLElement[];
    for (let i = 0; i < children.length; i += 1) {
      children[i].style.background = i === selected ? "rgba(255,255,255,0.12)" : "transparent";
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
    this.popupItems = [];
    this.popupSelected = -1;
  }

  private ensurePreeditUi(): void {
    if (this.preeditEl) return;
    const container = this.cmdlineContainer ?? this.editor.getDomNode();
    if (!container) return;
    this.ensureRelativePosition(container);
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.display = "none";
    el.style.pointerEvents = "none";
    el.style.zIndex = "40";
    el.style.whiteSpace = "pre";
    el.style.padding = "0 1px";
    el.style.background = "rgba(0, 0, 0, 0.15)";
    el.style.borderBottom = "1px solid rgba(255, 255, 255, 0.6)";
    el.style.borderRadius = "2px";
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

import type { PopupMenuItem } from "./overlays";

import { utf8StringByteLength } from "../utils/utf8";
import { parsePopupmenuItems, uiChunksToText } from "./ui";

export type RedrawManagerInit = {
  setCmdline: (text: string | null) => void;
  setCmdlineCursor: (bytePos: number | null) => void;
  setMessage: (text: string | null) => void;
  setPopupmenu: (items: PopupMenuItem[] | null, selected: number) => void;
  updatePopupmenuSelection: (selected: number) => void;
  scheduleSearchHighlightRefresh: () => void;
  getMessageText: () => string;
  cmdlineSetCursorMapping: (prefixBytes: number, contentBytes: number) => void;
  cmdlineMapPos: (pos: number) => number;
  isHostAutocmdInstalled: () => boolean;
  applyNvimModeFromRedraw: (mode: string) => void;
  debugLog?: (line: string) => void;
};

export class RedrawManager {
  private readonly init: RedrawManagerInit;

  private pendingRedrawEvents: unknown[][] = [];
  private stagingRedrawFrame = false;
  private stagedCmdlineText: string | null | undefined = undefined;
  private stagedCmdlineCursorByte: number | null | undefined = undefined;
  private stagedMessageText: string | null | undefined = undefined;
  private stagedPopupItems: PopupMenuItem[] | null | undefined = undefined;
  private stagedPopupSelected: number | undefined = undefined;
  private stagedSearchRefresh = false;

  constructor(init: RedrawManagerInit) {
    this.init = init;
  }

  reset(): void {
    this.pendingRedrawEvents = [];
    this.stagingRedrawFrame = false;
    this.stagedCmdlineText = undefined;
    this.stagedCmdlineCursorByte = undefined;
    this.stagedMessageText = undefined;
    this.stagedPopupItems = undefined;
    this.stagedPopupSelected = undefined;
    this.stagedSearchRefresh = false;
  }

  isStagingFrame(): boolean {
    return this.stagingRedrawFrame;
  }

  markSearchRefresh(): void {
    this.stagedSearchRefresh = true;
  }

  handleRedrawNotify(params: unknown[]): void {
    if (!Array.isArray(params)) return;
    for (const ev of params) {
      if (Array.isArray(ev)) this.pendingRedrawEvents.push(ev as unknown[]);
    }
    if (!this.pendingRedrawEvents.length) return;

    let flushIdx = -1;
    for (let i = 0; i < this.pendingRedrawEvents.length; i += 1) {
      const ev = this.pendingRedrawEvents[i];
      const name = Array.isArray(ev) ? ev[0] : null;
      if (name === "flush") flushIdx = i;
    }
    if (flushIdx < 0) return;

    const toProcess = this.pendingRedrawEvents.slice(0, flushIdx + 1);
    this.pendingRedrawEvents = this.pendingRedrawEvents.slice(flushIdx + 1);

    let start = 0;
    for (let i = 0; i < toProcess.length; i += 1) {
      const ev = toProcess[i];
      const name = Array.isArray(ev) ? ev[0] : null;
      if (name === "flush") {
        const frame = toProcess.slice(start, i + 1);
        start = i + 1;
        this.processRedrawFrame(frame);
      }
    }
    if (start < toProcess.length) {
      this.pendingRedrawEvents.unshift(...toProcess.slice(start));
    }
  }

  private beginRedrawFrame(): void {
    this.stagingRedrawFrame = true;
    this.stagedCmdlineText = undefined;
    this.stagedCmdlineCursorByte = undefined;
    this.stagedMessageText = undefined;
    this.stagedPopupItems = undefined;
    this.stagedPopupSelected = undefined;
    this.stagedSearchRefresh = false;
  }

  private endRedrawFrame(): void {
    this.stagingRedrawFrame = false;
    if (this.stagedCmdlineText !== undefined) {
      this.init.setCmdline(this.stagedCmdlineText);
    }
    if (this.stagedCmdlineCursorByte !== undefined) {
      this.init.setCmdlineCursor(this.stagedCmdlineCursorByte);
    }
    if (this.stagedMessageText !== undefined) {
      this.init.setMessage(this.stagedMessageText);
    }
    if (this.stagedPopupItems !== undefined) {
      this.init.setPopupmenu(this.stagedPopupItems, Number.isFinite(Number(this.stagedPopupSelected)) ? Number(this.stagedPopupSelected) : -1);
    } else if (this.stagedPopupSelected !== undefined) {
      const sel = Number(this.stagedPopupSelected);
      this.init.updatePopupmenuSelection(Number.isFinite(sel) ? sel : -1);
    }
    if (this.stagedSearchRefresh) {
      this.init.scheduleSearchHighlightRefresh();
    }
  }

  private processRedrawFrame(events: unknown[][]): void {
    this.beginRedrawFrame();
    try {
      for (const batch of events) {
        if (!Array.isArray(batch) || batch.length === 0) continue;
        const name = batch[0];
        if (name === "flush") break;
        if (typeof name !== "string") continue;
        const rawArgs = batch.slice(1);
        const args = rawArgs.length === 1 && Array.isArray(rawArgs[0]) ? (rawArgs[0] as unknown[]) : rawArgs;
        this.stageRedrawEvent(name, args);
      }
    } finally {
      this.endRedrawFrame();
    }
  }

  private stageRedrawEvent(name: string, args: unknown[]): void {
    if (name === "cmdline_hide") {
      this.stagedCmdlineText = null;
      this.stagedCmdlineCursorByte = null;
      this.stagedSearchRefresh = true;
      return;
    }
    if (name === "cmdline_show") {
      const content = args[0];
      const pos = Math.max(0, Number(args[1] ?? 0) || 0);
      const firstc = typeof args[2] === "string" ? args[2] : "";
      const prompt = typeof args[3] === "string" ? args[3] : "";
      const indent = Math.max(0, Number(args[4] ?? 0) || 0);
      const prefix = prompt ? prompt : (firstc || "");
      const indentText = " ".repeat(indent);
      const contentText = uiChunksToText(content);
      const text = `${indentText}${prefix}${contentText}`;

      // Keep the cursor mapping state in sync for cmdline_pos.
      const prefixBytes = utf8StringByteLength(`${indentText}${prefix}`);
      const contentBytes = utf8StringByteLength(contentText);
      this.init.cmdlineSetCursorMapping(prefixBytes, contentBytes);

      this.stagedCmdlineText = text;
      this.stagedCmdlineCursorByte = this.init.cmdlineMapPos(pos);
      this.stagedSearchRefresh = true;
      return;
    }
    if (name === "cmdline_pos") {
      const pos = Math.max(0, Number(args[0] ?? 0) || 0);
      this.stagedCmdlineCursorByte = this.init.cmdlineMapPos(pos);
      this.stagedSearchRefresh = true;
      return;
    }
    if (name === "msg_clear") {
      this.stagedMessageText = null;
      return;
    }
    if (name === "msg_show") {
      const kind = typeof args[0] === "string" ? args[0] : "";
      if (kind === "return_prompt") return;
      const content = args[1];
      const replaceLast = Boolean(args[2]);
      const append = Boolean(args[4]);
      const text = uiChunksToText(content);
      if (kind === "empty" && !text) {
        this.stagedMessageText = null;
        return;
      }
      if (!text) return;

      const base =
        this.stagedMessageText !== undefined
          ? (this.stagedMessageText ?? "")
          : this.init.getMessageText();
      if (append && base) {
        this.stagedMessageText = `${base}${text}`;
        return;
      }
      if (replaceLast) {
        this.stagedMessageText = text;
        return;
      }
      this.stagedMessageText = text;
      return;
    }
    if (name === "msg_showmode" || name === "msg_showcmd" || name === "msg_ruler") {
      const content = args[0];
      const text = uiChunksToText(content);
      this.stagedMessageText = text || null;
      return;
    }
    if (name === "popupmenu_hide") {
      this.stagedPopupItems = null;
      this.stagedPopupSelected = -1;
      return;
    }
    if (name === "popupmenu_show") {
      const itemsRaw = args[0];
      const selected = Number(args[1] ?? -1);
      const items = parsePopupmenuItems(itemsRaw);
      this.stagedPopupItems = items;
      this.stagedPopupSelected = Number.isFinite(selected) ? selected : -1;
      return;
    }
    if (name === "popupmenu_select") {
      const selected = Number(args[0] ?? -1);
      this.stagedPopupSelected = Number.isFinite(selected) ? selected : -1;
      return;
    }
    if (name === "mode_change") {
      const mode = typeof args[0] === "string" ? args[0] : "";
      if (!this.init.isHostAutocmdInstalled()) this.init.applyNvimModeFromRedraw(mode);
      return;
    }
  }
}

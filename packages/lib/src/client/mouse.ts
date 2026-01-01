import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

import { charIndexToByteIndex } from "../utils/utf8";

export type MouseManagerInit = {
  editor: MonacoEditor.IStandaloneCodeEditor;
  isSessionRunning: () => boolean;
  getBufHandle: () => number | null;
  isDelegateInsertToMonaco: () => boolean;
  sendNotify: (method: string, params: unknown[]) => void;
  execLua: (code: string, args: unknown[]) => Promise<any>;
};

export class MouseManager {
  private readonly init: MouseManagerInit;

  constructor(init: MouseManagerInit) {
    this.init = init;
  }

  handleMouseDown(ev: monaco.editor.IEditorMouseEvent): void {
    if (this.init.isDelegateInsertToMonaco()) return;
    const buf = this.init.getBufHandle();
    if (!buf || !ev.target?.position) return;
    const { lineNumber, column } = ev.target.position;
    const model = this.init.editor.getModel();
    const charCol0 = Math.max(0, column - 1);
    const text = model ? (model.getLineContent(lineNumber) ?? "") : "";
    const byteCol0 = model ? charIndexToByteIndex(text, charCol0) : charCol0;
    this.init.sendNotify("nvim_win_set_cursor", [0, [lineNumber, byteCol0]]);
  }

  async sendNvimMouse(
    button: string,
    action: "press" | "drag" | "release" | "up" | "down",
    mods: string,
    pos: monaco.Position,
  ): Promise<void> {
    if (!this.init.isSessionRunning()) return;
    if (!this.init.getBufHandle()) return;
    const model = this.init.editor.getModel();
    if (!model) return;

    const lineNumber = Math.max(1, Number(pos.lineNumber) || 1);
    const colChar0 = Math.max(0, Number(pos.column) - 1 || 0);
    const text = model.getLineContent(lineNumber) ?? "";
    const col0 = charIndexToByteIndex(text, colChar0);
    const mod = String(mods ?? "");
    const btn = String(button ?? "left");
    const act = String(action ?? "press");
    const lua = `
local api, fn = vim.api, vim.fn
local button, action, mods, lnum, col0 = ...
pcall(api.nvim_win_set_cursor, 0, { lnum, col0 })
local row = (fn.winline() or 1) - 1
local col = (fn.wincol() or 1) - 1
pcall(api.nvim_input_mouse, button, action, mods, 0, row, col)
`;
    try {
      await this.init.execLua(lua, [btn, act, mod, lineNumber, col0]);
    } catch (_) {
    }
  }
}


import { expect, type Page } from "@playwright/test";

declare global {
  interface Window {
    nvimClient?: {
      execLua: <T = unknown>(code: string, args?: unknown[]) => Promise<T>;
      command: (cmd: string) => void;
    };
    monacoEditor?: {
      focus?: () => void;
      getModel: () => { getValue: () => string } | null;
      getPosition: () => { lineNumber: number; column: number } | null;
    };
  }
}

export async function waitForAppReady(page: Page) {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready", { timeout: process.env.CI ? 30_000 : 20_000 });
  await page.evaluate(() => {
    window.monacoEditor?.focus?.();
  });
}

export async function execLua<T = unknown>(page: Page, code: string, args: unknown[] = []): Promise<T> {
  return await page.evaluate(async ({ code, args }) => {
    if (!window.nvimClient) throw new Error("window.nvimClient missing");
    return await window.nvimClient.execLua(code, args);
  }, { code, args }) as T;
}

export async function getMonacoValue(page: Page): Promise<string> {
  return await page.evaluate(() => {
    if (!window.monacoEditor) throw new Error("window.monacoEditor missing");
    const raw = window.monacoEditor.getModel()?.getValue() ?? "";
    // Normalize line endings so E2E stays stable across Monaco EOL settings / environments.
    return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  });
}

export async function waitForMonacoValue(page: Page, expected: string) {
  await expect.poll(async () => await getMonacoValue(page)).toBe(expected);
}

export async function getMonacoPosition(page: Page): Promise<{ row: number; col: number }> {
  return await page.evaluate(() => {
    if (!window.monacoEditor) throw new Error("window.monacoEditor missing");
    const pos = window.monacoEditor.getPosition();
    if (!pos) return { row: 1, col: 1 };
    return { row: pos.lineNumber, col: pos.column };
  });
}

export async function waitForMonacoCursor(page: Page, expected: { row: number; col: number }) {
  await expect.poll(async () => await getMonacoPosition(page)).toEqual(expected);
}

export async function getMonacoDecorationCounts(page: Page): Promise<{ visual: number; search: number }> {
  return await page.evaluate(() => {
    if (!window.monacoEditor) throw new Error("window.monacoEditor missing");
    const model = window.monacoEditor.getModel();
    if (!model || typeof (model as any).getAllDecorations !== "function") return { visual: 0, search: 0 };
    const all = (model as any).getAllDecorations() as Array<{ options?: any }> | null;
    const decos = Array.isArray(all) ? all : [];
    const visual = decos.filter((d) => d?.options?.inlineClassName === "monaco-neovim-visual-inline"
      || d?.options?.className === "monaco-neovim-visual-inline"
      || d?.options?.className === "monaco-neovim-visual-line").length
      // Visual-block highlights are rendered via a DOM overlay to support virtual
      // spaces past EOL.
      + document.querySelectorAll(".monaco-neovim-visual-virtual").length;
    const search = decos.filter((d) => d?.options?.inlineClassName === "monaco-neovim-search-current" || d?.options?.inlineClassName === "monaco-neovim-search-match").length;
    return { visual, search };
  });
}

export async function waitForMonacoVisualDecorations(page: Page, atLeast = 1) {
  await expect.poll(async () => (await getMonacoDecorationCounts(page)).visual).toBeGreaterThanOrEqual(atLeast);
}

export async function waitForNoMonacoVisualDecorations(page: Page) {
  await expect.poll(async () => (await getMonacoDecorationCounts(page)).visual).toBe(0);
}

export async function feedKeys(page: Page, keys: string, mode = "n") {
  await execLua(page, `
    local tc = vim.api.nvim_replace_termcodes
    local keys, mode = ...
    vim.api.nvim_feedkeys(tc(keys, true, false, true), mode, false)
    return true
  `, [String(keys ?? ""), String(mode ?? "n")]);
}

export async function setBuffer(page: Page, lines: string[]) {
  await execLua(page, `
    local tc = vim.api.nvim_replace_termcodes
    vim.api.nvim_feedkeys(tc("<Esc>", true, false, true), "n", false)
    vim.api.nvim_buf_set_lines(0, 0, -1, false, ...)
    vim.api.nvim_win_set_cursor(0, { 1, 0 })
    return true
  `, [lines]);
  await waitForNvimBuffer(page, lines);
  await waitForCursor(page, { row: 1, col: 0 });
  await waitForMonacoCursor(page, { row: 1, col: 1 });
  await waitForMode(page, "n");
}

export async function getBufferLines(page: Page): Promise<string[]> {
  return await execLua(page, `return vim.api.nvim_buf_get_lines(0, 0, -1, false)`);
}

export async function getCursor(page: Page): Promise<{ row: number; col: number }> {
  const cur = await execLua<[number, number]>(page, `return vim.api.nvim_win_get_cursor(0)`);
  return { row: cur[0], col: cur[1] };
}

export async function getMode(page: Page): Promise<string> {
  const m = await execLua<{ mode: string }>(page, `return vim.api.nvim_get_mode()`);
  return m.mode;
}

export async function waitForMode(page: Page, mode: string) {
  await expect.poll(async () => await getMode(page)).toBe(mode);
}

export async function waitForNvimBuffer(page: Page, expectedLines: string[]) {
  const expectedValue = expectedLines.join("\n");
  await expect
    .poll(async () => {
      const [nvimLines, monacoValue] = await Promise.all([getBufferLines(page), getMonacoValue(page)]);
      const normalizedMonacoValue = monacoValue === `${expectedValue}\n` ? expectedValue : monacoValue;
      return { nvimLines, monacoValue: normalizedMonacoValue };
    })
    .toEqual({ nvimLines: expectedLines, monacoValue: expectedValue });
}

export async function waitForCursor(page: Page, expected: { row: number; col: number }) {
  await expect.poll(async () => await getCursor(page)).toEqual(expected);
}

export async function command(page: Page, cmd: string) {
  await page.evaluate((cmd) => {
    if (!window.nvimClient) throw new Error("window.nvimClient missing");
    window.nvimClient.command(cmd);
  }, cmd);
}

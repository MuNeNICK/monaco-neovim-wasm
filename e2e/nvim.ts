import { expect, type Page } from "@playwright/test";

declare global {
  interface Window {
    nvimClient?: {
      execLua: <T = unknown>(code: string, args?: unknown[]) => Promise<T>;
      command: (cmd: string) => void;
    };
  }
}

export async function waitForAppReady(page: Page) {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>(".monaco-editor textarea");
    el?.focus();
  });
}

export async function execLua<T = unknown>(page: Page, code: string, args: unknown[] = []): Promise<T> {
  return await page.evaluate(async ({ code, args }) => {
    if (!window.nvimClient) throw new Error("window.nvimClient missing");
    return await window.nvimClient.execLua(code, args);
  }, { code, args }) as T;
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
  await expect.poll(async () => await getBufferLines(page)).toEqual(expectedLines);
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

import { test, expect } from "@playwright/test";
import { execLua, getBufferLines, getCursor, getMonacoValue, setBuffer, waitForAppReady, waitForCursor, waitForMode, waitForMonacoCursor, waitForNvimBuffer } from "../helpers/nvim";

const keyDelayMs = 20;

test.describe("Basic Editing", () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    await execLua(page, `
      vim.o.swapfile = false
      vim.o.undofile = false
      vim.o.wrap = false
      vim.o.timeout = false
      vim.o.ttimeout = false
      vim.o.clipboard = ""
      return true
    `);
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
  });

  test("insert text, escape to normal", async ({ page }) => {
    await setBuffer(page, [""]);
    await page.keyboard.press("i");
    await waitForMode(page, "i");
    await page.keyboard.type("hello", { delay: keyDelayMs });
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
    await waitForNvimBuffer(page, ["hello"]);
    await waitForCursor(page, { row: 1, col: 4 });
  });

  test("insert: cursor stable after arrows + escape", async ({ page }) => {
    await setBuffer(page, ["abcd"]);
    await page.keyboard.press("0");
    await page.keyboard.press("i");
    await waitForMode(page, "i");
    await page.keyboard.type("XYZ", { delay: keyDelayMs });
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("!", { delay: keyDelayMs });
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
    await waitForNvimBuffer(page, ["X!YZabcd"]);
    await waitForCursor(page, { row: 1, col: 1 });
  });

  test("delegated insert: multiline then escape keeps cursor on last inserted char", async ({ page }) => {
    await setBuffer(page, [""]);
    await page.keyboard.press("i");
    await waitForMode(page, "i");
    await page.keyboard.type("aiueo", { delay: keyDelayMs });
    await page.keyboard.press("Enter");
    await page.keyboard.type("aiueo", { delay: keyDelayMs });
    await page.keyboard.press("Enter");
    await page.keyboard.type("aiueo", { delay: keyDelayMs });
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
    await waitForNvimBuffer(page, ["aiueo", "aiueo", "aiueo"]);
    await waitForCursor(page, { row: 3, col: 4 });
  });

  test("file-like operations stay in sync (buffer<->cursor)", async ({ page }) => {
    await setBuffer(page, ["start"]);
    await page.keyboard.press("o");
    await waitForMode(page, "i");
    await page.keyboard.type("next", { delay: keyDelayMs });
    await page.keyboard.press("Escape");
    await waitForNvimBuffer(page, ["start", "next"]);

    await page.keyboard.press("k");
    await page.keyboard.type("yy", { delay: keyDelayMs });
    await page.keyboard.press("G");
    await page.keyboard.press("p");
    await waitForNvimBuffer(page, ["start", "next", "start"]);
  });

  test("no unexpected warnings during basic operations", async ({ page }) => {
    await setBuffer(page, ["warnings?"]);
    await page.keyboard.press("i");
    await page.keyboard.type(" ok", { delay: keyDelayMs });
    await page.keyboard.press("Escape");
    const status = await page.locator("#status").textContent();
    expect(status).not.toMatch(/WARN/i);
  });

  test("normal: Backspace does not delete Monaco-only selection", async ({ page }) => {
    await setBuffer(page, ["abcdef"]);
    await page.evaluate(() => {
      if (!window.monacoEditor) throw new Error("window.monacoEditor missing");
      window.monacoEditor.setSelection({ startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 5 } as any);
    });
    await page.keyboard.press("Backspace");
    await waitForMode(page, "n");
    await waitForNvimBuffer(page, ["abcdef"]);
  });

  test("utf-8 cursor sync: nvim byte col <-> monaco char col", async ({ page }) => {
    await setBuffer(page, ["aあb"]);
    await waitForCursor(page, { row: 1, col: 0 });
    await waitForMonacoCursor(page, { row: 1, col: 1 });

    await page.keyboard.press("l");
    await waitForCursor(page, { row: 1, col: 1 });
    await waitForMonacoCursor(page, { row: 1, col: 2 });

    await page.keyboard.press("l");
    await waitForCursor(page, { row: 1, col: 4 });
    await waitForMonacoCursor(page, { row: 1, col: 3 });

    await page.keyboard.press("i");
    await waitForMode(page, "i");
    await page.keyboard.type("う", { delay: keyDelayMs });
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
    await waitForNvimBuffer(page, ["aあうb"]);
    await waitForCursor(page, { row: 1, col: 4 });
    await waitForMonacoCursor(page, { row: 1, col: 3 });
  });
});

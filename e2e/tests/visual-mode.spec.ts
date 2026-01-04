import { test, expect } from "@playwright/test";
import { execLua, getCursor, setBuffer, waitForAppReady, waitForCursor, waitForMode, waitForMonacoVisualDecorations, waitForNoMonacoVisualDecorations, waitForNvimBuffer } from "../helpers/nvim";

const keyDelayMs = 20;

test.describe("Visual Mode", () => {
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

  test("visual char selection + y/p", async ({ page }) => {
    await setBuffer(page, ["abcdef"]);
    await page.keyboard.press("v");
    await waitForMode(page, "v");
    await page.keyboard.press("l");
    await page.keyboard.press("l");
    await page.keyboard.press("y");
    await waitForMode(page, "n");
    await page.keyboard.press("p");
    await waitForNvimBuffer(page, ["aabcbcdef"]);
  });

  test("visual mode: entering does not move cursor", async ({ page }) => {
    await setBuffer(page, ["alpha beta", "second line"]);
    await page.keyboard.press("j");
    await page.keyboard.press("w");
    const before = await getCursor(page);
    await page.keyboard.press("v");
    await waitForMode(page, "v");
    await expect.poll(async () => await getCursor(page)).toEqual(before);
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
  });

  test("mouse click then visual: cursor does not jump", async ({ page }) => {
    await setBuffer(page, ["abcdef", "ghijkl"]);
    await page.evaluate(() => (window as any).monacoEditor?.layout?.());

    const { x, y } = await page.evaluate(() => {
      const editor = (window as any).monacoEditor;
      if (!editor) throw new Error("window.monacoEditor missing");
      const root = editor.getDomNode?.();
      if (!root) throw new Error("editor dom missing");
      const rootRect = root.getBoundingClientRect();
      const sp = editor.getScrolledVisiblePosition?.({ lineNumber: 2, column: 3 });
      if (!sp) throw new Error("no scrolled position");
      return { x: rootRect.left + sp.left + 1, y: rootRect.top + sp.top + Math.floor(sp.height / 2) };
    });

    await page.mouse.click(x, y);
    await waitForCursor(page, { row: 2, col: 2 });

    const before = await getCursor(page);
    await page.keyboard.press("v");
    await waitForMode(page, "v");
    await expect.poll(async () => await getCursor(page)).toEqual(before);
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
  });

  test("visual: escape exits and clears decorations", async ({ page }) => {
    await setBuffer(page, ["abcdef"]);
    await page.keyboard.press("v");
    await waitForMode(page, "v");
    await page.keyboard.press("l");
    await waitForMonacoVisualDecorations(page, 1);
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
    await waitForNoMonacoVisualDecorations(page);
  });

  test("visual line selection + d", async ({ page }) => {
    await setBuffer(page, ["line1", "line2", "line3"]);
    await page.keyboard.press("Shift+V");
    await waitForMode(page, "V");
    await page.keyboard.press("j");
    await page.keyboard.press("d");
    await waitForNvimBuffer(page, ["line3"]);
  });

  test("visual block: <C-v> via keyboard (no paste)", async ({ page }) => {
    await setBuffer(page, ["a", "b", "c"]);
    await page.keyboard.press("Control+V");
    await waitForMode(page, "\u0016");
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await waitForMonacoVisualDecorations(page, 2);
    await page.keyboard.press("Shift+I");
    await waitForMode(page, "i");
    await page.keyboard.type("> ", { delay: keyDelayMs });
    await page.keyboard.press("Escape");
    await waitForNvimBuffer(page, ["> a", "> b", "> c"]);
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
    await waitForNoMonacoVisualDecorations(page);
  });

  test("visual block: highlights virtual spaces past EOL", async ({ page }) => {
    await execLua(page, `vim.o.virtualedit = "block"; return true`);
    await setBuffer(page, ["abcd", "a"]);

    await page.keyboard.press("Control+V");
    await waitForMode(page, "\u0016");
    await page.keyboard.press("j");
    await page.keyboard.type("4|", { delay: keyDelayMs });
    await expect.poll(async () => await execLua<number>(page, `return vim.fn.virtcol(".")`)).toBe(4);

    await waitForMonacoVisualDecorations(page, 1);

    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
    await waitForNoMonacoVisualDecorations(page);
  });
});

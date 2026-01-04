import { test } from "@playwright/test";
import { execLua, getBufferLines, setBuffer, waitForAppReady, waitForCursor, waitForMode, waitForNvimBuffer } from "../helpers/nvim";

const keyDelayMs = 20;

test.describe("Motions", () => {
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

  test("basic motions: w/b/0/$/gg/G", async ({ page }) => {
    await setBuffer(page, ["alpha beta gamma", "second line"]);

    await page.keyboard.press("w");
    await waitForCursor(page, { row: 1, col: 6 });

    await page.keyboard.press("w");
    await waitForCursor(page, { row: 1, col: 11 });

    await page.keyboard.press("b");
    await waitForCursor(page, { row: 1, col: 6 });

    await page.keyboard.press("End");
    await page.keyboard.press("$");
    const line1 = (await getBufferLines(page))[0]!;
    await waitForCursor(page, { row: 1, col: Math.max(0, line1.length - 1) });

    await page.keyboard.press("0");
    await waitForCursor(page, { row: 1, col: 0 });

    await page.keyboard.press("G");
    await waitForCursor(page, { row: 2, col: 0 });

    await page.keyboard.press("g");
    await page.keyboard.press("g");
    await waitForCursor(page, { row: 1, col: 0 });
  });

  test("find-char motions: f/t + ;/,", async ({ page }) => {
    await setBuffer(page, ["a_b_c_d"]);
    await page.keyboard.type("f_", { delay: keyDelayMs });
    await waitForCursor(page, { row: 1, col: 1 });
    await page.keyboard.press(";");
    await waitForCursor(page, { row: 1, col: 3 });
    await page.keyboard.press(",");
    await waitForCursor(page, { row: 1, col: 1 });

    await page.keyboard.press("0");
    await page.keyboard.type("t_", { delay: keyDelayMs });
    await waitForCursor(page, { row: 1, col: 0 });
  });

  test("counts: 3w and 2dd", async ({ page }) => {
    await setBuffer(page, ["one two three four five", "a", "b", "c"]);
    await page.keyboard.type("3w", { delay: keyDelayMs });
    await waitForCursor(page, { row: 1, col: 14 });

    await page.keyboard.press("j");
    await page.keyboard.type("2dd", { delay: keyDelayMs });
    await waitForNvimBuffer(page, ["one two three four five", "c"]);
  });
});

import { test, expect } from "@playwright/test";
import { execLua, getCursor, setBuffer, waitForAppReady, waitForCursor, waitForMode, waitForNvimBuffer } from "../helpers/nvim";

const keyDelayMs = 20;

test.describe("Advanced Features", () => {
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

  test("search /, n, N", async ({ page }) => {
    await setBuffer(page, ["foo bar foo baz foo"]);
    await page.keyboard.type("/", { delay: keyDelayMs });
    await waitForMode(page, "c");
    await page.keyboard.type("foo", { delay: keyDelayMs });
    await page.keyboard.press("Enter");
    await waitForMode(page, "n");
    await expect.poll(async () => await execLua(page, `return vim.fn.expand("<cword>")`)).toBe("foo");

    const colAfterEnter = (await getCursor(page)).col;
    await page.keyboard.press("n");
    await expect.poll(async () => (await getCursor(page)).col).not.toBe(colAfterEnter);
    await expect.poll(async () => await execLua(page, `return vim.fn.expand("<cword>")`)).toBe("foo");

    await page.keyboard.press("N");
    await expect.poll(async () => (await getCursor(page)).col).toBe(colAfterEnter);
    await expect.poll(async () => await execLua(page, `return vim.fn.expand("<cword>")`)).toBe("foo");
  });

  test("macro: qa...q then @a", async ({ page }) => {
    await setBuffer(page, ["one", "two", "three"]);
    await page.keyboard.press("q");
    await page.keyboard.press("a");
    await page.keyboard.press("Shift+I");
    await waitForMode(page, "i");
    await page.keyboard.type("> ", { delay: keyDelayMs });
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
    await page.keyboard.press("j");
    await page.keyboard.press("q");
    await waitForMode(page, "n");

    await waitForNvimBuffer(page, ["> one", "two", "three"]);
    const regA = await execLua<string>(page, `return vim.fn.getreg("a")`);
    expect(regA.length).toBeGreaterThan(0);
    await execLua(page, `
      vim.api.nvim_win_set_cursor(0, { 2, 0 })
      vim.cmd("normal! @a")
      return true
    `);
    await waitForNvimBuffer(page, ["> one", "> two", "three"]);
  });

  test("macro: playback via keyboard @a after delegated insert", async ({ page }) => {
    await setBuffer(page, ["one", "two"]);

    await page.keyboard.press("q");
    await page.keyboard.press("a");
    await page.keyboard.press("Shift+I");
    await waitForMode(page, "i");
    await page.keyboard.type("> ", { delay: keyDelayMs });
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
    await page.keyboard.press("j");
    await page.keyboard.press("q");
    await waitForMode(page, "n");

    // Trigger insert delegation (Monaco-owned typing), then immediately run a macro.
    await page.keyboard.press("0");
    await page.keyboard.press("i");
    await waitForMode(page, "i");
    await page.keyboard.type("x", { delay: keyDelayMs });
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");

    await page.keyboard.type("@a", { delay: keyDelayMs });
    await waitForNvimBuffer(page, ["> one", "> xtwo"]);
  });

  test("marks: ma then jump with `a", async ({ page }) => {
    await setBuffer(page, ["aaa", "bbb", "ccc"]);
    await page.keyboard.press("j");
    await page.keyboard.type("ma");
    await page.keyboard.press("G");
    await waitForCursor(page, { row: 3, col: 0 });
    await page.keyboard.press("`");
    await page.keyboard.press("a");
    await waitForCursor(page, { row: 2, col: 0 });
  });

  test("ex command: :%s substitution", async ({ page }) => {
    await setBuffer(page, ["foo bar foo", "foo"]);
    await page.keyboard.type(":", { delay: keyDelayMs });
    await waitForMode(page, "c");
    await page.keyboard.type("%s/foo/qux/g", { delay: keyDelayMs });
    await expect.poll(async () => await execLua(page, `return vim.fn.getcmdline()`)).toBe("%s/foo/qux/g");
    await page.keyboard.press("Enter");
    await waitForMode(page, "n");
    await waitForNvimBuffer(page, ["qux bar qux", "qux"]);
  });
});

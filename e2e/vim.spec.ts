import { test, expect } from "@playwright/test";
import { command, execLua, getBufferLines, getCursor, setBuffer, waitForAppReady, waitForCursor, waitForMode, waitForNvimBuffer } from "./nvim";

const keyDelayMs = 20;

test.describe("Monaco Neovim WASM - Vim E2E", () => {
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

  test("operators: dw, dd, x, p", async ({ page }) => {
    await setBuffer(page, ["one two three", "four five"]);

    await page.keyboard.type("dw", { delay: keyDelayMs });
    await waitForNvimBuffer(page, ["two three", "four five"]);

    await page.keyboard.press("j");
    await page.keyboard.type("dd", { delay: keyDelayMs });
    await waitForNvimBuffer(page, ["two three"]);

    await page.keyboard.press("p");
    await waitForNvimBuffer(page, ["two three", "four five"]);

    await page.keyboard.press("k");
    await page.keyboard.press("0");
    await page.keyboard.press("x");
    await waitForNvimBuffer(page, ["wo three", "four five"]);

    await page.keyboard.press("p");
    await waitForNvimBuffer(page, ["wto three", "four five"]);
  });

  test("change word via ciw", async ({ page }) => {
    await setBuffer(page, ["foo bar baz"]);
    await page.keyboard.press("w");
    await waitForCursor(page, { row: 1, col: 4 });
    await page.keyboard.type("ciw", { delay: keyDelayMs });
    await waitForMode(page, "i");
    await page.keyboard.type("qux", { delay: keyDelayMs });
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
    await waitForNvimBuffer(page, ["foo qux baz"]);
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

  test("visual line selection + d", async ({ page }) => {
    await setBuffer(page, ["line1", "line2", "line3"]);
    await page.keyboard.press("Shift+V");
    await waitForMode(page, "V");
    await page.keyboard.press("j");
    await page.keyboard.press("d");
    await waitForNvimBuffer(page, ["line3"]);
  });

  test("search /, n, N", async ({ page }) => {
    await setBuffer(page, ["foo bar foo baz foo"]);
    await page.keyboard.type("/", { delay: keyDelayMs });
    await waitForMode(page, "c");
    await page.keyboard.type("foo", { delay: keyDelayMs });
    await page.keyboard.press("Enter");
    await waitForMode(page, "n");
    await expect.poll(async () => await execLua(page, `return vim.fn.expand("<cword>")`)).toBe("foo");

    await page.keyboard.press("n");
    await expect.poll(async () => (await getCursor(page)).col).toBeGreaterThan(5);
    await expect.poll(async () => await execLua(page, `return vim.fn.expand("<cword>")`)).toBe("foo");

    await page.keyboard.press("N");
    await expect.poll(async () => (await getCursor(page)).col).toBeLessThan(5);
    await expect.poll(async () => await execLua(page, `return vim.fn.expand("<cword>")`)).toBe("foo");
  });

  test("undo (u) after insert", async ({ page }) => {
    await setBuffer(page, ["hello"]);
    await page.keyboard.press("A");
    await waitForMode(page, "i");
    await page.keyboard.type(" world", { delay: keyDelayMs });
    await page.keyboard.press("Escape");
    await waitForNvimBuffer(page, ["hello world"]);
    await page.keyboard.press("u");
    await waitForNvimBuffer(page, ["hello"]);
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

  test("counts: 3w and 2dd", async ({ page }) => {
    await setBuffer(page, ["one two three four five", "a", "b", "c"]);
    await page.keyboard.type("3w", { delay: keyDelayMs });
    await waitForCursor(page, { row: 1, col: 14 });

    await page.keyboard.press("j");
    await page.keyboard.type("2dd", { delay: keyDelayMs });
    await waitForNvimBuffer(page, ["one two three four five", "c"]);
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

  test("text objects: diw", async ({ page }) => {
    await setBuffer(page, ["one two three"]);
    await page.keyboard.press("w");
    await page.keyboard.type("diw", { delay: keyDelayMs });
    await waitForNvimBuffer(page, ["one  three"]);
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
});

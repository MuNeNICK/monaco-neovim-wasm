import { test } from "@playwright/test";
import { execLua, setBuffer, waitForAppReady, waitForCursor, waitForMode, waitForNvimBuffer } from "../helpers/nvim";

const keyDelayMs = 20;

test.describe("Operators", () => {
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

  test("text objects: diw", async ({ page }) => {
    await setBuffer(page, ["one two three"]);
    await page.keyboard.press("w");
    await page.keyboard.type("diw", { delay: keyDelayMs });
    await waitForNvimBuffer(page, ["one  three"]);
  });

  test("text objects: ci\" and di(", async ({ page }) => {
    await setBuffer(page, ["print(\"hello world\")", "func(foo, bar)"]);

    await page.keyboard.type("f\"", { delay: keyDelayMs });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type("ci\"", { delay: keyDelayMs });
    await waitForMode(page, "i");
    await page.keyboard.type("bye", { delay: keyDelayMs });
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
    await waitForNvimBuffer(page, ["print(\"bye\")", "func(foo, bar)"]);

    await page.keyboard.press("j");
    await page.keyboard.type("f(", { delay: keyDelayMs });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type("di(", { delay: keyDelayMs });
    await waitForNvimBuffer(page, ["print(\"bye\")", "func()"]);
  });

  test("repeat: . (dot) after operator", async ({ page }) => {
    await setBuffer(page, ["one two three"]);
    await page.keyboard.type("dw", { delay: keyDelayMs });
    await waitForNvimBuffer(page, ["two three"]);
    await page.keyboard.press(".");
    await waitForNvimBuffer(page, ["three"]);
  });

  test("repeat: . (dot) after insert (including backspace)", async ({ page }) => {
    await setBuffer(page, ["aaa bbb", "aaa bbb"]);

    await page.keyboard.type("cw", { delay: keyDelayMs });
    await waitForMode(page, "i");
    await page.keyboard.type("helloo", { delay: keyDelayMs });
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
    await waitForNvimBuffer(page, ["hello bbb", "aaa bbb"]);

    await page.keyboard.press("j");
    await page.keyboard.press("0");
    await page.keyboard.press(".");
    await waitForNvimBuffer(page, ["hello bbb", "hello bbb"]);
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

  test("redo (<C-r>) after undo", async ({ page }) => {
    await setBuffer(page, ["hello"]);
    await page.keyboard.press("A");
    await waitForMode(page, "i");
    await page.keyboard.type(" world", { delay: keyDelayMs });
    await page.keyboard.press("Escape");
    await waitForMode(page, "n");
    await waitForNvimBuffer(page, ["hello world"]);

    await page.keyboard.press("u");
    await waitForNvimBuffer(page, ["hello"]);

    await page.keyboard.press("Control+R");
    await waitForNvimBuffer(page, ["hello world"]);
  });

  test("join lines (J) and indent/unindent (>>/<<)", async ({ page }) => {
    await execLua(page, `
      vim.o.expandtab = true
      vim.o.shiftwidth = 2
      vim.o.tabstop = 2
      return true
    `);
    await setBuffer(page, ["one", "two", "three"]);

    await page.keyboard.type("3J", { delay: keyDelayMs });
    await waitForNvimBuffer(page, ["one two three"]);

    await page.keyboard.type(">>", { delay: keyDelayMs });
    await waitForNvimBuffer(page, ["  one two three"]);
    await page.keyboard.type("<<", { delay: keyDelayMs });
    await waitForNvimBuffer(page, ["one two three"]);
  });

  test("registers: linewise P and named register \"a", async ({ page }) => {
    await setBuffer(page, ["one", "two"]);
    await page.keyboard.type("yy", { delay: keyDelayMs });
    await page.keyboard.press("j");
    await page.keyboard.press("P");
    await waitForNvimBuffer(page, ["one", "one", "two"]);

    await setBuffer(page, ["one", "two"]);
    await page.keyboard.type("\"ayy", { delay: keyDelayMs });
    await page.keyboard.press("j");
    await page.keyboard.type("\"ap", { delay: keyDelayMs });
    await waitForNvimBuffer(page, ["one", "two", "one"]);
  });
});

import { expect, test, type Page } from "@playwright/test";

const functionKeys = [
  ["F1", "\x1bOP"], ["F2", "\x1bOQ"], ["F3", "\x1bOR"], ["F4", "\x1bOS"],
  ["F5", "\x1b[15~"], ["F6", "\x1b[17~"], ["F7", "\x1b[18~"], ["F8", "\x1b[19~"],
  ["F9", "\x1b[20~"], ["F10", "\x1b[21~"], ["F11", "\x1b[23~"], ["F12", "\x1b[24~"],
] as const;
const inputs = (page: Page) => page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "input").map(input => input.data));

async function open(page: Page) {
  await page.goto("/tests/browser/terminal-output.html");
  await expect(page.locator("#connection")).toHaveText("open");
  await page.evaluate(() => {
    document.documentElement.dataset.functionKeyTest = "same-document";
    for (const type of ["keydown", "keyup"]) document.addEventListener(type, event => {
      if (/^F(?:[1-9]|1[0-2])$/.test((event as KeyboardEvent).key)) queueMicrotask(() => {
        if (!event.defaultPrevented) document.documentElement.dataset.uncanceledFunctionKey = (event as KeyboardEvent).key;
      });
    }, true);
  });
}

async function staysOnTerminalPage(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-function-key-test", "same-document");
  await expect(page.locator("html")).not.toHaveAttribute("data-uncanceled-function-key");
  expect(page.context().pages()).toHaveLength(1);
  expect(await page.evaluate(() => window.pipeline.count())).toBe(1);
}

test("focused terminal sends F1–F12 once and cancels browser defaults on press and release", async ({ page }) => {
  await open(page);
  const terminal = page.locator(".xterm-helper-textarea");
  await terminal.focus();
  const expected: string[] = [];
  for (const [key, data] of functionKeys) {
    await page.keyboard.press(key);
    expected.push(data);
    expect(await inputs(page)).toEqual(expected);
    await expect(terminal).toBeFocused();
  }
  await staysOnTerminalPage(page);
});

for (const focus of ["page", "toolbar"] as const) {
  test(`F1–F12 still reach the terminal after ${focus} takes focus`, async ({ page }) => {
    await open(page);
    const expected: string[] = [];
    // F2 first catches the lost-focus case without first opening browser help.
    for (const [key, data] of [functionKeys[1], functionKeys[0], ...functionKeys.slice(2)]) {
      if (focus === "toolbar") await page.locator("#copy").click();
      else await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press(key);
      expected.push(data);
      expect(await inputs(page)).toEqual(expected);
      await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    }
    await staysOnTerminalPage(page);
  });
}

test("function keys preserve modifier encoding and held-key repeats", async ({ page }) => {
  await open(page);
  const modified = [
    ["Shift+F2", "\x1b[1;2Q"], ["Control+F2", "\x1b[1;5Q"], ["Alt+F2", "\x1b[1;3Q"],
    ["Meta+F2", "\x1b[1;9Q"], ["Control+Shift+F5", "\x1b[15;6~"], ["Shift+F12", "\x1b[24;2~"],
  ];
  const expected: string[] = [];
  for (const [key, data] of modified) {
    await page.locator("#copy").click();
    await page.keyboard.press(key);
    expected.push(data);
    expect(await inputs(page)).toEqual(expected);
  }
  await page.keyboard.down("F2");
  await page.keyboard.down("F2");
  await page.keyboard.up("F2");
  expect(await inputs(page)).toEqual([...expected, "\x1bOQ", "\x1bOQ"]);
  await staysOnTerminalPage(page);
});

test("a local text field keeps its focus and contents when function keys are pressed", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const field = document.createElement("input");
    field.id = "local-field";
    document.body.append(field);
  });
  const editor = page.locator("#local-field");
  await editor.fill("查找文件");
  for (const [key] of functionKeys) {
    await page.keyboard.press(key);
    await expect(editor).toBeFocused();
  }
  expect(await inputs(page)).toEqual([]);
  await expect(editor).toHaveValue("查找文件");
  await staysOnTerminalPage(page);
});

test("an open dialog keeps function keys out of the remote application", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "延迟诊断", exact: true }).click();
  const close = page.getByRole("button", { name: "关闭延迟诊断", exact: true });
  for (const [key] of functionKeys) {
    await page.keyboard.press(key);
    await expect(close).toBeFocused();
  }
  // Also cover dialogs that leave focus on the terminal or their trigger.
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("F2");
  expect(await inputs(page)).toEqual([]);
  await close.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await staysOnTerminalPage(page);
});

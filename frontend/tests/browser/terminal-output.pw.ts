import { expect, test } from "@playwright/test";

const fixture = "/tests/browser/terminal-output.html";
async function open(page: import("@playwright/test").Page, suffix = "") {
  await page.goto(fixture + suffix);
  await expect(page.locator("#connection")).toHaveText("open");
}

test("packet completion callbacks do not serialize a burst into hundreds of parser tasks", async ({ page }) => {
  await open(page);
  const writesBefore = await page.evaluate(() => window.pipeline.writes());
  await page.evaluate(() => {
    window.pipeline.frame({ type: "replay_start" });
    for (let index = 0; index < 300; index++) {
      window.pipeline.frame({ type: "output", seq: index + 1, data: `packet ${index}: 中文😀 ${"x".repeat(100)}\r\n` });
    }
    window.pipeline.frame({ type: "replay_end", seq: 300 });
  });
  await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain("packet 299:");
  expect(await page.evaluate(() => window.pipeline.writes()) - writesBefore).toBeLessThanOrEqual(5);
});

test("loading waits for visible output; replay replies are suppressed but keys work", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.pipeline.frame({ type: "replay_start" });
    window.pipeline.frame({ type: "output", seq: 1, data: "\x1b[2J\x1b[H\x1b[c" });
  });
  await expect(page.getByRole("status")).toHaveText("等待终端输出…");
  await expect(page.locator("#painted")).toHaveText("false");
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("x");
  await page.evaluate(() => {
    window.pipeline.frame({ type: "output", seq: 2, data: "Ready 中文😀" });
    window.pipeline.frame({ type: "replay_end", seq: 2 });
  });
  await expect(page.locator("#painted")).toHaveText("true");
  await expect(page.getByRole("status")).toHaveCount(0);
  const inputs = await page.evaluate(() => window.pipeline.inputs().filter((input) => input.type === "input"));
  expect(inputs).toEqual([{ type: "input", data: "x" }]);
});

test("ordered replay deduplicates packets and reconnect does not append history twice", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.pipeline.frame({ type: "replay_start" });
    window.pipeline.frame({ type: "output", seq: 1, data: "First\r\n" });
    window.pipeline.frame({ type: "output", seq: 1, data: "DUPLICATE" });
    window.pipeline.frame({ type: "output", seq: 2, data: "Second\r\n" });
    window.pipeline.frame({ type: "replay_end", seq: 2 });
    window.pipeline.frame({ type: "output", seq: 3, data: "Third" });
  });
  await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain("First\nSecond\nThird");
  await page.locator("#reconnect").click();
  await expect.poll(() => page.evaluate(() => window.pipeline.count())).toBe(2);
  await page.evaluate(() => {
    window.pipeline.frame({ type: "replay_start" });
    window.pipeline.frame({ type: "output", seq: 3, data: "First\r\nSecond\r\nThird" });
    window.pipeline.frame({ type: "replay_end", seq: 3 });
  });
  await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain("First\nSecond\nThird");
  const screen = await page.evaluate(() => window.pipeline.screen());
  expect(screen.match(/First/g)).toHaveLength(1);
  expect(screen).not.toContain("DUPLICATE");
});

test("continuous output preserves the reader's text even when scrollback evicts rows", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("terminal-scrollback-lines", "5000"));
  await open(page);
  await page.evaluate(() => {
    window.pipeline.frame({ type: "replay_start" });
    window.pipeline.frame({ type: "output", seq: 1, data: Array.from({ length: 5100 }, (_, i) => `row ${i}\r\n`).join("") });
    window.pipeline.frame({ type: "replay_end", seq: 1 });
  });
  await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain("row 5099");
  await page.evaluate(() => window.pipeline.scroll(250));
  await page.waitForTimeout(180);
  const top = await page.evaluate(() => window.pipeline.top());
  await page.evaluate(() => {
    for (let i = 0; i < 100; i++) window.pipeline.frame({ type: "output", seq: i + 2, data: `new ${i}\r\n` });
  });
  await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain("new 99");
  expect(await page.evaluate(() => window.pipeline.top())).toBe(top);
  expect(await page.evaluate(() => window.pipeline.history())).toBe(5000);
});

test("Ctrl+C copies a selection and remains an interrupt without one", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.pipeline.frame({ type: "replay_start" });
    window.pipeline.frame({ type: "output", seq: 1, data: "Copy Chinese 中文😀" });
    window.pipeline.frame({ type: "replay_end", seq: 1 });
  });
  await expect(page.locator("#painted")).toHaveText("true");
  await page.evaluate(() => window.pipeline.select());
  const selected = await page.evaluate(() => window.pipeline.selected());
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  await expect(page.locator("#copied")).toHaveText(selected);
  expect(await page.evaluate(() => window.pipeline.inputs().filter((input) => input.type === "input"))).toEqual([]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+c");
  expect(await page.evaluate(() => window.pipeline.inputs().filter((input) => input.data === "\x03"))).toHaveLength(1);
});

test("legacy raw output resembling a protocol frame is displayed as text", async ({ page }) => {
  await open(page, "?legacy=1");
  const literal = '{"type":"replay_start"}';
  await page.evaluate((text) => window.pipeline.frame(text), literal);
  await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain(literal);
});

test("large Unicode output remains intact when copied across parser chunk boundaries", async ({ page }) => {
  await open(page);
  const lines = Array.from({ length: 1800 }, (_, i) => `${i}: 中文😀 e\u0301 text`);
  await page.evaluate((lines) => {
    window.pipeline.frame({ type: "replay_start" });
    window.pipeline.frame({ type: "output", seq: 1, data: "\x1b[32m" + lines.join("\r\n") + "\x1b[0m" });
    window.pipeline.frame({ type: "replay_end", seq: 1 });
  }, lines);
  await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain("1799: 中文😀");
  await page.evaluate(() => window.pipeline.selectAll());
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+Shift+c");
  await expect(page.locator("#copied")).toHaveText(lines.join("\n"), { useInnerText: false });
});

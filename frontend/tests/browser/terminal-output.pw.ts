import { expect, test } from "@playwright/test";

const fixture = "/tests/browser/terminal-output.html";
async function open(page: import("@playwright/test").Page, suffix = "") {
  await page.goto(fixture + suffix);
  await expect(page.locator("#connection")).toHaveText("open");
}

for (const enhanced of [false, true]) test(`${enhanced ? "enhanced" : "plain"} sessions never announce colors as shell input on open, theme change or reconnect`, async ({ page }) => {
  await open(page, enhanced ? "?enhanced=1" : "");
  const inputs = () => page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "input"));
  expect(await inputs()).toEqual([]);
  await page.evaluate(() => { window.pipeline.theme(false); window.pipeline.theme(true); });
  expect(await inputs()).toEqual([]);
  await page.locator("#reconnect").click();
  await expect.poll(() => page.evaluate(() => window.pipeline.count())).toBe(2);
  await expect(page.locator("#connection")).toHaveText("open");
  expect(await inputs()).toEqual([]);
});

test("replayed color queries stay silent while live color queries still receive an answer", async ({ page }) => {
  await open(page, "?enhanced=1");
  const query = "\x1b]10;?\x07\x1b]11;?\x1b\\\x1b]12;?\x07";
  await page.evaluate(query => {
    window.pipeline.frame({ type: "replay_start" });
    // Split an OSC query across packets.
    window.pipeline.frame({ type: "output", seq: 1, data: query.slice(0, 13) });
    window.pipeline.frame({ type: "output", seq: 2, data: query.slice(13) + "Restored shell\r\n$ " });
    window.pipeline.frame({ type: "replay_end", seq: 2 });
  }, query);
  await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain("Restored shell");
  expect(await page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "input"))).toEqual([]);
  await page.evaluate(query => window.pipeline.frame({ type: "output", seq: 3, data: query }), query);
  await expect.poll(() => page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "input").map(input => input.data)))
    .toEqual(["\x1b]10;rgb:ffff/ffff/ffff\x1b\\", "\x1b]11;rgb:1717/1717/1717\x1b\\", "\x1b]12;rgb:ffff/ffff/ffff\x1b\\"]);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText("echo rgb:ffff/ffff/ffff");
  await expect.poll(() => page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "input").at(-1)?.data))
    .toBe("echo rgb:ffff/ffff/ffff");
});

test("terminal pongs measure the existing socket without becoming shell output", async ({ page }) => {
  await open(page, "?pingDelay=75");
  await expect.poll(async () => Number(await page.locator("#latency").textContent())).toBeGreaterThanOrEqual(75);
  expect(await page.evaluate(() => window.pipeline.screen())).not.toContain("pong");
  expect(await page.evaluate(() => window.pipeline.inputs().filter((input) => input.type === "input"))).toEqual([]);
  await page.locator("#reconnect").click();
  await expect.poll(() => page.evaluate(() => window.pipeline.count())).toBe(2);
  await expect.poll(async () => Number(await page.locator("#latency").textContent())).toBeGreaterThanOrEqual(75);
});

test("servers without pong support keep the terminal usable", async ({ page }) => {
  await open(page, "?noPong");
  await expect(page.locator("#latency")).toHaveText("unknown");
  await page.evaluate(() => window.pipeline.frame({ type: "output", seq: 1, data: "Ready" }));
  await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain("Ready");
});

test("a v1 server supports direct input without output acknowledgements", async ({ page }) => {
  await open(page, "?v1=1");
  await page.evaluate(() => window.pipeline.frame({ type: "output", seq: 1, data: "Ready 中文😀" }));
  await expect(page.locator("#painted")).toHaveText("true");
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText("兼容旧后端");
  await expect.poll(() => page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "input")))
    .toEqual([{ type: "input", data: "兼容旧后端" }]);
  expect(await page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "ack"))).toEqual([]);
});

test("automatic reconnect preserves an external text field's focus and never forwards its keystrokes", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const field = document.createElement("input");
    field.id = "file-search";
    document.body.append(field);
  });
  const editor = page.locator("#file-search");
  await editor.fill("文件名");
  await page.evaluate(() => window.pipeline.disconnect(true));
  await expect(page.locator("#connection")).toHaveText("closed");
  await editor.focus();
  await expect.poll(() => page.evaluate(() => window.pipeline.count()), { timeout: 10000 }).toBe(2);
  await expect(page.locator("#connection")).toHaveText("open");
  await expect(editor).toBeFocused();
  await page.keyboard.insertText("继续输入");
  await expect(editor).toHaveValue("文件名继续输入");
  expect(await page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "input"))).toEqual([]);
});

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
    window.pipeline.frame({ type: "output", seq: 1, data: "\x1b[2J\x1b[H\x1b[c\x1b[?2026$p" });
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

test("a synchronized frame larger than the flow window is acknowledged before its end marker", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const body = Array.from({ length: 800 }, (_, i) => `synchronized line ${i}: ${"x".repeat(80)}\r\n`).join("");
    window.pipeline.frame({ type: "replay_start" });
    window.pipeline.frame({ type: "output", seq: 1, epoch: "synchronized", data: "\x1b[?2026h" + body });
  });
  // Rendering waits, but parsing/ACKs must continue so the server can send the
  // rest of a frame exceeding its 64 Ki-character flow-control window.
  await expect.poll(() => page.evaluate(() => window.pipeline.inputs().filter(frame => frame.type === "ack").at(-1)?.ack_seq)).toBe(1);
  await expect(page.locator("#painted")).toHaveText("false");
  await page.evaluate(() => {
    window.pipeline.frame({ type: "output", seq: 2, epoch: "synchronized", data: "COMPLETE\x1b[?2026l" });
    window.pipeline.frame({ type: "replay_end", seq: 2 });
  });
  await expect(page.locator("#painted")).toHaveText("true");
  await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain("COMPLETE");
});

test("two viewers receive the same ordered output while one reads and selects history", async ({ page, context }) => {
  const other = await context.newPage();
  try {
    await Promise.all([open(page), open(other)]);
    const history = Array.from({ length: 500 }, (_, i) => `shared row ${i}`).join("\r\n");
    for (const viewer of [page, other]) {
      await viewer.evaluate(history => {
        window.pipeline.frame({ type: "replay_start" });
        window.pipeline.frame({ type: "output", seq: 1, epoch: "shared", data: history });
        window.pipeline.frame({ type: "replay_end", seq: 1 });
      }, history);
      await expect.poll(() => viewer.evaluate(() => window.pipeline.screen())).toContain("shared row 499");
    }
    await page.evaluate(() => window.pipeline.scroll(100));
    const box = (await page.locator(".xterm-screen").boundingBox())!;
    const dimensions = await page.evaluate(() => window.pipeline.dimensions());
    const line = box.height / dimensions.rows;
    await page.mouse.move(box.x + 1, box.y + line * 2.5);
    await page.mouse.down();
    await page.mouse.move(box.x + 140, box.y + line * 5.5, { steps: 4 });
    const top = await page.evaluate(() => window.pipeline.top());
    const update = Array.from({ length: 200 }, (_, i) => `\r\nshared new row ${i}`).join("");
    await Promise.all([page, other].map(viewer => viewer.evaluate(data => {
      const frame = { type: "output", seq: 2, epoch: "shared", data };
      window.pipeline.frame(frame);
      window.pipeline.frame(frame); // A duplicate must not append twice.
    }, update)));
    for (const viewer of [page, other]) {
      await expect.poll(() => viewer.evaluate(() => window.pipeline.screen())).toContain("shared new row 199");
      expect(await viewer.evaluate(() => window.pipeline.screen().match(/shared new row 199/g)?.length)).toBe(1);
      await expect.poll(() => viewer.evaluate(() => window.pipeline.inputs().filter(frame => frame.type === "ack").at(-1)?.ack_seq)).toBe(2);
    }
    expect(await page.evaluate(() => window.pipeline.top())).toBe(top);
    expect(await other.evaluate(() => window.pipeline.top())).toContain("shared new row");
    await page.mouse.up();
    expect(await page.evaluate(() => window.pipeline.selected())).toContain("shared row 102");
    await other.evaluate(() => window.pipeline.disconnect());
    expect(await page.locator("#connection").textContent()).toBe("open");
    expect(await page.evaluate(() => window.pipeline.top())).toBe(top);
  } finally {
    await page.mouse.up();
    await other.close();
  }
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

import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";

const { PNG } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle");
const scene = (lightStartup: boolean) => "\x1b[0m\x1b[2J\x1b[H" + [
  `\x1b[48;2;${lightStartup ? "244;244;244" : "42;45;60"}mHistory question 中文\x1b[K\x1b[0m`,
  `\x1b[48;2;${lightStartup ? "249;249;249" : "32;35;50"}mCurrent input 中文\x1b[K\x1b[0m`,
  "\x1b[48;5;235mIndexed panel 235\x1b[K\x1b[0m",
  "\x1b[48;5;236mIndexed panel 236\x1b[K\x1b[0m",
  "\x1b[38;5;189mIndexed purple colored text\x1b[0m",
  "\x1b[38;2;166;227;161mRGB green colored text\x1b[0m",
  "\x1b[2;38;2;205;214;244mDimmed secondary information\x1b[0m",
  "\x1b[31mError \x1b[32mSuccess \x1b[33mWarning\x1b[0m",
  "Normal text and readable links",
  "\x1b[2mWorked for 35s / command results / collapsed output\x1b[0m",
  "\x1b[2;38;5;189mDimmed indexed purple text\x1b[0m",
  "\x1b[2;32mDimmed basic green text\x1b[0m",
].join("\r\n");

async function open(page: Page, renderer: string, light = false) {
  await page.setViewportSize({ width: 1100, height: 650 });
  await page.goto(`/tests/browser/terminal-selection.html?renderer=${renderer}&cols=80&rows=12&styled=1&${light ? "light=1" : ""}`);
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  // Keep the whole 80-column screen over its actual terminal background.
  // The fixture's narrower default host otherwise exposes the page at right.
  await page.locator("#terminal").evaluate(element => { element.style.width = "1000px"; });
}

async function painted(page: Page, foregroundRows = [4, 5, 6, 9, 10, 11], backgroundColumns: Array<number | undefined> = []) {
  const png = PNG.sync.read(await page.locator(".xterm-screen").screenshot());
  const pixel = (x: number, y: number): number[] => [...png.data.subarray((Math.floor(y) * png.width + Math.floor(x)) * 4, (Math.floor(y) * png.width + Math.floor(x)) * 4 + 3)];
  const row = png.height / 12;
  const backgrounds = Array.from({ length: 12 }, (_, index) => pixel(
    backgroundColumns[index] === undefined ? png.width - 12 : (backgroundColumns[index]! + 0.5) * png.width / 80,
    row * (index + 0.5)));
  const foregrounds = foregroundRows.map(index => {
    const counts = new Map<string, number>();
    for (let y = Math.floor(index * row); y < (index + 1) * row; y++) {
      // Sample a text prefix, excluding the cursor at the end of a short row.
      for (let x = 0; x < 160; x++) {
        const color = pixel(x, y);
        if (color.every((value, channel) => value === backgrounds[index][channel])) continue;
        const key = color.join(",");
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    // Antialiased edges are often more frequent than the glyph's solid core
    // in the DOM renderer. Measure a repeated core color, excluding lone pixels.
    return [...counts.entries()].filter(([, count]) => count >= 4)
      .map(([color]) => color.split(",").map(Number))
      .sort((a, b) => contrast(b, backgrounds[index]) - contrast(a, backgrounds[index]))[0] ?? [];
  });
  return { backgrounds, foregrounds };
}

function contrast(a: number[], b: number[]) {
  const luminance = (color: number[]) => color.map(value => value / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (values[1] + 0.05) / (values[0] + 0.05);
}

const panelColors = (light: boolean) => light ? [[237, 237, 237], [247, 247, 247], [247, 247, 247], [237, 237, 237]]
  : [[48, 48, 48], [42, 42, 42], [42, 42, 42], [48, 48, 48]];

for (const renderer of ["dom", "webgl"]) {
  test(`${renderer}: code, model and project accents retain saturated colors after live theme changes`, async ({ page }, info) => {
    await open(page, renderer);
    await page.evaluate(data => window.writeTerminalForTest(data), "\x1b[2J\x1b[H" + [
      "\x1b[38;5;189mIndexed command and code MMMM\x1b[0m",
      "\x1b[38;2;166;227;161mRGB project path MMMM\x1b[0m",
      "\x1b[38;2;249;190;128mGPT model and reasoning MMMM\x1b[0m",
      "\x1b[2;38;2;137;220;235mDimmed project accent MMMM\x1b[0m",
      "\x1b[48;5;235mProject input surface\x1b[K\x1b[0m",
      "\x1b[48;5;236mProject history surface\x1b[K\x1b[0m",
    ].join("\r\n"));
    const before = await page.evaluate(() => window.terminalStateForTest());
    for (const light of [false, true, false]) {
      await page.evaluate(light => window.themeTerminalForTest(!light), light);
      const colors = await painted(page, [0, 1, 2, 3]);
      for (let row = 0; row < 4; row++) {
        const fg = colors.foregrounds[row];
        expect(Math.max(...fg) - Math.min(...fg)).toBeGreaterThan(55);
        expect(contrast(fg, colors.backgrounds[row])).toBeGreaterThanOrEqual(light ? row === 3 ? 4.45 : 6.95 : row === 3 ? 2.95 : 4.45);
      }
      expect(colors.backgrounds[4]).toEqual(panelColors(light)[1]);
      expect(colors.backgrounds[5]).toEqual(panelColors(light)[0]);
      expect((await page.evaluate(() => window.terminalStateForTest())).rowStyles).toEqual(before.rowStyles);
      await page.locator(".xterm-screen").screenshot({ path: info.outputPath(light ? "vivid-light.png" : "vivid-dark.png") });
    }
    expect(await page.locator("#inputs").textContent()).toBe("");
  });

  test(`${renderer}: inverse and dim colors use their actual backgrounds, while hidden text and blocks retain their meaning`, async ({ page }) => {
    await open(page, renderer, true);
    const data = [
      "\x1b[7mInverse default text MMMM\x1b[K",
      "\x1b[0;2;7mDim inverse default text MMMM\x1b[K",
      "\x1b[0;7;38;2;30;41;59;48;5;235mInverse RGB and indexed text MMMM\x1b[K",
      "\x1b[0;1;2;7;38;5;234;48;5;235mBold dim inverse indexed text\x1b[K",
      "\x1b[0;8mHidden information remains hidden\x1b[K",
      "\x1b[0;2;48;2;120;20;20;38;2;205;214;244mDim text on a colored background\x1b[K",
      "\x1b[0;48;5;235;38;2;247;247;247m██████████████████████████████\x1b[K",
    ].join("\r\n");
    await page.evaluate(data => window.writeTerminalForTest(data), "\x1b[0m\x1b[2J\x1b[H" + data + "\x1b[0m");
    const before = await page.evaluate(() => window.terminalStateForTest());
    expect(before.rowStyles[0].inverse).toBe(true);
    expect(before.rowStyles[4].invisible).toBe(true);
    for (const dark of [false, true, false]) {
      await page.evaluate(dark => window.themeTerminalForTest(dark), dark);
      expect((await page.evaluate(() => window.terminalStateForTest())).rowStyles).toEqual(before.rowStyles);
      if (dark) continue;
      // An erase-to-end uses the erase background, which does not retain the
      // inverse attribute. Sample spaces inside the inverse text itself.
      const colors = await painted(page, [0, 1, 2, 3, 4, 5, 6], [7, 3, 7, 4, 6, 3]);
      expect(colors.foregrounds[0]).toEqual([255, 255, 255]);
      for (const row of [0, 1, 2, 3, 5]) {
        expect(contrast(colors.foregrounds[row], colors.backgrounds[row])).toBeGreaterThanOrEqual([1, 3, 5].includes(row) ? 4.45 : 6.95);
      }
      expect(colors.foregrounds[4]).toEqual([]);
      expect(colors.foregrounds[6]).toEqual([]);
    }
    expect((await page.evaluate(() => window.terminalStateForTest())).lines).toEqual(before.lines);
  });

  test(`${renderer}: light text stays readable on both panels and while selected, preserving ANSI attributes`, async ({ page }, testInfo) => {
    await open(page, renderer, true);
    const lines = ["", "48;5;235;", "48;5;236;"].flatMap(surface => [
      `\x1b[0;${surface}39mNormal body 中文 MMMM\x1b[K`,
      `\x1b[0;${surface}2mDim command result and elapsed time\x1b[K`,
      `\x1b[0;${surface}2;38;2;205;214;244mDim RGB secondary information\x1b[K`,
      `\x1b[0;${surface}1;38;5;189mBold indexed command text\x1b[K`,
    ]);
    await page.evaluate(data => window.writeTerminalForTest(data), "\x1b[2J\x1b[H" + lines.join("\r\n") + "\x1b[0m");
    const rows = Array.from({ length: 12 }, (_, row) => row);
    const before = await page.evaluate(() => window.terminalStateForTest());
    expect(before.rowStyles.map(style => style.dim)).toEqual([false, true, true, false, false, true, true, false, false, true, true, false]);
    const check = async (selected = false) => {
      const colors = await painted(page, rows);
      for (const row of rows) {
        expect(contrast(colors.foregrounds[row], colors.backgrounds[row]), `row=${row} selected=${selected} fg=${colors.foregrounds[row]} bg=${colors.backgrounds[row]}`).toBeGreaterThanOrEqual(selected || row % 4 === 1 || row % 4 === 2 ? 4.45 : 6.95);
      }
    };
    await check();
    await page.locator(".xterm-screen").screenshot({ path: testInfo.outputPath("readable-light-text.png") });
    for (const dark of [true, false, true, false]) {
      await page.evaluate(dark => window.themeTerminalForTest(dark), dark);
      expect((await page.evaluate(() => window.terminalStateForTest())).rowStyles).toEqual(before.rowStyles);
      if (!dark) await check();
    }
    const box = (await page.locator(".xterm-screen").boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + box.height / 12 * 1.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 12 * 9.5, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator(".wsg-selection-highlight")).toBeVisible();
    await check(true);
    await page.locator("#copy").click();
    const copied = await page.locator("#copied").textContent();
    expect(copied).toContain("Dim RGB secondary information");
    await page.evaluate(() => { window.themeTerminalForTest(true); window.themeTerminalForTest(false); });
    await check(true);
    await page.locator("#copy").click();
    await expect(page.locator("#copied")).toHaveText(copied!);
    expect((await page.evaluate(() => window.terminalStateForTest())).lines).toEqual(before.lines);
    expect(await page.locator("#inputs").textContent()).toBe("");
  });

  for (const lightStartup of [false, true]) {
    test(`${renderer}: ${lightStartup ? "light" : "dark"} TUI colors switch in place, including existing text and selection`, async ({ page }, testInfo) => {
      await open(page, renderer, lightStartup);
      await page.evaluate(data => window.writeTerminalForTest(data), scene(lightStartup));
      const before = await page.evaluate(() => window.terminalStateForTest());
      for (const light of [!lightStartup, lightStartup, !lightStartup]) {
        await page.evaluate(light => window.themeTerminalForTest(!light), light);
        await expect.poll(async () => (await painted(page)).backgrounds.slice(0, 4)).toEqual(panelColors(light));
        const colors = await painted(page);
        expect(contrast(colors.foregrounds[0], colors.backgrounds[4])).toBeGreaterThanOrEqual(light ? 6.95 : 4.45);
        expect(contrast(colors.foregrounds[1], colors.backgrounds[5])).toBeGreaterThanOrEqual(light ? 6.95 : 4.45);
        for (const [foreground, row] of [[2, 6], [3, 9], [4, 10], [5, 11]]) {
          expect(contrast(colors.foregrounds[foreground], colors.backgrounds[row])).toBeGreaterThanOrEqual(light ? 4.45 : 2.2);
        }
        expect(await page.evaluate(() => window.terminalStateForTest().lines)).toEqual(before.lines);
        expect(await page.evaluate(() => window.terminalStateForTest().viewportY)).toBe(before.viewportY);
      }
      const box = (await page.locator(".xterm-screen").boundingBox())!;
      await page.mouse.move(box.x + 1, box.y + box.height / 12 * 3.5);
      await page.mouse.down();
      await page.mouse.move(box.x + 200, box.y + box.height / 12 * 6.5, { steps: 4 });
      await page.mouse.up();
      await page.locator("#copy").click();
      const copied = await page.locator("#copied").textContent();
      expect(copied).toContain("Indexed purple");
      await page.evaluate(light => window.themeTerminalForTest(!light), lightStartup);
      await expect(page.locator(".wsg-selection-highlight")).toBeVisible();
      await expect.poll(() => page.locator(".wsg-selection-highlight").evaluate(el => el.style.mixBlendMode)).toBe(lightStartup ? "darken" : "lighten");
      await page.locator("#copy").click();
      await expect(page.locator("#copied")).toHaveText(copied!);
      expect(await page.locator("#inputs").textContent()).toBe("");
      await page.locator(".xterm-screen").screenshot({ path: testInfo.outputPath("adapted-colors.png") });
      // Newly arriving output follows the current palette without another switch.
      await page.evaluate(data => window.writeTerminalForTest(data), scene(!lightStartup));
      await expect.poll(async () => (await painted(page)).backgrounds[0]).toEqual(panelColors(lightStartup)[0]);
    });
  }

  test(`${renderer}: theme changes wait for a synchronized frame while preserving a selection`, async ({ page }) => {
    await open(page, renderer);
    await page.evaluate(data => window.writeTerminalForTest(data), scene(false));
    const box = (await page.locator(".xterm-screen").boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + box.height / 12 * 3.5);
    await page.mouse.down();
    await page.mouse.move(box.x + 180, box.y + box.height / 12 * 6.5);
    await page.mouse.up();
    const before = await page.evaluate(() => window.terminalStateForTest().renderedLines);
    await page.evaluate(() => window.writeTerminalForTest("\x1b[?2026h\x1b[H\x1b[2K\x1b[48;2;244;244;244mUNCOMMITTED HEADER\x1b[K\x1b[0m"));
    await page.evaluate(() => { window.themeTerminalForTest(false); window.themeTerminalForTest(true); window.themeTerminalForTest(false); });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.terminalStateForTest().renderedLines)).toEqual(before);
    expect((await painted(page)).backgrounds[0]).toEqual(panelColors(false)[0]);
    await expect(page.locator(".wsg-selection-highlight")).toBeVisible();
    await page.evaluate(() => window.writeTerminalForTest("\x1b[?2026l"));
    await expect.poll(async () => (await painted(page)).backgrounds[0]).toEqual(panelColors(true)[0]);
    await expect.poll(() => page.evaluate(() => window.terminalStateForTest().renderedLines[0])).toContain("UNCOMMITTED HEADER");
    await expect(page.locator(".wsg-selection-highlight")).toBeVisible();
  });

  test(`${renderer}: a deferred theme also applies after a missing sync-end timeout`, async ({ page }) => {
    await open(page, renderer);
    await page.evaluate(data => window.writeTerminalForTest(data), scene(false));
    await page.evaluate(() => window.writeTerminalForTest("\x1b[?2026h\x1b[H\x1b[2K\x1b[48;2;244;244;244mTIMEOUT RECOVERY\x1b[K\x1b[0m"));
    await page.evaluate(() => window.themeTerminalForTest(false));
    await expect.poll(async () => (await painted(page)).backgrounds[0], { timeout: 4000 }).toEqual(panelColors(true)[0]);
    await expect.poll(() => page.evaluate(() => window.terminalStateForTest().renderedLines[0])).toContain("TIMEOUT RECOVERY");
  });
}

test("local themes survive replay and reconnect without changing another client's terminal content", async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      await page.goto("/tests/browser/terminal-output.html");
      await expect(page.locator("#connection")).toHaveText("open");
      await page.evaluate(light => window.pipeline.theme(!light), index === 0);
      await page.evaluate(data => {
        window.pipeline.frame({ type: "replay_start" });
        window.pipeline.frame({ type: "output", seq: 1, epoch: "theme-test", data });
        window.pipeline.frame({ type: "replay_end", seq: 1 });
      }, scene(false));
      await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain("RGB green colored text");
    }
    const surface = (page: Page) => page.locator(".xterm-scrollable-element").evaluate(el => getComputedStyle(el).backgroundColor);
    await expect.poll(() => surface(pages[0])).toBe("rgb(255, 255, 255)");
    await expect.poll(() => surface(pages[1])).toBe("rgb(23, 23, 23)");
    expect(await pages[0].evaluate(() => window.pipeline.screen())).toBe(await pages[1].evaluate(() => window.pipeline.screen()));
    await pages[0].reload();
    await expect(pages[0].locator("#connection")).toHaveText("open");
    await expect.poll(() => surface(pages[0])).toBe("rgb(255, 255, 255)");
    await pages[0].locator("#reconnect").click();
    await expect.poll(() => pages[0].evaluate(() => window.pipeline.count())).toBe(2);
    await pages[0].evaluate(data => {
      window.pipeline.frame({ type: "replay_start" });
      window.pipeline.frame({ type: "output", seq: 1, epoch: "new-replay", data });
      window.pipeline.frame({ type: "replay_end", seq: 1 });
    }, scene(true));
    await expect.poll(() => pages[0].evaluate(() => window.pipeline.screen())).toBe(await pages[1].evaluate(() => window.pipeline.screen()));
    await expect.poll(() => surface(pages[0])).toBe("rgb(255, 255, 255)");
    expect(await surface(pages[1])).toBe("rgb(23, 23, 23)");
    expect(await pages[0].evaluate(() => window.pipeline.inputs().filter(input => input.type === "input"))).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test("replay resets a partial color sequence before parsing and acknowledging the new history", async ({ page }) => {
  await page.goto("/tests/browser/terminal-output.html");
  await expect(page.locator("#connection")).toHaveText("open");
  await page.evaluate(() => window.pipeline.frame({ type: "output", seq: 1, epoch: "old", data: "\x1b[48;2;249;" }));
  await expect.poll(() => page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "ack")))
    .toContainEqual({ type: "ack", ack_seq: 1, epoch: "old" });
  await page.evaluate(() => {
    window.pipeline.frame({ type: "replay_start" });
    window.pipeline.frame({ type: "output", seq: 1, epoch: "new", data: "Replay starts clean\r\n\x1b[48;2;244;244;244mPanel" });
    window.pipeline.frame({ type: "replay_end", seq: 1 });
  });
  await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain("Replay starts clean\nPanel");
  await expect.poll(() => page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "ack")))
    .toContainEqual({ type: "ack", ack_seq: 1, epoch: "new" });
});

test("switching a scrolled history preserves its anchor and copied text", async ({ page }) => {
  await page.goto("/tests/browser/terminal-output.html");
  await expect(page.locator("#connection")).toHaveText("open");
  await page.evaluate(() => window.pipeline.frame({ type: "output", seq: 1, data: Array.from({ length: 160 }, (_, row) =>
    `\x1b[48;2;244;244;244mHistory ${row} 中文\x1b[0m\r\n`).join("") }));
  await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain("History 159");
  await page.evaluate(() => { window.pipeline.scroll(15); window.pipeline.select(); });
  const top = await page.evaluate(() => window.pipeline.top());
  const selected = await page.evaluate(() => window.pipeline.selected());
  expect(top).toContain("History 15");
  expect(selected).not.toBe("");
  for (const dark of [false, true, false]) {
    await page.evaluate(dark => window.pipeline.theme(dark), dark);
    expect(await page.evaluate(() => window.pipeline.top())).toBe(top);
    expect(await page.evaluate(() => window.pipeline.selected())).toBe(selected);
  }
  expect(await page.evaluate(() => window.pipeline.count())).toBe(1);
});

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"}: the actual theme control updates a live terminal without a restart notice`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.addInitScript(() => {
      const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
      localStorage.setItem("token", `test.${payload}.signature`);
      localStorage.setItem("user_id", "1");
      localStorage.setItem("app_language", "zh-CN");
      localStorage.setItem("theme", "dark");
    });
    const session = { id: "colors", name: "Codex terminal", connection_id: 1, status: "active", host: "test-host", username: "tester",
      started_at: new Date().toISOString(), last_activity: new Date().toISOString(), enhanced_enabled: true };
    await page.route("**/*", async route => {
      if (route.request().resourceType() !== "fetch") return route.continue();
      const path = new URL(route.request().url()).pathname;
      if (path === "/sessions/colors") return route.fulfill({ json: session });
      if (path === "/sessions") return route.fulfill({ json: [session] });
      if (path === "/connections") return route.fulfill({ json: [] });
      if (path === "/health" || path === "/system/settings") return route.fulfill({ json: {} });
      return route.fulfill({ status: 503, json: { detail: "Unavailable in theme test" } });
    });
    await page.routeWebSocket("**/sessions/ws/sessions/**", () => {});
    let connections = 0;
    const inputs: string[] = [];
    await page.routeWebSocket("**/sessions/ws/terminal/**", socket => {
      connections++;
      socket.onMessage(data => {
        const message = JSON.parse(String(data));
        if (message.type === "input") inputs.push(message.data);
      });
      socket.send(JSON.stringify({ type: "replay_start" }));
      socket.send(JSON.stringify({ type: "output", seq: 1, data: scene(false) }));
      socket.send(JSON.stringify({ type: "replay_end", seq: 1 }));
    });
    await page.goto("/terminal/colors");
    await expect(page.locator(".xterm-rows")).toContainText("RGB green colored text");
    await page.locator(".xterm").evaluate(el => { (el as HTMLElement).dataset.identity = "original"; });
    for (const light of [true, false]) {
      await page.getByRole("button", { name: mobile ? light ? "浅色" : "深色" : "切换主题", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", light ? "light" : "dark");
      // The frame includes padding outside xterm's renderer. A separate
      // hardcoded color here leaves a visible seam around the terminal.
      const background = light ? "rgb(255, 255, 255)" : "rgb(23, 23, 23)";
      await expect(page.locator(".terminal-frame")).toHaveCSS("background-color", background);
      await expect(page.locator(".xterm-scrollable-element")).toHaveCSS("background-color", background);
      await expect(page.locator(".terminal-shell")).toHaveCSS("background-color", background);
      if (!mobile) await expect(page.locator(".terminal-inspector")).toHaveCSS("background-color", light ? "rgb(249, 249, 249)" : "rgb(33, 33, 33)");
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", light ? "#ffffff" : "#212121");
      await expect.poll(() => page.locator(".xterm-rows > div").first().locator("span").first().evaluate(el => getComputedStyle(el).backgroundColor))
        .toBe(light ? "rgb(237, 237, 237)" : "rgb(48, 48, 48)");
      await expect(page.getByText(light ? "已切换浅色模式" : "已切换深色模式", { exact: true }).first()).toBeVisible();
      await expect(page.getByText(/需要重启程序/)).toHaveCount(0);
      await expect(page.locator(".xterm")).toHaveAttribute("data-identity", "original");
      if (light) {
        await expect(page.locator(".xterm-rows span").filter({ hasText: "Worked for 35s" }).first()).toHaveCSS("color", "rgb(76, 76, 76)");
        await page.screenshot({ path: testInfo.outputPath("live-light-theme.png") });
      }
    }
    expect(connections).toBe(1);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.insertText("Still running 中文");
    await expect.poll(() => inputs.filter(input => !input.startsWith("\x1b]"))).toEqual(["Still running 中文"]);
  });
}

test("WebGL idle work from an old theme cannot recolor the new theme", async ({ page }) => {
  await page.addInitScript(() => {
    const callbacks = new Map<number, IdleRequestCallback>();
    let next = 0;
    window.requestIdleCallback = callback => { callbacks.set(++next, callback); return next; };
    window.cancelIdleCallback = id => { callbacks.delete(id); };
    Object.assign(window, {
      switchThemeBeforeOldIdleWork() {
        const oldWork = [...callbacks];
        window.themeTerminalForTest(false);
        for (const [id, callback] of oldWork) {
          callbacks.delete(id);
          callback({ didTimeout: false, timeRemaining: () => 1000 });
        }
        return oldWork.length;
      },
    });
  });
  await open(page, "webgl");
  await page.evaluate(() => window.writeTerminalForTest("\x1b[2J\x1b[HNormal body 中文 MMMM\x1b[0m"));
  await painted(page, [0]);
  const queued = await page.evaluate(() => (window as unknown as { switchThemeBeforeOldIdleWork(): number }).switchThemeBeforeOldIdleWork());
  expect(queued).toBeGreaterThan(0);
  const colors = await painted(page, [0]);
  expect(colors.backgrounds[0]).toEqual([255, 255, 255]);
  expect(contrast(colors.foregrounds[0], colors.backgrounds[0])).toBeGreaterThanOrEqual(6.95);
});

import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";

const { PNG } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle");

async function open(page: Page, query = "") {
  await page.setViewportSize({ width: 2000, height: 1100 });
  await page.goto(`/tests/browser/terminal-selection.html?rows=35&cols=160&offset=500&maxOffset=10000&synchronized=1&chunkDelay=20&delay=33&${query}`);
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  await page.locator("#terminal").evaluate((element, box) => Object.assign(element.style, { width: `${box.width}px`, height: `${box.height}px` }), box);
  await page.waitForTimeout(60);
  return { ...box, row: box.height / 35 };
}

function pixel(buffer: Buffer, x: number, y: number): number[] {
  const png = PNG.sync.read(buffer);
  return [...png.data.subarray((Math.floor(y) * png.width + Math.floor(x)) * 4, (Math.floor(y) * png.width + Math.floor(x)) * 4 + 3)];
}

for (const renderer of ["dom", "webgl"]) {
  for (const light of [false, true]) {
    test(`${renderer} ${light ? "light" : "dark"}: selection stays visible while an edge request waits for output`, async ({ page }, testInfo) => {
      const box = await open(page, `renderer=${renderer}&holdAfter=0&styled=1&${light ? "light=1" : ""}`);
      const screen = page.locator(".xterm-screen");
      const sample = { x: box.width - 35, y: box.row * 7.5 };
      const unselected = pixel(await screen.screenshot(), sample.x, sample.y);
      await page.mouse.move(box.x + 1, box.y + box.row * 3.5);
      await page.mouse.down();
      await page.mouse.move(box.x + 150, box.y + box.row * 12.5, { steps: 4 });
      await expect(page.locator(".wsg-selection-highlight")).toBeVisible();
      const selected = pixel(await screen.screenshot(), sample.x, sample.y);
      expect(selected).not.toEqual(unselected);
      await page.mouse.move(box.x + 150, box.y + box.height - 2, { steps: 3 });
      await expect(page.locator("#wheels")).toHaveText("1");
      const frames = await page.evaluate(async () => {
        const frames: Array<{ selected: boolean; visible: boolean }> = [];
        const start = performance.now();
        while (performance.now() - start < 240) {
          await new Promise(requestAnimationFrame);
          frames.push({ selected: window.terminalStateForTest().selectionActive, visible: !!document.querySelector('.wsg-selection-highlight > div[style*="display: block"]') });
        }
        return frames;
      });
      expect(frames.length).toBeGreaterThan(4);
      expect(frames.every(frame => frame.selected && frame.visible)).toBe(true);
      expect(pixel(await screen.screenshot({ path: testInfo.outputPath("held-selection.png") }), sample.x, sample.y)).toEqual(selected);
      expect(await page.locator("#terminal").getAttribute("data-offset")).toBe("500");
      await page.mouse.up();
      await expect(page.locator(".wsg-selection-highlight")).toBeVisible();
      await page.locator("#copy").click();
      await expect(page.locator("#copied")).toContainText("Output 503");
      await page.evaluate(() => window.releaseTerminalRepliesForTest());
      await expect(page.locator("#selection")).toContainText("Output 534");
    });
  }
}

test("DOM selection changes never expose a synchronized half-frame", async ({ page }, testInfo) => {
  const box = await open(page, "renderer=dom");
  await page.mouse.move(box.x + 1, box.y + box.row * 4.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.row * 10.5, { steps: 4 });
  await expect(page.locator(".wsg-selection-highlight")).toBeVisible();
  const before = await page.locator(".xterm-rows > div").allTextContents();
  await page.evaluate(() => window.writeTerminalForTest("\x1b[?2026h\x1b[H\x1b[2KUNCOMMITTED HALF FRAME"));
  for (let row = 11; row <= 15; row++) {
    await page.mouse.move(box.x + 150, box.y + box.row * (row + 0.5));
    await page.waitForTimeout(20);
    expect(await page.locator(".xterm-rows > div").allTextContents()).toEqual(before);
    await expect(page.locator(".wsg-selection-highlight")).toBeVisible();
  }
  await page.locator(".xterm-screen").screenshot({ path: testInfo.outputPath("held-complete-frame.png") });
  await page.evaluate(() => window.writeTerminalForTest("\x1b[?2026l"));
  await expect(page.locator(".xterm-rows > div").first()).toContainText("UNCOMMITTED HALF FRAME");
  await page.mouse.up();
});

test("a drag started during a synchronized repaint selects the displayed text", async ({ page }) => {
  const box = await open(page, "renderer=dom");
  await page.evaluate(() => window.writeTerminalForTest("\x1b[?2026h\x1b[5;1H\x1b[2KNOT YET VISIBLE"));
  await page.mouse.move(box.x + 1, box.y + box.row * 4.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 170, box.y + box.row * 8.5, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#selection")).toContainText("Output 503");
  await expect(page.locator("#selection")).not.toContainText("NOT YET VISIBLE");
  expect((await page.locator(".xterm-rows > div").allTextContents()).join("\n")).not.toContain("NOT YET VISIBLE");
  await page.evaluate(() => window.writeTerminalForTest("\x1b[?2026l"));
});

test("DOM cross-screen selection displays only complete frames and bounded steps", async ({ page }, testInfo) => {
  const box = await open(page, "renderer=dom&chunkDelay=60");
  await page.mouse.move(box.x + 1, box.y + box.row * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + box.height + 40, { steps: 4 });
  await expect(page.locator(".wsg-selection-highlight")).toBeVisible();
  const frames = await page.evaluate(async () => {
    const frames: Array<{ numbers: number[]; highlight: boolean }> = [];
    const start = performance.now();
    while (performance.now() - start < 1800) {
      await new Promise(requestAnimationFrame);
      frames.push({
        numbers: [...document.querySelectorAll(".xterm-rows > div")].map(row => row.textContent!.match(/Output (\d+)/)?.[1]).filter(Boolean).map(Number),
        highlight: !!document.querySelector('.wsg-selection-highlight > div[style*="display: block"]'),
      });
    }
    return frames;
  });
  expect(frames.length).toBeGreaterThan(20);
  expect(new Set(frames.map(frame => frame.numbers[0])).size).toBeGreaterThan(4);
  for (const [index, frame] of frames.entries()) {
    expect(frame.highlight).toBe(true);
    expect(frame.numbers).toEqual(Array.from({ length: 33 }, (_, row) => frame.numbers[0] + row));
    if (index) expect(frame.numbers[0] - frames[index - 1].numbers[0]).toBeLessThanOrEqual(4);
  }
  await page.locator(".xterm-screen").screenshot({ path: testInfo.outputPath("complete-drag-frame.png") });
  await page.mouse.up();
  await expect(page.locator("#selection")).toContainText("Output 503");
  const numbers = [...(await page.locator("#selection").textContent())!.matchAll(/Output (\d+)/g)].map(match => Number(match[1]));
  expect(numbers.length).toBeGreaterThan(33);
  expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => numbers[0] + index));
});

test("native history drag discards catch-up after a busy frame", async ({ page }) => {
  const box = await open(page, "renderer=dom&mode=shell&shellLines=5000&scrollLine=2000");
  await page.mouse.move(box.x + 1, box.y + box.row * 3.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + box.height + 40, { steps: 4 });
  const positions = await page.evaluate(async () => {
    const positions: number[] = [];
    for (let i = 0; i < 30; i++) {
      await new Promise(requestAnimationFrame);
      positions.push(window.terminalStateForTest().viewportY);
      if (i === 10) { const start = performance.now(); while (performance.now() - start < 120) { /* simulate a busy frame */ } }
    }
    return positions;
  });
  expect(positions.at(-1)! - positions[0]).toBeGreaterThan(30);
  for (let i = 1; i < positions.length; i++) expect(positions[i] - positions[i - 1]).toBeLessThanOrEqual(4);
  await page.mouse.up();
  const stopped = await page.evaluate(() => window.terminalStateForTest().viewportY);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.terminalStateForTest().viewportY)).toBe(stopped);
});

for (const action of ["resize", "buffer"]) {
  test(`${action} hides stale highlight and stops drag input without losing copied text`, async ({ page }) => {
    const box = await open(page, "renderer=dom");
    await page.mouse.move(box.x + 1, box.y + box.row * 3.5);
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + box.height + 40, { steps: 4 });
    await expect.poll(async () => Number(await page.locator("#wheels").textContent())).toBeGreaterThan(2);
    await page.evaluate(async action => {
      if (action === "resize") window.resizeTerminalForTest();
      else await window.writeTerminalForTest("\x1b[?1049l");
    }, action);
    const count = await page.locator("#wheels").textContent();
    await page.waitForTimeout(180);
    expect(await page.locator("#wheels").textContent()).toBe(count);
    await expect(page.locator(".wsg-selection-highlight")).toHaveCount(0);
    await page.mouse.up();
    await page.keyboard.press("Control+Shift+C");
    await expect(page.locator("#copied")).toContainText("Output 503");
  });
}

test("context-menu copy uses the complete transcript and typing clears the highlight", async ({ page }) => {
  const box = await open(page, "renderer=dom");
  await page.mouse.move(box.x + 1, box.y + box.row * 3.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + box.row * 12.5, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#selection")).toContainText("Output 503");
  const text = await page.locator("#selection").textContent();
  const copied = await page.locator(".xterm-screen").evaluate(screen => {
    const rect = screen.getBoundingClientRect();
    screen.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 30, clientY: rect.top + 100 }));
    const textarea = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
    const value = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    const clipboard = new DataTransfer();
    textarea.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: clipboard }));
    return { value, clipboard: clipboard.getData("text/plain") };
  });
  expect(copied).toEqual({ value: text, clipboard: text });
  await page.keyboard.type("x");
  await expect(page.locator(".wsg-selection-highlight")).toHaveCount(0);
  const inputs: string[] = JSON.parse((await page.locator("#inputs").textContent())!);
  expect(inputs).toEqual(["x"]);
});

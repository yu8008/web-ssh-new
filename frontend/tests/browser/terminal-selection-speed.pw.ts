import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, query = "", rows = 50) {
  await page.setViewportSize({ width: 1800, height: 1400 });
  // Fix the frame cadence and repaint timing so throughput assertions measure
  // controller behavior rather than the load on the browser test machine.
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.goto(`/tests/browser/terminal-selection.html?renderer=dom&cols=120&rows=${rows}&appFont=1&offset=2000&maxOffset=10000&synchronized=1&delay=33&chunkDelay=20&${query}`);
  await page.clock.runFor(250);
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  await page.locator("#terminal").evaluate((element, b) => Object.assign(element.style, { width: `${b.width}px`, height: `${b.height}px` }), box);
  return { ...box, row: box.height / rows };
}

async function offset(page: Page) {
  return Number(await page.locator("#terminal").getAttribute("data-offset"));
}

async function expectContiguousCopy(page: Page) {
  const text = (await page.locator("#selection").textContent())!;
  const rows = [...text.matchAll(/(?:Output|Shell row) (\d+)/g)].map(match => Number(match[1]));
  expect(rows.length).toBeGreaterThan(30);
  expect(rows).toEqual(Array.from({ length: rows.length }, (_, i) => rows[0] + i));
}

for (const direction of [-1, 1]) {
  test(`fast ${direction > 0 ? "downward" : "upward"} drag refills its window and preserves complete frames`, async ({ page }) => {
    const box = await open(page, "", 32);
    await page.mouse.move(box.x + 1, box.y + box.row * (direction > 0 ? 2.5 : 28.5));
    await page.mouse.down();
    await page.mouse.move(box.x + 80, direction > 0 ? box.y + box.height : box.y, { steps: 4 });
    await page.clock.runFor(1000);
    const start = await offset(page);
    await page.evaluate(() => {
      const frames: Array<{ rows: number[]; highlight: boolean }> = [];
      Object.assign(window, { dragSpeedFrames: frames });
      const sample = () => {
        frames.push({
          rows: [...document.querySelectorAll(".xterm-rows > div")].flatMap(row => {
            const match = row.textContent!.match(/Output (\d+)/);
            return match ? [Number(match[1])] : [];
          }),
          highlight: !!document.querySelector('.wsg-selection-highlight > div[style*="display: block"]'),
        });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.clock.runFor(1600);
    expect((await offset(page) - start) * direction).toBeGreaterThanOrEqual(150);
    const frames: Array<{ rows: number[]; highlight: boolean }> = await page.evaluate(() => Reflect.get(window, "dragSpeedFrames"));
    for (const [i, frame] of frames.entries()) {
      expect(frame.highlight).toBe(true);
      expect(frame.rows).toEqual(Array.from({ length: 30 }, (_, j) => frame.rows[0] + j));
      if (i) expect((frame.rows[0] - frames[i - 1].rows[0]) * direction).toBeGreaterThanOrEqual(0);
      if (i) expect(Math.abs(frame.rows[0] - frames[i - 1].rows[0])).toBeLessThanOrEqual(8);
    }
    await page.mouse.up();
    const wheels = await page.locator("#wheels").textContent();
    await page.clock.runFor(600);
    expect(await page.locator("#wheels").textContent()).toBe(wheels);
    await expectContiguousCopy(page);
  });
}

test("the fast window is bounded and sends no input during a split repaint or after release", async ({ page }) => {
  const box = await open(page, "holdAfter=1");
  await page.mouse.move(box.x + 1, box.y + box.row * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + box.height, { steps: 4 });
  await page.clock.runFor(180);
  // One calibrated probe plus at most six reports: 12 unconfirmed body rows.
  const wheels = Number(await page.locator("#wheels").textContent());
  expect(wheels).toBeGreaterThanOrEqual(5);
  expect(wheels).toBeLessThanOrEqual(7);
  await page.evaluate(() => { void window.writeTerminalForTest("\x1b[?2026h"); });
  await page.clock.runFor(500);
  expect(Number(await page.locator("#wheels").textContent())).toBe(wheels);
  await page.mouse.up();
  await page.evaluate(() => { void window.writeTerminalForTest("\x1b[?2026l"); });
  await page.evaluate(() => window.releaseTerminalRepliesForTest());
  await page.clock.runFor(600);
  expect(Number(await page.locator("#wheels").textContent())).toBe(wheels);
  await expectContiguousCopy(page);
});

test("native drag accelerates while held and resets when leaving the edge or reversing", async ({ page }) => {
  const box = await open(page, "mode=shell&shellLines=20000&scrollLine=5000", 32);
  const position = () => page.evaluate(() => window.terminalStateForTest().viewportY);
  await page.mouse.move(box.x + 1, box.y + box.row * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + box.height, { steps: 4 });
  const initial = await position();
  await page.clock.runFor(300);
  const first = await position() - initial;
  await page.clock.runFor(600);
  const beforeFast = await position();
  await page.clock.runFor(300);
  const fast = await position() - beforeFast;
  expect(fast).toBeGreaterThan(first * 1.3);
  await page.mouse.move(box.x + 80, box.y + box.row * 15.5);
  await page.clock.runFor(100);
  const stopped = await position();
  await page.clock.runFor(300);
  expect(await position()).toBe(stopped);
  await page.mouse.move(box.x + 80, box.y + box.height);
  await page.clock.runFor(300);
  expect(await position() - stopped).toBeLessThan(fast * 0.85);
  const beforeReverse = await position();
  await page.mouse.move(box.x + 80, box.y);
  await page.clock.runFor(300);
  const reverse = beforeReverse - await position();
  expect(reverse).toBeGreaterThan(40);
  expect(reverse).toBeLessThan(fast * 0.85);
  await page.mouse.up();
  await page.clock.runFor(100);
  await expectContiguousCopy(page);
});

test("a fast remote drag cancels old-direction input and retains its copy on reversal", async ({ page }) => {
  const box = await open(page);
  await page.mouse.move(box.x + 1, box.y + box.row * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + box.height, { steps: 4 });
  await page.clock.runFor(1000);
  const count = Number(await page.locator("#wheels").textContent());
  await page.mouse.move(box.x + 80, box.y);
  await page.clock.runFor(600);
  const reports: string[] = JSON.parse((await page.locator("#inputs").textContent())!);
  const afterReverse = reports.filter(report => /\x1b\[<(64|65);/.test(report)).slice(count);
  expect(afterReverse.length).toBeGreaterThan(4);
  expect(afterReverse.every(report => report.startsWith("\x1b[<64;"))).toBe(true);
  await page.mouse.up();
  const stopped = await page.locator("#wheels").textContent();
  await page.clock.runFor(600);
  expect(await page.locator("#wheels").textContent()).toBe(stopped);
  await expectContiguousCopy(page);
});

test("a large fast window recovers when the application folds wheel input", async ({ page }) => {
  const box = await open(page, "delay=120&chunkDelay=0&coalesceWheelMs=25");
  await page.mouse.move(box.x + 1, box.y + box.row * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + box.height, { steps: 4 });
  await page.clock.runFor(6000);
  expect(await offset(page)).toBeGreaterThan(2150);
  await page.mouse.up();
  await page.clock.runFor(600);
  await expectContiguousCopy(page);
});

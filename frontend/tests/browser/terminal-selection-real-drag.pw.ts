import { expect, test } from "@playwright/test";

for (const { extra, dense } of [{ extra: -2 }, { extra: 2 }, { extra: 20 }, { extra: 20, dense: true }]) {
  test(`native ${dense ? "dense Chinese " : ""}drag at ${extra}px past the bottom advances real history and copies it`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.goto(`/tests/browser/terminal-selection.html?mode=shell&shellLines=5000&scrollLine=2000&renderer=dom&cols=160&rows=32&appFont=1${dense ? "&denseShell=1" : ""}`);
    await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
    expect(await page.evaluate(() => window.terminalStateForTest().mouse)).toBe("none");
    const box = (await page.locator(".xterm-screen").boundingBox())!;
    await page.locator("#terminal").evaluate((element, box) => { Object.assign(element.style, { width: `${box.width}px`, height: `${box.height}px` }); }, box);
    await page.mouse.move(box.x + 1, box.y + box.height / 32 * 2.5);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + box.height + extra, { steps: 4 });
    const start = await page.evaluate(() => window.terminalStateForTest().viewportY);
    // Check progress per animation frame: busy CI machines intentionally drop
    // catch-up distance, so wall-clock throughput is not a stable assertion.
    await page.evaluate(async () => { for (let frame = 0; frame < 45; frame++) await new Promise(requestAnimationFrame); });
    const end = await page.evaluate(() => window.terminalStateForTest().viewportY);
    expect(end - start).toBeGreaterThan(80);
    expect(end - start).toBeLessThanOrEqual(276);
    await expect(page.locator(".wsg-selection-frame")).toHaveCount(0);
    if (dense) await page.locator(".xterm-screen").screenshot({ path: testInfo.outputPath("dense-chinese-drag.png") });
    await page.mouse.up();
    await expect(page.locator("#selection")).toContainText("Shell row 2002");
    const copied = (await page.locator("#selection").textContent())!;
    const rows = [...copied.matchAll(/Shell row (\d+)/g)].map((match) => Number(match[1]));
    expect(rows.length).toBeGreaterThan(95);
    expect(rows).toEqual(Array.from({ length: rows.length }, (_, index) => 2002 + index));
    const stopped = await page.evaluate(() => window.terminalStateForTest().viewportY);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.terminalStateForTest().viewportY)).toBe(stopped);
  });
}

test("the drag presents one complete frame while a changing footer stays synchronized", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/tests/browser/terminal-selection.html?renderer=webgl&styled=1&dim=1&dynamicFooter=1&dynamicFrom=0&footerStyled=1&delay=200&chunkDelay=70&synchronized=1&maxOffset=10000&cols=160&rows=32&appFont=1");
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  await page.locator("#terminal").evaluate((element, box) => { Object.assign(element.style, { width: `${box.width}px`, height: `${box.height}px` }); }, box);
  await page.mouse.move(box.x + 1, box.y + box.height / 32 * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + box.height + 10, { steps: 4 });
  await expect.poll(async () => Number(await page.locator("#terminal").getAttribute("data-offset"))).toBeGreaterThan(30);
  const frames = await page.evaluate(async () => {
    const frames: string[][] = [];
    const start = performance.now();
    while (performance.now() - start < 700) {
      await new Promise(requestAnimationFrame);
      frames.push(window.terminalStateForTest().renderedLines);
    }
    return frames;
  });
  for (const lines of frames) {
    const first = lines.find(line => line.startsWith("Output "))!.match(/Output (\d+)/)![1];
    expect(lines).toContain(`Status ${Number(first)}`);
    expect(lines).toContain("Prompt running");
    expect(lines.at(-1)).toBe("Fixed footer");
  }
  await page.locator(".xterm-screen").screenshot({ path: testInfo.outputPath("drag-complete-frame.png") });
  await page.mouse.up();
  await expect(page.locator(".wsg-selection-frame")).toHaveCount(0);
  const text = (await page.locator("#selection").textContent())!;
  const rows = [...text.matchAll(/Output (\d+)/g)].map((match) => Number(match[1]));
  expect(rows).toEqual(Array.from({ length: rows.length }, (_, index) => 21 + index));
});

test("a TUI that folds simultaneous wheel reports still scrolls faster with paced input", async ({ page }) => {
  await page.goto("/tests/browser/terminal-selection.html?renderer=dom&delay=120&chunkDelay=0&synchronized=1&coalesceWheelMs=25&maxOffset=10000");
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 12 * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + box.height + 10, { steps: 4 });
  await expect.poll(async () => Number(await page.locator("#terminal").getAttribute("data-offset"))).toBeGreaterThanOrEqual(50);
  await page.mouse.up();
  await expect(page.locator("#selection")).toContainText("Output 050");
});

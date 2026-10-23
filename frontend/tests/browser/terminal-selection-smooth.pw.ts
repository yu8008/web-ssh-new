import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, query = "") {
  const parameters = new URLSearchParams("renderer=dom&maxOffset=10000&delay=5&chunkDelay=0&synchronized=1");
  new URLSearchParams(query).forEach((value, name) => parameters.set(name, value));
  await page.goto(`/tests/browser/terminal-selection.html?${parameters}`);
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  await page.locator("#terminal").evaluate((el, b) => Object.assign(el.style, { width: `${b.width}px`, height: `${b.height}px` }), box);
  return { ...box, line: box.height / 12 };
}

async function drag(page: Page, direction: "up" | "down", query = "") {
  const box = await open(page, query);
  await page.mouse.move(box.x + 1, box.y + box.line * (direction === "up" ? 9.5 : 2.5));
  await page.mouse.down();
  await page.mouse.move(box.x + 40, direction === "up" ? box.y + 2 : box.y + box.height - 2, { steps: 4 });
  return box;
}

async function sampleFrames(page: Page, milliseconds = 700) {
  return page.evaluate(async milliseconds => {
    const frames: string[][] = [];
    const start = performance.now();
    while (performance.now() - start < milliseconds) {
      await new Promise(requestAnimationFrame);
      frames.push(window.terminalStateForTest().renderedLines);
    }
    return frames;
  }, milliseconds);
}

for (const renderer of ["dom", "webgl"]) {
  for (const direction of ["up", "down"] as const) {
    test(`${renderer}: ${direction} drag advances real, complete frames without a duplicate text layer`, async ({ page }) => {
      await drag(page, direction, `renderer=${renderer}&offset=500`);
      const frames = await sampleFrames(page);
      const positions = frames.map(lines => Number(lines.find(line => line.startsWith("Output "))?.match(/Output (\d+)/)?.[1]));
      expect(new Set(positions).size).toBeGreaterThan(5);
      for (let i = 1; i < positions.length; i++) expect(direction === "up" ? positions[i] <= positions[i - 1] : positions[i] >= positions[i - 1]).toBe(true);
      for (const lines of frames) {
        expect(lines[0]).toBe("Fixed header");
        expect(lines.at(-1)).toBe("Fixed footer");
        const numbers = lines.slice(1, -1).map(line => Number(line.match(/Output (\d+)/)?.[1]));
        expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => numbers[0] + i));
      }
      await expect(page.locator(".wsg-selection-frame")).toHaveCount(0);
      await page.mouse.up();
      await expect(page.locator("#selection")).toContainText("Output");
      const numbers = [...(await page.locator("#selection").textContent())!.matchAll(/Output (\d+)/g)].map(match => Number(match[1]));
      expect(numbers.length).toBeGreaterThan(10);
      expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => numbers[0] + i));
    });
  }
}

for (const direction of ["up", "down"] as const) {
  test(`native ${direction} drag moves actual history and stops on release`, async ({ page }) => {
    await drag(page, direction, "mode=shell&scrollLine=2000&shellLines=5000");
    const initial = await page.evaluate(() => window.terminalStateForTest().viewportY);
    await expect.poll(() => page.evaluate(() => window.terminalStateForTest().viewportY)).not.toBe(initial);
    await page.waitForTimeout(300);
    await page.mouse.up();
    await expect(page.locator("#selection")).toContainText("Shell row");
    const stopped = await page.evaluate(() => window.terminalStateForTest().viewportY);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.terminalStateForTest().viewportY)).toBe(stopped);
    expect(await page.locator("#wheels").textContent()).toBe("0");
  });
}

test("continuous unrelated output does not starve cross-screen selection", async ({ page }) => {
  await drag(page, "down", "steady=1");
  const frames = await sampleFrames(page);
  expect(new Set(frames.map(lines => lines[1])).size).toBeGreaterThan(5);
  await page.mouse.up();
});

test("uneven repaints preserve contiguous copied text", async ({ page }) => {
  await drag(page, "down", "delays=240,320,260,300&offset=500");
  await page.waitForTimeout(2200);
  await page.mouse.up();
  await expect(page.locator("#selection")).toContainText("Output");
  const numbers = [...(await page.locator("#selection").textContent())!.matchAll(/Output (\d+)/g)].map(match => Number(match[1]));
  expect(numbers.length).toBeGreaterThan(20);
  expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => numbers[0] + i));
});

for (const synchronized of [false, true]) {
  test(`long selection survives a changing multiline prompt (${synchronized ? "synchronized" : "split"}) and an ignored wheel`, async ({ page }) => {
    const box = await open(page, `&renderer=dom&dynamicFooter=1&dynamicFrom=0&dropAt=60&maxOffset=160&delay=15&chunkDelay=5&synchronized=${synchronized ? 1 : 0}`);
    await page.mouse.move(box.x + 1, box.y + box.line * 2.5);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + box.height - 2, { steps: 4 });
    await expect(page.locator("#terminal")).toHaveAttribute("data-offset", "160", { timeout: 15000 });
    await page.mouse.up();
    await expect(page.locator("#selection")).toContainText("Output 167");
    const text = (await page.locator("#selection").textContent())!;
    const numbers = [...text.matchAll(/Output (\d+)/g)].map((match) => Number(match[1]));
    expect(numbers).toEqual(Array.from({ length: 147 }, (_, index) => 21 + index));
    expect(text.match(/Status 20\n/g)).toHaveLength(1);
    expect(text.match(/Prompt running/g)).toHaveLength(1);
  });
}

test("native highlighting follows the pointer and auto-scroll stops on blur", async ({ page }) => {
  const box = await open(page, "mode=shell&scrollLine=20");
  await page.mouse.move(box.x + 1, box.y + box.line * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + box.height + 20, { steps: 4 });
  await expect.poll(() => page.evaluate(() => window.terminalStateForTest().viewportY)).toBeGreaterThan(20);
  await page.mouse.move(box.x + box.width / 5, box.y + box.line * 5.5, { steps: 3 });
  await expect.poll(() => page.evaluate(() => window.terminalStateForTest().selected)).toContain("Shell row");
  await page.mouse.move(box.x + 50, box.y + box.height + 20, { steps: 3 });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const top = await page.evaluate(() => window.terminalStateForTest().viewportY);
  await page.waitForTimeout(180);
  expect(await page.evaluate(() => window.terminalStateForTest().viewportY)).toBe(top);
  await page.mouse.up();
});

test("blur and resize stop queued drag input", async ({ page }) => {
  for (const action of ["blur", "resize"]) {
    await drag(page, "down");
    await expect.poll(async () => Number(await page.locator("#wheels").textContent())).toBeGreaterThan(3);
    await page.evaluate(action => {
      if (action === "blur") window.dispatchEvent(new Event("blur"));
      else window.resizeTerminalForTest();
    }, action);
    const reports = await page.locator("#wheels").textContent();
    await page.waitForTimeout(180);
    expect(await page.locator("#wheels").textContent()).toBe(reports);
    await page.mouse.up();
  }
});

test("a long styled selection preserves formatting with a bounded native viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const box = await open(page, "cols=120&rows=30&maxOffset=220&styled=1");
  await page.mouse.move(box.x + 1, box.y + box.height / 30 * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + box.height - 2, { steps: 4 });
  await expect(page.locator("#terminal")).toHaveAttribute("data-offset", "220", { timeout: 15000 });
  const first = page.locator(".xterm-rows > div").nth(1).locator("span").first();
  await expect(first).toHaveCSS("color", "rgb(96, 165, 250)");
  await expect(first).toHaveCSS("background-color", "rgb(48, 48, 48)");
  await expect(first).toHaveCSS("font-weight", "700");
  await expect(first).toHaveCSS("text-decoration-line", "underline");
  expect(await page.locator(".xterm-rows > div").count()).toBe(30);
  await expect(page.locator(".wsg-selection-frame")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator("#selection")).toContainText("Output");
  const numbers = [...(await page.locator("#selection").textContent())!.matchAll(/Output (\d+)/g)].map(match => Number(match[1]));
  expect(numbers.length).toBeGreaterThan(200);
  expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => 21 + i));
});

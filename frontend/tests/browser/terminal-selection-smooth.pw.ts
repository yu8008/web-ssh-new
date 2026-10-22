import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, query = "") {
  const parameters = new URLSearchParams("maxOffset=10000&delay=30&chunkDelay=0&synchronized=1");
  new URLSearchParams(query).forEach((value, name) => parameters.set(name, value));
  await page.goto(`/tests/browser/terminal-selection.html?${parameters}`);
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  const box = await page.locator(".xterm-screen").boundingBox();
  if (!box) throw new Error("Missing terminal screen");
  return { ...box, line: box.height / 12 };
}

async function drag(page: Page, direction: "up" | "down", query = "") {
  const box = await open(page, query);
  await page.mouse.move(box.x + 1, box.y + box.line * (direction === "up" ? 9.5 : 2.5));
  await page.mouse.down();
  await page.mouse.move(box.x + 40, direction === "up" ? box.y + 2 : box.y + box.height - 2, { steps: 4 });
  return box;
}

async function sampleMotion(page: Page, milliseconds = 600) {
  return page.evaluate(async (milliseconds) => {
    const values: number[] = [];
    const start = performance.now();
    // Sample enough presented frames even when software WebGL on CI runs
    // below 60 Hz; elapsed wall time alone is not a frame count.
    while ((performance.now() - start < milliseconds || values.length < 24) && performance.now() - start < 4000) {
      await new Promise(requestAnimationFrame);
      const content = document.querySelector<HTMLElement>(".wsg-selection-content");
      if (content) values.push(Number.parseFloat(getComputedStyle(content).getPropertyValue("--selection-scroll-position")) || 0);
    }
    return values;
  }, milliseconds);
}

for (const renderer of ["canvas", "webgl"]) {
  for (const direction of ["up", "down"] as const) {
    test(`${renderer}: ${direction} selection moves painted text between rows with pinned chrome`, async ({ page }, testInfo) => {
      // Start well away from either history boundary.
      const box = await drag(page, direction, `&renderer=${renderer}&offset=500`);
      await expect(page.locator(".wsg-selection-scroll")).toBeVisible();
      const values = await sampleMotion(page);
      expect(new Set(values.map((value) => value.toFixed(2))).size).toBeGreaterThan(8);
      expect(values.filter((value) => Math.abs(value / box.line - Math.round(value / box.line)) > 0.03).length).toBeGreaterThan(8);
      expect(values.some((value) => direction === "up" ? value > 1 : value < -1)).toBe(true);
      for (let index = 1; index < values.length; index++) {
        expect(direction === "up" ? values[index] >= values[index - 1] : values[index] <= values[index - 1]).toBe(true);
      }
      const clip = await page.locator(".wsg-selection-scroll").boundingBox();
      expect(clip!.y).toBeCloseTo(box.y + box.line, 0);
      expect(clip!.height).toBeCloseTo(box.height - 2 * box.line, 0);
      await expect(page.locator(".wsg-selection-row").first()).toContainText("Output");
      await expect(page.locator(".wsg-selection-row").first()).toContainText("中文 😀");
      expect(await page.locator(".wsg-selection-row").count()).toBeLessThan(24);
      await expect(page.locator(".wsg-selection-scroll canvas")).toHaveCount(0);
      if (renderer === "canvas" && direction === "down") await page.locator(".xterm-screen").screenshot({ path: testInfo.outputPath("selection-scroll.png") });
      await page.mouse.up();
      await expect(page.locator(".wsg-selection-scroll")).toHaveCount(0);
      await expect(page.locator("#selection")).toContainText("中文 😀");
      const numbers = [...(await page.locator("#selection").textContent())!.matchAll(/Output (\d+)/g)].map((match) => Number(match[1]));
      expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => numbers[0] + index));
    });
  }
}

for (const direction of ["up", "down"] as const) {
  test(`native shell ${direction} drag interpolates text, not only the scrollbar`, async ({ page }) => {
    const box = await open(page, "&mode=shell&renderer=canvas&scrollLine=2000&shellLines=5000");
    await page.mouse.move(box.x + 1, box.y + box.line * (direction === "up" ? 9.5 : 2.5));
    await page.mouse.down();
    await page.mouse.move(box.x + 50, direction === "up" ? box.y - 20 : box.y + box.height + 20, { steps: 4 });
    await expect(page.locator(".wsg-selection-scroll")).toBeVisible();
    const values = await sampleMotion(page, 400);
    expect(new Set(values.map((value) => value.toFixed(2))).size).toBeGreaterThan(6);
    await page.mouse.up();
    await expect(page.locator(".wsg-selection-scroll")).toHaveCount(0);
    await expect(page.locator("#selection")).toContainText("Shell row");
    expect(await page.locator("#wheels").textContent()).toBe("0");
  });
}

test("continuous unrelated output does not starve pixel animation", async ({ page }) => {
  await drag(page, "down", "&steady=1&renderer=canvas");
  await expect(page.locator(".wsg-selection-scroll")).toBeVisible();
  expect(new Set((await sampleMotion(page)).map((value) => value.toFixed(2))).size).toBeGreaterThan(8);
  await page.mouse.up();
});

test("selection maintains continuous motion through slow, uneven remote repaints", async ({ page }) => {
  await drag(page, "down", "&renderer=canvas&delays=240,320,260,300&offset=500");
  await expect(page.locator(".wsg-selection-scroll")).toBeVisible();
  await page.waitForTimeout(1200);
  const values = await sampleMotion(page, 2200);
  const steps = values.slice(1).map((value, index) => values[index] - value);
  expect(steps.filter((step) => step < 0.01).length / steps.length).toBeLessThan(0.05);
  await page.mouse.up();
  await expect(page.locator(".wsg-selection-scroll")).toHaveCount(0);
  const numbers = [...(await page.locator("#selection").textContent())!.matchAll(/Output (\d+)/g)].map((match) => Number(match[1]));
  expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => numbers[0] + index));
});

for (const synchronized of [false, true]) {
  test(`long selection survives a changing multiline prompt (${synchronized ? "synchronized" : "split"}) and an ignored wheel`, async ({ page }) => {
    const box = await open(page, `&renderer=canvas&dynamicFooter=1&dynamicFrom=0&dropAt=60&maxOffset=160&delay=15&chunkDelay=5&synchronized=${synchronized ? 1 : 0}`);
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

test("native selection highlighting follows the pointer after scrolling and stops on blur", async ({ page }) => {
  const box = await open(page, "&mode=shell&renderer=canvas&scrollLine=20");
  await page.mouse.move(box.x + 1, box.y + box.line * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + box.height + 20, { steps: 4 });
  await expect(page.locator(".wsg-selection-scroll")).toBeVisible();
  await page.mouse.move(box.x + box.width / 5, box.y + box.line * 5.5, { steps: 3 });
  await expect.poll(() => page.locator(".wsg-selection-row > div").evaluateAll((highlights) => highlights.some((element) => {
    const highlight = element as HTMLElement;
    const width = Number.parseFloat(highlight.style.width);
    return highlight.style.display === "block" && width > 0 && width < 300;
  }))).toBe(true);
  await page.mouse.move(box.x + 50, box.y + box.height + 20, { steps: 3 });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.locator(".wsg-selection-scroll")).toHaveCount(0);
  await page.waitForTimeout(180);
  const top = await page.locator(".xterm-viewport").evaluate((element) => element.scrollTop);
  await page.waitForTimeout(150);
  expect(await page.locator(".xterm-viewport").evaluate((element) => element.scrollTop)).toBe(top);
  await page.mouse.up();
});

test("blur and resize remove animation layers during a drag", async ({ page }) => {
  for (const action of ["blur", "resize"]) {
    await drag(page, "down", "&renderer=canvas");
    await expect(page.locator(".wsg-selection-scroll")).toBeVisible();
    await page.evaluate((action) => {
      if (action === "blur") window.dispatchEvent(new Event("blur"));
      else window.resizeTerminalForTest();
    }, action);
    await expect(page.locator(".wsg-selection-scroll")).toHaveCount(0);
    await page.mouse.up();
  }
});

test("reduced motion and DOM fallback retain working selection without animation", async ({ page }) => {
  for (const mode of ["reduce", "dom"]) {
    await page.emulateMedia({ reducedMotion: mode === "reduce" ? "reduce" : "no-preference" });
    await drag(page, "down", `&renderer=${mode === "dom" ? "dom" : "canvas"}`);
    await expect.poll(async () => Number(await page.locator("#wheels").textContent())).toBeGreaterThanOrEqual(3);
    await expect(page.locator(".wsg-selection-scroll")).toHaveCount(0);
    await page.mouse.up();
    await expect(page.locator("#selection")).toContainText("Output 021 中文 😀");
  }
});

test("a long styled selection keeps cell formatting and a bounded paint surface", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/tests/browser/terminal-selection.html?renderer=canvas&cols=120&rows=30&maxOffset=220&delay=5&chunkDelay=0&synchronized=1&styled=1");
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  await page.locator("#terminal").evaluate((element, box) => {
    element.style.width = `${box.width}px`;
    element.style.height = `${box.height}px`;
  }, box);
  await page.mouse.move(box.x + 1, box.y + box.height / 30 * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + box.height - 2, { steps: 4 });
  await expect(page.locator("#terminal")).toHaveAttribute("data-offset", "220", { timeout: 15000 });
  const first = page.locator(".wsg-selection-row").first().locator(".wsg-cell-text").first();
  await expect(first).toHaveCSS("color", "rgb(96, 165, 250)");
  await expect(page.locator(".wsg-cell-background").first()).toHaveCSS("background-color", "rgb(17, 28, 48)");
  await expect(first).toHaveCSS("font-size", "16px");
  await expect(first).toHaveCSS("font-weight", "700");
  await expect(first).toHaveCSS("text-decoration-line", "underline");
  expect(await page.locator(".wsg-selection-row").count()).toBeLessThan(60);
  const paintHeight = await page.locator(".wsg-selection-content").evaluate((element) => element.scrollHeight);
  expect(paintHeight).toBeLessThan(box.height * 3);
  await page.mouse.up();
  await expect(page.locator(".wsg-selection-scroll")).toHaveCount(0);
  const numbers = [...(await page.locator("#selection").textContent())!.matchAll(/Output (\d+)/g)].map((match) => Number(match[1]));
  expect(numbers.length).toBeGreaterThan(200);
  expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => 21 + index));
});

import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";

// Reuse Playwright's PNG decoder for pixel comparisons between the moving
// text and native pinned footer; DOM styles alone cannot detect their seam.
const { PNG } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle");

for (const renderer of ["canvas", "webgl"]) {
  for (const direction of ["up", "down"]) {
    test(`${renderer}: ${direction} drag keeps one selection appearance after the anchor leaves the screen`, async ({ page }, testInfo) => {
      await page.goto(`/tests/browser/terminal-selection.html?renderer=${renderer}&styled=1&dim=1&footerStyled=1&delay=240&chunkDelay=0&synchronized=1&offset=500&maxOffset=10000`);
      await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
      const screen = page.locator(".xterm-screen");
      const box = (await screen.boundingBox())!;
      const line = box.height / 12;
      await page.mouse.move(box.x + 1, box.y + line * (direction === "up" ? 9.5 : 2.5));
      await page.mouse.down();
      await page.mouse.move(box.x + 40, direction === "up" ? box.y + 2 : box.y + box.height - 2, { steps: 4 });
      await expect.poll(async () => Math.abs(Number(await page.locator("#terminal").getAttribute("data-offset")) - 500)).toBeGreaterThanOrEqual(18);
      // Stop requesting at the edge and select the entire frame for comparison
      // with the same text attributes in its native pinned footer.
      await page.mouse.move(box.x + 40, box.y + line * (direction === "up" ? 1.5 : 10.5));
      await page.waitForTimeout(400);
      await page.evaluate(() => window.selectTerminalForTest(0, 11));
      const highlights = await page.locator(".wsg-selection-scroll").evaluate((layer) => {
        const clip = layer.getBoundingClientRect();
        return [...layer.querySelectorAll<HTMLElement>(".wsg-selection-row")].filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top >= clip.top + 1 && rect.bottom <= clip.bottom - 1;
        }).map((row) => (row.lastElementChild as HTMLElement).style.display);
      });
      expect(highlights.length).toBeGreaterThan(3);
      expect(highlights.every((display) => display === "block")).toBe(true);
      const png = PNG.sync.read(await screen.screenshot({ path: testInfo.outputPath("selection-seam.png") }));
      const pixel = (x: number, y: number): number[] => [...png.data.subarray((Math.floor(y) * png.width + Math.floor(x)) * 4, (Math.floor(y) * png.width + Math.floor(x)) * 4 + 3)];
      const body = pixel(box.width - 40, line * 5.5);
      const footer = pixel(box.width - 40, line * 11.5);
      expect(body.every((channel, index) => Math.abs(channel - footer[index]) <= 1)).toBe(true);
      // Selected dim text must retain the native renderer's brightness too.
      const foreground = renderer === "webgl" ? [96, 165, 250] : [82, 135, 200];
      let matchingGlyphs = 0;
      for (let y = Math.ceil(line * 3); y < line * 9; y++) for (let x = 0; x < 95; x++) {
        if (pixel(x, y).every((channel, index) => Math.abs(channel - foreground[index]) <= 1)) matchingGlyphs++;
      }
      expect(matchingGlyphs).toBeGreaterThan(30);
      await page.mouse.up();
      await expect(page.locator(".wsg-selection-scroll")).toHaveCount(0);
    });
  }
}

test("edge selection doubles its wheel burst only after learning a safe scroll distance", async ({ page }) => {
  await page.goto("/tests/browser/terminal-selection.html?renderer=canvas&delay=500&chunkDelay=0&synchronized=1&maxOffset=10000&holdAfter=1");
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 12 * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + box.height - 2, { steps: 4 });
  await expect(page.locator("#wheels")).toHaveText("1");
  await expect(page.locator("#wheels")).toHaveText("3");
  await page.waitForTimeout(180);
  expect(await page.locator("#wheels").textContent()).toBe("3");
  await page.mouse.up();
  await page.evaluate(() => window.releaseTerminalRepliesForTest());
  await expect(page.locator("#selection")).toContainText("Output 035");
});

test("a burst waits for both separately rendered wheel replies and copies every line", async ({ page }) => {
  await page.goto("/tests/browser/terminal-selection.html?renderer=canvas&delay=400&chunkDelay=0&synchronized=1&separateReports=1&reportGap=250&maxOffset=10000&holdAfter=2");
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 12 * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + box.height - 2, { steps: 4 });
  await expect(page.locator("#terminal")).toHaveAttribute("data-offset", "24");
  await page.waitForTimeout(80);
  expect(await page.locator("#wheels").textContent()).toBe("3");
  await page.mouse.up();
  await page.evaluate(() => window.releaseTerminalRepliesForTest());
  await expect(page.locator("#terminal")).toHaveAttribute("data-offset", "26");
  await expect(page.locator("#selection")).toContainText("Output 035");
  const numbers = [...(await page.locator("#selection").textContent())!.matchAll(/Output (\d+)/g)].map((match) => Number(match[1]));
  expect(numbers).toEqual(Array.from({ length: 15 }, (_, index) => index + 21));
});

test("dragging farther below a tall viewport uses a three-report burst", async ({ page }) => {
  await page.goto("/tests/browser/terminal-selection.html?renderer=canvas&rows=30&delay=500&chunkDelay=0&synchronized=1&maxOffset=10000&holdAfter=1");
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  await page.locator("#terminal").evaluate((element, box) => { element.style.height = `${box.height}px`; }, box);
  await page.mouse.move(box.x + 1, box.y + box.height / 30 * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + box.height + 45, { steps: 4 });
  await expect(page.locator("#wheels")).toHaveText("4");
  await page.waitForTimeout(100);
  expect(await page.locator("#wheels").textContent()).toBe("4");
  await page.mouse.up();
  await page.evaluate(() => window.releaseTerminalRepliesForTest());
  await expect(page.locator("#selection")).toContainText("Output 055");
});

test("a large wheel step stays within the viewport's safe overlap", async ({ page }) => {
  await page.goto("/tests/browser/terminal-selection.html?renderer=canvas&wheelStep=4&delay=500&chunkDelay=0&synchronized=1&maxOffset=10000&holdAfter=1");
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 12 * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + box.height - 2, { steps: 4 });
  await expect(page.locator("#wheels")).toHaveText("2");
  await page.waitForTimeout(100);
  expect(await page.locator("#wheels").textContent()).toBe("2");
  await page.mouse.up();
  await page.evaluate(() => window.releaseTerminalRepliesForTest());
  await expect(page.locator("#selection")).toContainText("Output 037");
});

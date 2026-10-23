import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";

// Reuse Playwright's PNG decoder for pixel comparisons between the moving
// text and pinned footer; DOM styles alone cannot detect their seam.
const { PNG } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle");

for (const renderer of ["dom", "webgl"]) {
  for (const direction of ["up", "down"]) {
    test(`${renderer}: ${direction} drag keeps one selection appearance after the anchor leaves the screen`, async ({ page }, testInfo) => {
      await page.goto(`/tests/browser/terminal-selection.html?renderer=${renderer}&styled=1&dim=1&footerStyled=1&delay=240&chunkDelay=0&synchronized=1&offset=500&maxOffset=10000&holdAfter=10`);
      await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
      const screen = page.locator(".xterm-screen");
      const box = (await screen.boundingBox())!;
      const line = box.height / 12;
      await page.mouse.move(box.x + 1, box.y + line * (direction === "up" ? 9.5 : 2.5));
      await page.mouse.down();
      await page.mouse.move(box.x + 40, direction === "up" ? box.y + 2 : box.y + box.height - 2, { steps: 4 });
      await expect.poll(async () => Math.abs(Number(await page.locator("#terminal").getAttribute("data-offset")) - 500)).toBeGreaterThanOrEqual(18);
      // Inspect the actual drag highlight after its anchor leaves the screen.
      await page.waitForTimeout(400);
      await expect(page.locator(".wsg-selection-highlight")).toBeVisible();
      await expect(page.locator(".wsg-selection-frame")).toHaveCount(0);
      const png = PNG.sync.read(await screen.screenshot({ path: testInfo.outputPath("selection-seam.png") }));
      const pixel = (x: number, y: number): number[] => [...png.data.subarray((Math.floor(y) * png.width + Math.floor(x)) * 4, (Math.floor(y) * png.width + Math.floor(x)) * 4 + 3)];
      const body = pixel(box.width - 40, line * 5.5);
      // An upward drag does not select the footer below its anchor. Compare
      // another selected row instead of overriding the user's real selection.
      const referenceRow = direction === "up" ? 8 : 11;
      const footer = pixel(box.width - 40, line * (referenceRow + 0.5));
      expect(body.every((channel, index) => Math.abs(channel - footer[index]) <= 1)).toBe(true);
      // Moving text and pinned text must retain the same dim glyph appearance.
      const footerColors = new Map<string, number>();
      for (let y = Math.ceil(line * referenceRow); y < line * (referenceRow + 1); y++) for (let x = 0; x < 95; x++) {
        const color = pixel(x, y);
        if (color[2] > color[0] + 40 && color[2] > color[1] + 20 && color.some((c, i) => c !== footer[i])) {
          const key = color.join(",");
          footerColors.set(key, (footerColors.get(key) ?? 0) + 1);
        }
      }
      const foreground = [...footerColors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0].split(",").map(Number);
      expect(foreground).toBeDefined();
      let matchingGlyphs = 0;
      for (let y = Math.ceil(line * 3); y < line * 9; y++) for (let x = 0; x < 95; x++) {
        if (pixel(x, y).every((channel, index) => Math.abs(channel - foreground![index]) <= 1)) matchingGlyphs++;
      }
      expect(matchingGlyphs).toBeGreaterThan(30);
      await page.mouse.up();
      await expect(page.locator(".wsg-selection-scroll")).toHaveCount(0);
    });
  }
}

test("edge selection paces a bounded burst after learning the scroll distance", async ({ page }) => {
  await page.goto("/tests/browser/terminal-selection.html?renderer=dom&delay=500&chunkDelay=0&synchronized=1&maxOffset=10000&holdAfter=1");
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
  await page.goto("/tests/browser/terminal-selection.html?renderer=dom&delay=400&chunkDelay=0&synchronized=1&separateReports=1&reportGap=250&maxOffset=10000&holdAfter=2");
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

test("a tall viewport keeps each paced burst small while preserving overlap", async ({ page }) => {
  await page.goto("/tests/browser/terminal-selection.html?renderer=dom&rows=30&delay=500&chunkDelay=0&synchronized=1&maxOffset=10000&holdAfter=1");
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  await page.locator("#terminal").evaluate((element, box) => { element.style.height = `${box.height}px`; }, box);
  await page.mouse.move(box.x + 1, box.y + box.height / 30 * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + box.height + 45, { steps: 4 });
  await expect(page.locator("#wheels")).toHaveText("3");
  await page.waitForTimeout(100);
  expect(await page.locator("#wheels").textContent()).toBe("3");
  await page.mouse.up();
  await page.evaluate(() => window.releaseTerminalRepliesForTest());
  await expect(page.locator("#selection")).toContainText("Output 053");
});

test("a large wheel step stays within the viewport's safe overlap", async ({ page }) => {
  await page.goto("/tests/browser/terminal-selection.html?renderer=dom&wheelStep=4&delay=500&chunkDelay=0&synchronized=1&maxOffset=10000&holdAfter=1");
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

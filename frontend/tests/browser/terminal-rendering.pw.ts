import { expect, test } from "@playwright/test";

for (const renderer of ["canvas", "webgl"]) {
  test(`${renderer} rendering can be disposed repeatedly without errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.stack ?? error.message));
    await page.goto(`/tests/browser/terminal-selection.html?renderer=${renderer}`);
    await expect(page.locator(".xterm")).toHaveAttribute("data-terminal-renderer", renderer);
    await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
    // Resize and dispose in one task to leave a viewport refresh queued.
    await page.locator("#dispose").evaluate(button => {
      window.resizeTerminalForTest();
      (button as HTMLButtonElement).click();
    });
    await page.locator("#dispose").click();
    await expect(page.locator(".xterm")).toHaveCount(0);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(errors).toEqual([]);
  });
}

test("unavailable WebGL falls back to Canvas and keeps selection usable", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (type === "webgl2") return null;
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
  });
  await page.goto("/tests/browser/terminal-selection.html?renderer=webgl");
  await expect(page.locator(".xterm")).toHaveAttribute("data-terminal-renderer", "canvas", { timeout: 1000 });
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  const screen = (await page.locator(".xterm-screen").boundingBox())!;
  await page.mouse.move(screen.x + 1, screen.y + screen.height / 12 * 2.5);
  await page.mouse.down();
  await page.mouse.move(screen.x + 160, screen.y + screen.height / 12 * 3.5, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#selection")).toContainText("Output 021 中文 😀");
});

test("a lost GPU context immediately restores Canvas without replacing terminal text", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/tests/browser/terminal-selection.html?renderer=webgl");
  await expect(page.locator(".xterm")).toHaveAttribute("data-terminal-renderer", "webgl");
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  await page.locator(".xterm-screen").evaluate(screen => {
    for (const canvas of screen.querySelectorAll("canvas")) {
      const gl = canvas.getContext("webgl2");
      if (gl) { gl.getExtension("WEBGL_lose_context")!.loseContext(); return; }
    }
    throw new Error("No WebGL canvas");
  });
  await expect(page.locator(".xterm")).toHaveAttribute("data-terminal-renderer", "canvas", { timeout: 1000 });
  const screen = (await page.locator(".xterm-screen").boundingBox())!;
  await page.mouse.move(screen.x + 1, screen.y + screen.height / 12 * 2.5);
  await page.mouse.down();
  await page.mouse.move(screen.x + 160, screen.y + screen.height / 12 * 3.5, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#selection")).toContainText("Output 021 中文 😀");
  await page.locator("#dispose").click();
  await expect(page.locator(".xterm")).toHaveCount(0);
  expect(errors).toEqual([]);
});

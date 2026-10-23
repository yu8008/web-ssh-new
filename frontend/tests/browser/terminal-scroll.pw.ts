import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, query = "") {
  const params = new URLSearchParams("renderer=dom&delay=5&chunkDelay=0&synchronized=1&offset=1000&maxOffset=10000");
  new URLSearchParams(query).forEach((value, key) => params.set(key, value));
  await page.goto(`/tests/browser/terminal-selection.html?${params}`);
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
}

async function wheel(page: Page, deltaY: number, deltaMode = 1) {
  await page.locator(".xterm-screen").evaluate((screen, { deltaY, deltaMode }) => {
    const b = screen.getBoundingClientRect();
    screen.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaY, deltaMode, clientX: b.left + 20, clientY: b.top + 20,
    }));
  }, { deltaY, deltaMode });
}

for (const lines of [1, 10, 30]) {
  test(`application wheel slightly reduces a ${lines}-line input`, async ({ page }) => {
    await open(page);
    await wheel(page, lines);
    const reports = Math.floor(lines * 0.85);
    await expect(page.locator("#wheels")).toHaveText(String(reports));
    await expect(page.locator("#terminal")).toHaveAttribute("data-offset", String(1000 + reports * 2));
  });
}

test("small wheel steps keep their fractional distance after the speed reduction", async ({ page }) => {
  await open(page);
  await page.locator(".xterm-screen").evaluate(screen => {
    const b = screen.getBoundingClientRect();
    for (let i = 0; i < 20; i++) screen.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaY: 1, deltaMode: 1,
      clientX: b.left + 20, clientY: b.top + 20,
    }));
  });
  await expect(page.locator("#wheels")).toHaveText("17");
  await expect(page.locator("#terminal")).toHaveAttribute("data-offset", "1034");
});

test("trackpad fractions accumulate and a reversal cancels unsent scroll intent", async ({ page }) => {
  await open(page);
  await page.locator(".xterm-screen").evaluate(screen => {
    const b = screen.getBoundingClientRect();
    const row = b.height / 12;
    for (let i = 0; i < 8; i++) screen.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaMode: 0, deltaY: row / 4,
      clientX: b.left + 20, clientY: b.top + 20,
    }));
  });
  await expect(page.locator("#wheels")).toHaveText("1");
  await page.waitForTimeout(150);
  await page.locator(".xterm-screen").evaluate(screen => {
    const b = screen.getBoundingClientRect();
    for (const deltaY of [100, -2]) screen.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaMode: 1, deltaY,
      clientX: b.left + 20, clientY: b.top + 20,
    }));
  });
  await expect(page.locator("#wheels")).toHaveText("10");
  await page.waitForTimeout(180);
  expect(await page.locator("#wheels").textContent()).toBe("10");
  const inputs: string[] = JSON.parse((await page.locator("#inputs").textContent())!);
  expect(inputs.at(-1)).toMatch(/^\x1b\[<64;/);
});

for (const action of ["keyboard", "blur", "buffer"] as const) {
  test(`${action} cancels queued application scrolling before it reaches a new interaction`, async ({ page }) => {
    await open(page);
    await page.locator(".xterm-screen").evaluate(async (screen, action) => {
      const b = screen.getBoundingClientRect();
      screen.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, deltaMode: 1, deltaY: 100,
        clientX: b.left + 20, clientY: b.top + 20,
      }));
      if (action === "blur") window.dispatchEvent(new Event("blur"));
      else if (action === "keyboard") document.querySelector(".xterm-helper-textarea")!.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true, cancelable: true, key: "x", code: "KeyX", keyCode: 88,
      }));
      else await window.writeTerminalForTest("\x1b[?1049l");
    }, action);
    const reports = Number(await page.locator("#wheels").textContent());
    expect(reports).toBeLessThan(100);
    await page.waitForTimeout(180);
    expect(Number(await page.locator("#wheels").textContent())).toBe(reports);
    if (action === "keyboard") {
      const inputs: string[] = JSON.parse((await page.locator("#inputs").textContent())!);
      expect(inputs.at(-1)).toBe("x");
    }
  });
}

test("mouse mode keeps existing local history local, including drag selection and new output", async ({ page }) => {
  await open(page, "mode=shell&shellLines=5000&scrollLine=2000");
  await page.evaluate(() => window.writeTerminalForTest("\x1b[?1003h\x1b[?1006h"));
  await wheel(page, -10);
  await expect.poll(() => page.evaluate(() => window.terminalStateForTest().viewportY)).toBe(1992);
  expect(await page.locator("#wheels").textContent()).toBe("0");
  const b = (await page.locator(".xterm-screen").boundingBox())!;
  await page.mouse.move(b.x + 1, b.y + b.height / 12 * 2.5);
  await page.mouse.down();
  await page.mouse.move(b.x + 220, b.y + b.height / 12 * 5.5, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#selection")).toContainText("Shell row 1994");
  const selected = await page.locator("#selection").textContent();
  expect(selected).toContain("Shell row 1997");
  await page.waitForTimeout(160);
  await page.evaluate(() => window.writeTerminalForTest("\r\nnew live output"));
  expect(await page.evaluate(() => window.terminalStateForTest().viewportY)).toBe(1992);
  expect(await page.evaluate(() => window.terminalStateForTest().mouse)).toBe("any");
  expect(await page.locator("#wheels").textContent()).toBe("0");
  // Keyboard input still follows the live prompt.
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("x");
  await expect.poll(() => page.evaluate(() => {
    const s = window.terminalStateForTest(); return s.viewportY === s.baseY;
  })).toBe(true);
});

for (const renderer of ["dom", "webgl"]) {
  test(`${renderer}: synchronized output presents a complete frame and recovers from a missing end`, async ({ page }) => {
    await open(page, `renderer=${renderer}`);
    await page.waitForTimeout(80);
    const before = await page.evaluate(() => window.terminalStateForTest().renderCount);
    await page.evaluate(() => window.writeTerminalForTest("\x1b[?2026h\x1b[H\x1b[2KFIRST HALF"));
    await page.waitForTimeout(100);
    const partial = await page.evaluate(() => window.terminalStateForTest());
    expect(partial.renderCount).toBe(before);
    expect(partial.renderedLines.join("\n")).not.toContain("FIRST HALF");
    await page.evaluate(() => window.writeTerminalForTest("\x1b[2;1H\x1b[2KSECOND HALF\x1b[?2026l"));
    await expect.poll(() => page.evaluate(() => window.terminalStateForTest().renderedLines.slice(0, 2))).toEqual(["FIRST HALF", "SECOND HALF"]);
    await page.evaluate(() => window.writeTerminalForTest("\x1b[?2026h\x1b[H\x1b[2KRECOVERED"));
    // The core timeout is 1s; allow the software WebGL compositor and a busy
    // browser task queue to present the recovered frame before CI gives up.
    await expect.poll(() => page.evaluate(() => window.terminalStateForTest().renderedLines[0]), { timeout: 5000, intervals: [50, 100, 250] }).toBe("RECOVERED");
  });
}

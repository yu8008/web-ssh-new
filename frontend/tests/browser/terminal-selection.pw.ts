import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, query = "") {
  await page.goto(`/tests/browser/terminal-selection.html${query}`);
  await expect(page.locator("#terminal")).toHaveAttribute("data-ready", "true");
  const box = await page.locator(".xterm-screen").boundingBox();
  if (!box) throw new Error("Missing terminal screen");
  return { ...box, line: box.height / 12, cell: box.width / 64 };
}

for (const buffer of ["normal", "alternate"]) {
  test(`${buffer}: dragging down captures text across TUI repaints and stops on release`, async ({ page }) => {
    const box = await open(page, `?buffer=${buffer}&clickRepaint=1`);
    await page.mouse.move(box.x + 1, box.y + box.line * 2.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.cell * 8, box.y + box.height - 2, { steps: 10 });
    await expect.poll(async () => Number(await page.locator("#wheels").textContent())).toBeGreaterThanOrEqual(3);
    await page.mouse.up();
    await expect(page.locator("#selection")).toContainText("Output 021 中文 😀");
    await expect(page.locator("#selection")).toContainText("Output 033 中文 😀");
    await page.waitForTimeout(250);
    const wheels = await page.locator("#wheels").textContent();
    await page.waitForTimeout(300);
    expect(await page.locator("#wheels").textContent()).toBe(wheels);
    const captured = await page.locator("#selection").textContent();
    const numbers = [...captured!.matchAll(/Output (\d+)/g)].map((match) => Number(match[1]));
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => 21 + index));
    expect(captured!.match(/Fixed footer/g)).toHaveLength(1);
    await page.locator("#repaint").click();
    await page.waitForTimeout(100);
    await page.locator("#copy").click();
    expect(await page.locator("#copied").textContent()).toBe(captured);
    const reports = JSON.parse((await page.locator("#inputs").textContent())!);
    expect(reports.filter((input: string) => /^\x1b\[<0;.*M$/.test(input))).toHaveLength(0);
    expect(reports.filter((input: string) => /^\x1b\[<0;.*m$/.test(input))).toHaveLength(0);
    expect(reports.some((input: string) => /^\x1b\[<32;/.test(input))).toBe(false);
  });
}

for (const { synchronized, repeat } of [
  { synchronized: false, repeat: "1" },
  { synchronized: true, repeat: "1" },
  { synchronized: true, repeat: "boundary" },
]) {
  test(`a long ${synchronized ? "synchronized" : "split"} selection reaches the final rows through repeated output (${repeat})`, async ({ page }) => {
    const box = await open(page, `?repeat=${repeat}&delay=5&chunkDelay=0&maxOffset=150${synchronized ? "&synchronized=1" : ""}`);
    await page.mouse.move(box.x + 1, box.y + box.line * 2.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.cell * 8, box.y + box.height - 2, { steps: 5 });
    await expect(page.locator("#terminal")).toHaveAttribute("data-offset", "150", { timeout: 10000 });
    await page.mouse.up();
    await expect(page.locator("#selection")).toContainText("Output 159 中文 😀");
    const captured = (await page.locator("#selection").textContent())!;
    const numbers = [...captured.matchAll(/Output (\d+)/g)].map((match) => Number(match[1]));
    expect(numbers).toEqual(Array.from({ length: 139 }, (_, index) => {
      const absolute = 21 + index;
      return repeat === "boundary"
        ? absolute % 10 === 4 || absolute % 10 === 5 ? absolute - 2 : absolute
        : absolute % 10 === 4 ? absolute - 6 : absolute;
    }));
    expect(captured.match(/Fixed footer/g)).toHaveLength(1);
    await page.locator("#copy").click();
    expect(await page.locator("#copied").textContent()).toBe(captured);
  });
}

test("Shift drag scrolls upwards without sending a click", async ({ page }) => {
  const box = await open(page);
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + box.cell * 22, box.y + box.line * 9.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.cell * 22, box.y + 2, { steps: 10 });
  await expect.poll(async () => Number(await page.locator("#wheels").textContent())).toBeGreaterThanOrEqual(3);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.locator("#selection")).toContainText("Output 016 中文 😀");
  await expect(page.locator("#selection")).toContainText("Output 028 中文 😀");
  const reports = JSON.parse((await page.locator("#inputs").textContent())!);
  expect(reports.every((input: string) => /^\x1b\[<64;/.test(input))).toBe(true);
});

test("single clicks still reach the TUI and do not start auto-scroll", async ({ page }) => {
  const box = await open(page);
  await page.mouse.click(box.x + 40, box.y + box.line * 3);
  await expect(page.locator("#inputs")).toContainText("[<0;");
  const reports = JSON.parse((await page.locator("#inputs").textContent())!);
  expect(reports).toHaveLength(2);
  await page.waitForTimeout(250);
  expect(await page.locator("#wheels").textContent()).toBe("0");
  expect(await page.locator("#selection").textContent()).toBe("");
});

for (const delay of [500, 1600]) {
  test(`a ${delay}ms remote response does not queue or lose wheel events`, async ({ page }) => {
  const box = await open(page, `?delay=${delay}`);
  await page.mouse.move(box.x + 1, box.y + box.line * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + box.height - 2, { steps: 5 });
  await expect(page.locator("#wheels")).toHaveText("1");
  await page.waitForTimeout(delay - 150);
  expect(await page.locator("#wheels").textContent()).toBe("1");
  await page.mouse.up();
  await expect(page.locator("#selection")).toContainText("Output 031 中文 😀");
  expect(await page.locator("#wheels").textContent()).toBe("1");
});
}

for (const direction of ["up", "down"]) {
  test(`a split synchronized repaint stays continuous while dragging ${direction}`, async ({ page }) => {
    const box = await open(page, "?chunkDelay=350&synchronized=1");
    await page.mouse.move(box.x + 1, box.y + box.line * (direction === "up" ? 9.5 : 2.5));
    await page.mouse.down();
    await page.mouse.move(box.x + 20, direction === "up" ? box.y + 2 : box.y + box.height - 2, { steps: 5 });
    await expect.poll(async () => Number(await page.locator("#wheels").textContent())).toBeGreaterThanOrEqual(3);
    await expect.poll(async () => Math.abs(Number(await page.locator("#terminal").getAttribute("data-offset")) - 20)).toBeGreaterThanOrEqual(6);
    await page.mouse.up();
    await page.waitForTimeout(600);
    const captured = (await page.locator("#selection").textContent())!;
    const numbers = [...captured.matchAll(/Output (\d+)/g)].map((match) => Number(match[1]));
    expect(numbers.length).toBeGreaterThan(12);
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => numbers[0] + index));
  });
}

test("a late response is captured after the pointer moves away from the edge", async ({ page }) => {
  const box = await open(page, "?delay=1600");
  await page.mouse.move(box.x + 1, box.y + box.line * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + box.height - 2, { steps: 5 });
  await expect(page.locator("#wheels")).toHaveText("1");
  await page.waitForTimeout(1300);
  await page.mouse.move(box.x + box.cell * 24, box.y + box.line * 6.5, { steps: 3 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await expect(page.locator("#selection")).toContainText("Output 027 中文 😀");
  expect(await page.locator("#wheels").textContent()).toBe("1");
});

test("Alt selection highlights exactly the columns it copies", async ({ page }) => {
  const box = await open(page);
  await page.keyboard.down("Alt");
  await page.mouse.move(box.x + box.cell * 7, box.y + box.line * 1.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.cell * 10, box.y + box.line * 3.5, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect(page.locator("#selection")).toHaveText("020\n021\n022");
  const highlight = await page.locator(".wsg-column-selection").boundingBox();
  expect(highlight!.width).toBeCloseTo(box.cell * 3, 0);
  expect(highlight!.height).toBeCloseTo(box.line * 3, 0);
  await page.locator("#copy").click();
  await expect(page.locator("#copied")).toHaveText("020\n021\n022");
});

test("reversing direction reuses captured lines without duplicates", async ({ page }) => {
  const box = await open(page);
  await page.mouse.move(box.x + box.cell * 20, box.y + box.line * 8.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + box.height - 2, { steps: 5 });
  await expect.poll(async () => Number(await page.locator("#wheels").textContent())).toBeGreaterThanOrEqual(2);
  const count = Number(await page.locator("#wheels").textContent());
  await page.mouse.move(box.x + 20, box.y + 2, { steps: 5 });
  await expect.poll(async () => Number(await page.locator("#wheels").textContent())).toBeGreaterThan(count + 2);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const captured = (await page.locator("#selection").textContent())!;
  const numbers = [...captured.matchAll(/Output (\d+)/g)].map((match) => Number(match[1]));
  expect(numbers.length).toBeGreaterThan(3);
  expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => numbers[0] + index));
});

test("window blur and disposal stop an active edge selection", async ({ page }) => {
  const box = await open(page);
  await page.mouse.move(box.x + 1, box.y + box.line * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + box.height - 2, { steps: 5 });
  await expect.poll(async () => Number(await page.locator("#wheels").textContent())).toBeGreaterThanOrEqual(1);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const count = await page.locator("#wheels").textContent();
  await page.waitForTimeout(350);
  expect(await page.locator("#wheels").textContent()).toBe(count);
  await page.mouse.up();
  await page.locator("#dispose").click();
  await page.mouse.move(box.x + 1, box.y + box.line * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + box.height - 2, { steps: 5 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  expect(await page.locator("#wheels").textContent()).toBe(count);
});

test("ordinary shell selection retains native scrollback auto-scroll", async ({ page }) => {
  const box = await open(page, "?mode=shell");
  const initialTop = await page.evaluate(() => window.terminalStateForTest().viewportY);
  await page.mouse.move(box.x + 1, box.y + box.line * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height + 20, { steps: 10 });
  await expect.poll(() => page.evaluate(() => window.terminalStateForTest().viewportY)).toBeGreaterThan(initialTop);
  await page.waitForTimeout(200);
  await page.mouse.up();
  await expect(page.locator("#selection")).toContainText("Shell row");
  expect(await page.locator("#wheels").textContent()).toBe("0");
});

test("TUI wheel bursts send immediately and discard only unsent old-direction intent", async ({ page }) => {
  await open(page, "?delay=10&chunkDelay=0");
  await page.locator(".xterm-screen").evaluate((screen) => {
    const box = screen.getBoundingClientRect();
    for (const deltaY of [1, 1, 1, -1, -1]) {
      screen.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, deltaMode: 1, deltaY,
        clientX: box.left + 20, clientY: box.top + 20,
      }));
    }
  });
  await expect(page.locator("#wheels")).toHaveText("2");
  const packets: string[] = JSON.parse((await page.locator("#packets").textContent())!);
  expect(packets.length).toBeLessThanOrEqual(3);
  expect([...packets.join("").matchAll(/\x1b\[<(64|65);/g)].map((match) => match[1])).toEqual(["65", "64"]);
});

test("fast remote repaints advance promptly without repeatedly reading the full selection", async ({ page }) => {
  const box = await open(page, "?delay=10&chunkDelay=0&synchronized=1&maxOffset=10000");
  await page.mouse.move(box.x + 1, box.y + box.line * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + box.height - 2, { steps: 3 });
  await page.waitForTimeout(700);
  expect(Number(await page.locator("#wheels").textContent())).toBeGreaterThanOrEqual(10);
  expect(await page.locator("#selection").getAttribute("data-text-reads")).toBeNull();
  expect(await page.locator("#selection").getAttribute("data-changes")).toBe("1");
  await page.mouse.up();
  await expect(page.locator("#selection")).toContainText("Output 021 中文 😀");
  await page.waitForTimeout(100);
  const text = (await page.locator("#selection").textContent())!;
  const numbers = [...text.matchAll(/Output (\d+)/g)].map((match) => Number(match[1]));
  expect(numbers.length).toBeGreaterThan(20);
  expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => 21 + index));
  expect(Number(await page.locator("#selection").getAttribute("data-text-reads"))).toBeLessThanOrEqual(2);
});

test("continuous parsed output cannot starve cross-screen selection", async ({ page }) => {
  const box = await open(page, "?delay=10&chunkDelay=0&steady=1&maxOffset=10000");
  await page.mouse.move(box.x + 1, box.y + box.line * 2.5);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + box.height - 2, { steps: 3 });
  await page.waitForTimeout(700);
  expect(Number(await page.locator("#wheels").textContent())).toBeGreaterThanOrEqual(8);
  await page.mouse.up();
  await expect(page.locator("#selection")).toContainText("Output 021 中文 😀");
  const text = (await page.locator("#selection").textContent())!;
  const numbers = [...text.matchAll(/Output (\d+)/g)].map((match) => Number(match[1]));
  expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => 21 + index));
});

test("pointer movement inside the same selected cell does not redraw the selection", async ({ page }) => {
  const box = await open(page);
  const point = { x: box.x + box.cell * 8.2, y: box.y + box.line * 4.2 };
  await page.mouse.move(box.x + 1, box.y + box.line * 2.5);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 4 });
  await expect(page.locator("#selection")).toHaveAttribute("data-selected", "true");
  await page.locator(".wsg-selection-highlight").evaluate(layer => {
    layer.setAttribute("data-mutations", "0");
    let mutations = 0;
    new MutationObserver(() => layer.setAttribute("data-mutations", String(++mutations))).observe(layer, { subtree: true, attributes: true, attributeFilter: ["style", "class"] });
  });
  await page.evaluate(async (point) => {
    const screen = document.querySelector(".xterm-screen")!;
    for (let i = 0; i < 12; i++) {
      screen.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: point.x + i / 100, clientY: point.y }));
      await new Promise(requestAnimationFrame);
    }
  }, point);
  expect(await page.locator(".wsg-selection-highlight").getAttribute("data-mutations")).toBe("0");
  await page.mouse.up();
});

test("shell scrolling reaches its target immediately without inertia", async ({ page }) => {
  await open(page, "?mode=shell&renderer=dom");
  const before = await page.evaluate(() => window.terminalStateForTest().viewportY);
  await page.locator(".xterm-screen").evaluate(screen => {
    const box = screen.getBoundingClientRect();
    screen.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaMode: 1, deltaY: 8,
      clientX: box.left + 20, clientY: box.top + 20,
    }));
  });
  expect(await page.evaluate(() => window.terminalStateForTest().viewportY)).toBe(before + 7);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.terminalStateForTest().viewportY)).toBe(before + 7);
});

for (const direction of ["up", "down"]) {
  test(`a shell gesture remains local until the next gesture at the ${direction} boundary`, async ({ page }) => {
    await open(page, `?mode=shell&enhanced=1&scrollLine=${direction === "up" ? 1 : 87}`);
    const wheel = () => page.locator(".xterm-screen").evaluate((screen, direction) => {
      const box = screen.getBoundingClientRect();
      screen.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, deltaMode: 1, deltaY: direction === "up" ? -4 : 4,
        clientX: box.left + 20, clientY: box.top + 20,
      }));
    }, direction);
    await wheel();
    await wheel();
    expect(await page.locator("#packets").textContent()).toBe("");
    await page.waitForTimeout(150);
    await wheel();
    const packets: string[] = JSON.parse((await page.locator("#packets").textContent())!);
    expect(packets).toEqual([direction === "up" ? "\x1b[5~" : "\x1b[6~"]);
  });
}

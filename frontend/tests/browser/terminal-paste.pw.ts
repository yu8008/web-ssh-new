import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

async function open(page: Page) {
  await page.goto("/tests/browser/terminal-output.html");
  await expect(page.locator("#connection")).toHaveText("open");
  await page.evaluate(() => window.pipeline.frame({ type: "output", seq: 1, data: "\x1b[?2004h" }));
  await expect.poll(() => page.evaluate(() => window.pipeline.pasteMode())).toBe(true);
}

async function copyImage(page: Page) {
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2; canvas.height = 2;
    canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  });
}

const inputs = (page: Page) => page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "input"));
const uploadedPath = "/tmp/webssh-clipboard.test123/image.png";

test("image attachments keep bracketed paste after a truncated replay; later CLI exit restores plain paste", async ({ page }) => {
  await page.route("**/system/clipboard-image/pipeline", route => route.fulfill({ json: { path: uploadedPath } }));
  await open(page);
  await page.locator("#reconnect").click();
  await expect.poll(() => page.evaluate(() => window.pipeline.count())).toBe(2);
  await page.evaluate(() => {
    window.pipeline.frame({ type: "replay_start" });
    window.pipeline.frame({ type: "output", seq: 10, data: "Recent CLI history without the old mode switch\r\n" });
    window.pipeline.frame({ type: "replay_end", seq: 10, bracketed_paste: true });
  });
  await expect.poll(() => page.evaluate(() => window.pipeline.pasteMode())).toBe(true);
  await copyImage(page);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+v");
  await expect.poll(() => inputs(page)).toEqual([{ type: "input", data: `\x1b[200~${uploadedPath} \x1b[201~` }]);
  await page.evaluate(() => window.pipeline.frame({ type: "output", seq: 11, data: "\x1b[?2004l" }));
  await expect.poll(() => page.evaluate(() => window.pipeline.pasteMode())).toBe(false);
  await page.evaluate(() => navigator.clipboard.writeText("plain shell input"));
  await page.keyboard.press("Control+v");
  await expect.poll(async () => (await inputs(page)).at(-1)).toEqual({ type: "input", data: "plain shell input" });
});

test("Ctrl+V pastes local clipboard text once without sending the remote clipboard shortcut", async ({ page }) => {
  await open(page);
  await page.evaluate(() => navigator.clipboard.writeText("粘贴中文😀\nsecond line"));
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+v");
  await expect.poll(() => inputs(page))
    .toEqual([{ type: "input", data: "\x1b[200~粘贴中文😀\rsecond line\x1b[201~" }]);
});

test("Ctrl+Shift+V also pastes browser clipboard text", async ({ page }) => {
  await open(page);
  await page.evaluate(() => navigator.clipboard.writeText("plain text"));
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+Shift+v");
  await expect.poll(() => inputs(page)).toEqual([{ type: "input", data: "\x1b[200~plain text\x1b[201~" }]);
});

test("Ctrl+V uploads the local screenshot and pastes its remote path without a remote clipboard request", async ({ page }) => {
  let uploads = 0;
  await page.route("**/system/clipboard-image/pipeline", async route => {
    uploads++;
    expect(await route.request().headerValue("authorization")).toBe("Bearer fixture-token");
    expect(route.request().method()).toBe("POST");
    expect(route.request().postData()).toContain("Content-Type: image/png");
    await route.fulfill({ json: { path: uploadedPath } });
  });
  await open(page);
  await copyImage(page);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+v");
  await expect.poll(() => inputs(page)).toEqual([{ type: "input", data: `\x1b[200~${uploadedPath} \x1b[201~` }]);
  expect(uploads).toBe(1);
  await expect(page.locator("#notice")).toHaveText("已粘贴 1 张图片");
});

test("mixed image and text clipboard data attaches the image without inserting its metadata", async ({ page }) => {
  await page.route("**/system/clipboard-image/pipeline", route => route.fulfill({ json: { path: uploadedPath } }));
  await open(page);
  await page.locator(".xterm-helper-textarea").evaluate(element => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "unwanted image metadata");
    clipboard.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "image.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await expect.poll(() => inputs(page)).toEqual([{ type: "input", data: `\x1b[200~${uploadedPath} \x1b[201~` }]);
});

test("image upload failure reports the error without sending Ctrl+V or an invalid path", async ({ page }) => {
  await page.route("**/system/clipboard-image/pipeline", route => route.fulfill({ status: 502, json: { detail: "Could not save clipboard image on the SSH target" } }));
  await open(page);
  await copyImage(page);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+v");
  await expect(page.locator("#notice")).toContainText("粘贴失败：");
  expect(await inputs(page)).toEqual([]);
  await page.evaluate(() => navigator.clipboard.writeText("recover"));
  await page.keyboard.press("Control+v");
  await expect.poll(() => inputs(page)).toEqual([{ type: "input", data: "\x1b[200~recover\x1b[201~" }]);
});

test("pastes stay in order and Enter waits for screenshot upload to finish", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let uploads = 0;
  await page.route("**/system/clipboard-image/pipeline", async route => {
    uploads++;
    await gate;
    await route.fulfill({ json: { path: uploadedPath } });
  });
  await open(page);
  await copyImage(page);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+v");
  await expect.poll(() => uploads).toBe(1);
  await page.keyboard.press("Enter");
  await page.evaluate(() => navigator.clipboard.writeText("caption"));
  await page.keyboard.press("Control+v");
  expect(await inputs(page)).toEqual([]);
  release();
  await expect.poll(() => inputs(page)).toEqual([
    { type: "input", data: `\x1b[200~${uploadedPath} \x1b[201~` },
    { type: "input", data: "\x1b[200~caption\x1b[201~" },
  ]);
  await page.keyboard.press("Enter");
  await expect.poll(() => inputs(page)).toHaveLength(3);
  expect((await inputs(page)).at(-1)?.data).toBe("\r");
});

test("an upload that finishes after reconnect never injects its path into the new connection", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let uploads = 0;
  await page.route("**/system/clipboard-image/pipeline", async route => {
    uploads++;
    await gate;
    await route.fulfill({ json: { path: uploadedPath } });
  });
  await open(page);
  await copyImage(page);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+v");
  await expect.poll(() => uploads).toBe(1);
  await page.locator("#reconnect").click();
  await expect.poll(() => page.evaluate(() => window.pipeline.count())).toBe(2);
  release();
  await expect(page.locator("#notice")).toContainText("终端连接已变化");
  expect(await inputs(page)).toEqual([]);
});

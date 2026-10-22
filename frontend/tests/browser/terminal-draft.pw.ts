import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, query = "") {
  await page.goto(`/tests/browser/terminal-output.html?pingDelay=300&diagnostics=1${query}`);
  await expect(page.locator("#connection")).toHaveText("open");
  await page.evaluate(() => window.pipeline.frame({ type: "output", seq: 1, data: "\x1b[?2004hReady\r\n" }));
  await expect.poll(() => page.evaluate(() => window.pipeline.pasteMode())).toBe(true);
  await page.getByRole("button", { name: "本地输入", exact: true }).click();
}
const inputs = (page: Page) => page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "input"));

test("local Chinese drafts remain responsive during remote output and send only when filled", async ({ page }) => {
  await open(page);
  const before = await page.evaluate(() => window.pipeline.dimensions());
  const editor = page.getByRole("textbox", { name: "本地描述输入框" });
  await editor.fill("描述：中文😀\n第二行");
  await page.evaluate(() => { for (let i = 0; i < 80; i++) window.pipeline.frame({ type: "output", seq: i + 2, data: `正在输出 ${i}\r\n` }); });
  await expect(editor).toHaveValue("描述：中文😀\n第二行");
  expect(await inputs(page)).toEqual([]);
  await editor.press("Enter");
  await editor.type("third");
  expect(await inputs(page)).toEqual([]);
  await page.getByRole("button", { name: "填入终端", exact: true }).click();
  await expect.poll(() => inputs(page)).toEqual([{ type: "input", data: "\x1b[200~描述：中文😀\r第二行\rthird\x1b[201~" }]);
  await expect(editor).toHaveValue("");
  expect(await page.evaluate(() => window.pipeline.dimensions())).toEqual(before);
});

test("IME confirmation does not submit a draft and Ctrl+Enter fills after composition ends", async ({ page }) => {
  await open(page);
  const editor = page.getByRole("textbox", { name: "本地描述输入框" });
  await editor.fill("输入法确认");
  await editor.dispatchEvent("compositionstart");
  await editor.press("Control+Enter");
  expect(await inputs(page)).toEqual([]);
  await editor.dispatchEvent("compositionend");
  await editor.press("Control+Enter");
  await expect.poll(() => inputs(page)).toEqual([{ type: "input", data: "\x1b[200~输入法确认\x1b[201~" }]);
});

test("disconnects preserve local drafts and multiline drafts do not execute in an unprotected shell", async ({ page }) => {
  await open(page);
  const editor = page.getByRole("textbox", { name: "本地描述输入框" });
  await editor.fill("第一行\n第二行");
  await page.evaluate(() => window.pipeline.frame({ type: "output", seq: 2, data: "\x1b[?2004l" }));
  await expect.poll(() => page.evaluate(() => window.pipeline.pasteMode())).toBe(false);
  await page.getByRole("button", { name: "填入终端", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("当前程序未启用安全多行粘贴");
  expect(await inputs(page)).toEqual([]);
  await expect(editor).toHaveValue("第一行\n第二行");
  await page.evaluate(() => window.pipeline.disconnect());
  await expect(page.getByRole("button", { name: "填入终端", exact: true })).toBeDisabled();
  await page.locator("#reconnect").click();
  await expect(page.locator("#connection")).toHaveText("open");
  await expect(editor).toHaveValue("第一行\n第二行");
  await page.evaluate(() => window.pipeline.frame({ type: "output", seq: 1, data: "\x1b[?2004h" }));
  await expect.poll(() => page.evaluate(() => window.pipeline.pasteMode())).toBe(true);
  await page.getByRole("button", { name: "填入终端", exact: true }).click();
  await expect.poll(() => inputs(page)).toEqual([{ type: "input", data: "\x1b[200~第一行\r第二行\x1b[201~" }]);
});

test("local screenshot and text fill in order after upload, with Enter kept separate", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  let release = () => {};
  await page.route("**/system/clipboard-image/pipeline", async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { path: "/tmp/webssh-clipboard.local/image.png" } });
  });
  const editor = page.getByRole("textbox", { name: "本地描述输入框" });
  await editor.fill("解释这张图");
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 2;
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  });
  await editor.focus(); await editor.press("Control+v");
  await expect(page.getByRole("button", { name: "移除图片 1" })).toBeVisible();
  expect(await inputs(page)).toEqual([]);
  await page.getByRole("button", { name: "填入终端", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("图片上传中");
  await page.locator(".xterm-helper-textarea").focus(); await page.keyboard.press("Enter");
  expect(await inputs(page)).toEqual([]);
  release();
  await expect.poll(() => inputs(page)).toEqual([
    { type: "input", data: "\x1b[200~/tmp/webssh-clipboard.local/image.png \x1b[201~" },
    { type: "input", data: "\x1b[200~解释这张图\x1b[201~" },
  ]);
  await expect(editor).toHaveValue("");
});

test("latency details separate gateway, browser, SSH and output measurements", async ({ page }) => {
  await open(page);
  await expect.poll(() => page.evaluate(() => window.pipeline.diagnostics()?.gatewayQueueMs)).toBe(6);
  await page.getByRole("button", { name: "延迟诊断", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "延迟诊断" });
  await expect(dialog.getByRole("row", { name: "网关 ↔ SSH 目标 24ms" })).toBeVisible();
  await expect(dialog.getByRole("row", { name: "网关回包排队 6ms" })).toBeVisible();
  await expect(dialog.getByRole("row", { name: "网关调度迟到（近 5 秒最大） 3ms" })).toBeVisible();
  await expect(dialog).toContainText("不能直接从往返时间中相减");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "延迟诊断", exact: true })).toBeFocused();
});

test("output acknowledgements wait for parsing and carry the stream identity", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    for (let seq = 2; seq < 20; seq++) window.pipeline.frame({ type: "output", seq, epoch: "live-stream", data: `完整输出 ${seq} 中文😀\r\n` });
  });
  await expect.poll(() => page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "ack").at(-1)))
    .toEqual({ type: "ack", ack_seq: 19, epoch: "live-stream" });
  await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain("完整输出 19 中文😀");
});

test("a failed screenshot upload and a changed connection retain the complete local draft", async ({ page }) => {
  await open(page);
  const editor = page.getByRole("textbox", { name: "本地描述输入框" });
  await editor.fill("截图说明");
  await page.getByLabel("选择图片", { exact: true }).setInputFiles({ name: "screenshot.png", mimeType: "image/png", buffer: Buffer.from("png fixture") });
  await page.route("**/system/clipboard-image/pipeline", route => route.fulfill({ status: 502, json: { detail: "Image upload failed" } }));
  await page.getByRole("button", { name: "填入终端", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Image upload failed");
  await expect(editor).toHaveValue("截图说明");
  await expect(page.getByRole("button", { name: "移除图片 1" })).toBeVisible();
  expect(await inputs(page)).toEqual([]);
  await page.unroute("**/system/clipboard-image/pipeline");
  let release = () => {};
  await page.route("**/system/clipboard-image/pipeline", async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { path: "/tmp/webssh-clipboard.old/image.png" } });
  });
  const uploading = page.waitForRequest("**/system/clipboard-image/pipeline");
  await page.getByRole("button", { name: "填入终端", exact: true }).click();
  await uploading;
  await page.locator("#reconnect").click();
  await expect.poll(() => page.evaluate(() => window.pipeline.count())).toBe(2);
  release();
  await expect(page.locator("#notice")).toContainText("终端连接已变化");
  await expect(editor).toHaveValue("截图说明");
  await expect(page.getByRole("button", { name: "移除图片 1" })).toBeVisible();
  expect(await inputs(page)).toEqual([]);
});

test("a v1 server still supports typing and local drafts without output acknowledgements", async ({ page }) => {
  await open(page, "&v1=1");
  await page.getByRole("textbox", { name: "本地描述输入框" }).fill("兼容旧后端");
  await page.getByRole("button", { name: "填入终端", exact: true }).click();
  await expect.poll(() => inputs(page)).toEqual([{ type: "input", data: "\x1b[200~兼容旧后端\x1b[201~" }]);
  expect(await page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "ack"))).toEqual([]);
});

test("automatic reconnect preserves the local editor's focus and never forwards its keystrokes", async ({ page }) => {
  await open(page);
  const editor = page.getByRole("textbox", { name: "本地描述输入框" });
  await editor.fill("保留草稿");
  await page.evaluate(() => window.pipeline.disconnect(true));
  await expect(page.locator("#connection")).toHaveText("closed");
  await editor.focus();
  await expect.poll(() => page.evaluate(() => window.pipeline.count()), { timeout: 10000 }).toBe(2);
  await expect(page.locator("#connection")).toHaveText("open");
  await expect(editor).toBeFocused();
  await page.keyboard.insertText("继续输入");
  await expect(editor).toHaveValue("保留草稿继续输入");
  expect(await inputs(page)).toEqual([]);
});

test("folding a draft during composition does not leave it unable to fill", async ({ page }) => {
  await open(page);
  const editor = page.getByRole("textbox", { name: "本地描述输入框" });
  await editor.fill("输入法草稿");
  await editor.dispatchEvent("compositionstart");
  await page.getByRole("button", { name: /^本地输入/ }).click();
  await page.getByRole("button", { name: /^本地输入/ }).click();
  await page.getByRole("button", { name: "填入终端", exact: true }).click();
  await expect.poll(() => inputs(page)).toEqual([{ type: "input", data: "\x1b[200~输入法草稿\x1b[201~" }]);
});

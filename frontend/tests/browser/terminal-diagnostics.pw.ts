import { expect, test } from "@playwright/test";

test("latency details separate gateway, browser, SSH and output measurements", async ({ page }) => {
  await page.goto("/tests/browser/terminal-output.html?pingDelay=300&diagnostics=1");
  await expect(page.locator("#connection")).toHaveText("open");
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
  await page.goto("/tests/browser/terminal-output.html");
  await expect(page.locator("#connection")).toHaveText("open");
  await page.evaluate(() => {
    for (let seq = 1; seq < 20; seq++) window.pipeline.frame({ type: "output", seq, epoch: "live-stream", data: `完整输出 ${seq} 中文😀\r\n` });
  });
  await expect.poll(() => page.evaluate(() => window.pipeline.inputs().filter(input => input.type === "ack").at(-1)))
    .toEqual({ type: "ack", ack_seq: 19, epoch: "live-stream" });
  await expect.poll(() => page.evaluate(() => window.pipeline.screen())).toContain("完整输出 19 中文😀");
});

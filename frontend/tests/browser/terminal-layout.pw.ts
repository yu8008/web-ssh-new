import { expect, test } from "@playwright/test";

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"}: terminal uses the available space and accepts direct input and paste`, async ({ page, context }, testInfo) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.addInitScript(() => {
      const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
      localStorage.setItem("token", `test.${payload}.signature`);
      localStorage.setItem("user_id", "1"); localStorage.setItem("app_language", "zh-CN");
    });
    const session = { id: "layout", name: "Codex terminal", connection_id: 1, status: "active", host: "test-host", username: "tester",
      started_at: new Date().toISOString(), last_activity: new Date().toISOString(), enhanced_enabled: true, target_avg_rtt_ms: 24 };
    await page.route("**/*", async route => {
      if (route.request().resourceType() !== "fetch") return route.continue();
      const path = new URL(route.request().url()).pathname;
      if (path === "/sessions/layout") return route.fulfill({ json: session });
      if (path === "/sessions") return route.fulfill({ json: [session] });
      if (path === "/connections") return route.fulfill({ json: [] });
      if (path === "/health" || path === "/system/settings") return route.fulfill({ json: {} });
      return route.fulfill({ status: 503, json: { detail: "Unavailable in layout test" } });
    });
    await page.routeWebSocket("**/sessions/ws/sessions/**", () => {});
    const inputs: string[] = [];
    const sizes: Array<{ rows: number; cols: number }> = [];
    await page.routeWebSocket("**/sessions/ws/terminal/**", socket => {
      let closed = false;
      socket.onClose(() => { closed = true; });
      socket.onMessage(data => {
        const message = JSON.parse(String(data));
        if (message.type === "input") inputs.push(message.data);
        if (message.type === "resize") sizes.push(message);
        if (message.type === "ping") setTimeout(() => { if (!closed) socket.send(JSON.stringify({ type: "pong", ping_id: message.ping_id, gateway_queue_ms: 2, gateway_loop_lag_ms: 1 })); }, 30);
      });
      socket.send(JSON.stringify({ type: "replay_start" }));
      socket.send(JSON.stringify({ type: "output", seq: 1, data: "\x1b[?2004hReady 中文😀\r\n› " }));
      socket.send(JSON.stringify({ type: "replay_end", seq: 1 }));
    });
    await page.goto("/terminal/layout");
    await expect(page.locator(".xterm")).toBeVisible();
    await expect.poll(() => sizes.length).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    const initialInputs = [...inputs]; // Enhanced sessions announce terminal colors on connection.
    await expect(page.getByRole("button", { name: "本地输入", exact: true })).toHaveCount(0);
    const box = (await page.locator(".xterm").boundingBox())!;
    expect(page.viewportSize()!.height - box.y - box.height).toBeLessThan(mobile ? 120 : 60);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.insertText("请检查当前项目");
    await page.keyboard.press("F2");
    await page.evaluate(() => navigator.clipboard.writeText("第一行\n第二行"));
    await page.keyboard.press("Control+v");
    await expect.poll(() => inputs.slice(initialInputs.length)).toEqual([
      "请检查当前项目", "\x1bOQ", "\x1b[200~第一行\r第二行\x1b[201~",
    ]);
    await page.screenshot({ path: testInfo.outputPath("terminal.png") });
    await page.getByRole("button", { name: "延迟诊断", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "延迟诊断" })).toContainText("浏览器 ↔ 网关");
    await expect(page.getByRole("dialog").getByRole("row", { name: "网关回包排队 2ms" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("latency-details.png") });
  });
}

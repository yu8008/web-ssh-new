import { expect, test } from "@playwright/test";

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"}: local draft fits the terminal and fills Chinese text once`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.addInitScript(() => {
      const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
      localStorage.setItem("token", `test.${payload}.signature`);
      localStorage.setItem("user_id", "1"); localStorage.setItem("app_language", "zh-CN");
    });
    const session = { id: "draft", name: "Codex 本地输入", connection_id: 1, status: "active", host: "test-host", username: "tester",
      started_at: new Date().toISOString(), last_activity: new Date().toISOString(), enhanced_enabled: true, target_avg_rtt_ms: 24 };
    await page.route("**/*", async route => {
      if (route.request().resourceType() !== "fetch") return route.continue();
      const path = new URL(route.request().url()).pathname;
      if (path === "/sessions/draft") return route.fulfill({ json: session });
      if (path === "/sessions") return route.fulfill({ json: [session] });
      if (path === "/connections") return route.fulfill({ json: [] });
      if (path === "/health" || path === "/system/settings") return route.fulfill({ json: {} });
      return route.fulfill({ status: 503, json: { detail: "Unavailable in draft test" } });
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
    await page.goto("/terminal/draft");
    await expect(page.locator(".xterm")).toBeVisible();
    await expect.poll(() => sizes.length).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    const fullRows = sizes.at(-1)!.rows;
    const initialInputs = [...inputs]; // Enhanced sessions announce terminal colors on connection.
    await page.getByRole("button", { name: "本地输入", exact: true }).click();
    await expect.poll(() => sizes.at(-1)!.rows).toBeLessThan(fullRows);
    const editor = page.getByRole("textbox", { name: "本地描述输入框" });
    await editor.fill("请检查当前项目\n并解释延迟原因。");
    expect(inputs).toEqual(initialInputs);
    await page.screenshot({ path: testInfo.outputPath("local-draft.png") });
    await page.getByRole("button", { name: "填入终端", exact: true }).click();
    await expect.poll(() => inputs.slice(initialInputs.length)).toEqual(["\x1b[200~请检查当前项目\r并解释延迟原因。\x1b[201~"]);
    await expect(editor).toHaveValue("");
    await page.getByRole("button", { name: "本地输入", exact: true }).click();
    await expect.poll(() => sizes.at(-1)!.rows).toBe(fullRows);
    await page.getByRole("button", { name: "延迟诊断", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "延迟诊断" })).toContainText("浏览器 ↔ 网关");
    await expect(page.getByRole("dialog").getByRole("row", { name: "网关回包排队 2ms" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("latency-details.png") });
  });
}

import { expect, test, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";

async function setup(page: Page, context: BrowserContext, remember: boolean) {
  const errors: string[] = [];
  context.on("page", child => child.on("pageerror", error => errors.push(error.message)));
  page.on("pageerror", error => errors.push(error.message));
  const session = { id: "navigation", connection_id: 1, name: "Navigation session", status: "active",
    host: "test-host", username: "tester", started_at: new Date().toISOString(),
    last_activity: new Date().toISOString(), enhanced_enabled: true, target_avg_rtt_ms: 37 };
  await context.route("**/*", async route => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    const path = new URL(route.request().url()).pathname;
    if (path === "/sessions") return route.fulfill({ json: [session] });
    if (path === "/sessions/navigation") return route.fulfill({ json: session });
    if (path === "/connections") return route.fulfill({ json: [] });
    if (path === "/health" || path === "/system/settings") return route.fulfill({ json: {} });
    return route.fulfill({ status: 503, json: { detail: "Unavailable in navigation test" } });
  });
  await context.routeWebSocket("**/sessions/ws/sessions/**", () => {});
  await context.routeWebSocket("**/notifications/ws", socket => socket.send(JSON.stringify({ type: "snapshot", events: [] })));
  const sockets = new Set<WebSocketRoute>();
  const inputs: string[] = [];
  await context.routeWebSocket("**/sessions/ws/terminal/**", socket => {
    sockets.add(socket); socket.onClose(() => sockets.delete(socket));
    socket.onMessage(raw => { const frame = JSON.parse(String(raw)); if (frame.type === "input") inputs.push(frame.data); });
    socket.send(JSON.stringify({ type: "replay_start" }));
    socket.send(JSON.stringify({ type: "output", seq: 1, data: "Ready\r\n$ " }));
    socket.send(JSON.stringify({ type: "replay_end", seq: 1 }));
  });
  await page.goto("/");
  // Seed only the opener. Child pages must inherit actual login storage rather
  // than receiving artificial authentication through an init script.
  await page.evaluate(remember => {
    const payload = btoa(JSON.stringify({ sub: "1", exp: Math.floor(Date.now() / 1000) + 3600 }));
    const storage = remember ? localStorage : sessionStorage;
    storage.setItem("token", `test.${payload}.signature`); storage.setItem("user_id", "1");
    localStorage.setItem("app_language", "zh-CN");
  }, remember);
  await page.goto("/sessions");
  await expect(page.getByRole("button", { name: "打开会话 Navigation session", exact: true })).toBeVisible();
  await page.evaluate(() => { document.documentElement.dataset.navigationTest = "original-list"; });
  return { sockets, inputs, errors };
}

for (const mobile of [false, true]) test.describe(mobile ? "mobile navigation" : "desktop navigation", () => {
  test.use({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
  for (const remember of [false, true]) test(`${remember ? "remembered" : "temporary"} login opens each session entry in an independent tab and preserves the list`, async ({ page, context }) => {
    const mock = await setup(page, context, remember);
    if (mobile) await page.getByRole("button", { name: "搜索", exact: true }).click();
    const search = page.getByRole("textbox", { name: "搜索", exact: true });
    await search.fill("Navigation");
    for (const entry of ["card", "button", "keyboard", "menu", "resume"] as const) {
      const card = page.getByRole("button", { name: "打开会话 Navigation session", exact: true });
      const opened = page.waitForEvent("popup");
      if (entry === "button") await card.getByRole("button", { name: "打开", exact: true }).click();
      else if (entry === "keyboard") { await card.focus(); await page.keyboard.press("Enter"); }
      else if (entry === "menu") {
        await card.getByRole("button", { name: "更多操作", exact: true }).click();
        await page.getByRole("menuitem", { name: "在新标签页打开", exact: true }).click();
      } else if (entry === "resume") await page.locator(".workspace-resume").click();
      else await card.click();
      const terminal = await opened;
      await expect(terminal).toHaveURL(/\/terminal\/navigation$/);
      await expect(terminal.locator(".xterm")).toBeVisible();
      await expect(terminal.getByText("已连接", { exact: true })).toBeVisible();
      await expect(terminal.getByText("SSH 37ms", { exact: true })).toBeVisible();
      expect(await terminal.evaluate(() => window.opener === null)).toBe(true);
      if (!remember) {
        expect(await terminal.evaluate(() => localStorage.getItem("token"))).toBeNull();
        expect(await terminal.evaluate(() => Boolean(sessionStorage.getItem("token")))).toBe(true);
      }
      await expect(page).toHaveURL(/\/sessions$/);
      await expect(page.locator("html")).toHaveAttribute("data-navigation-test", "original-list");
      await expect(search).toHaveValue("Navigation");
      expect(context.pages()).toHaveLength(2);
      expect(mock.inputs).toEqual([]);
      if (entry === "resume") {
        await terminal.getByRole("button", { name: mobile ? "返回" : "返回会话管理", exact: true }).click();
        await expect(terminal).toHaveURL(/\/sessions$/);
        await expect(terminal.locator(".xterm")).toHaveCount(0);
        await expect.poll(() => mock.sockets.size).toBe(0);
        expect(await terminal.evaluate(() => document.body.dispatchEvent(new KeyboardEvent("keydown", {
          key: "F2", code: "F2", keyCode: 113, bubbles: true, cancelable: true,
        })))).toBe(true);
      }
      await terminal.close();
      await expect.poll(() => mock.sockets.size).toBe(0);
    }
    expect(mock.errors).toEqual([]);
  });
});

test("blocked terminal popups give feedback and leave the session list intact", async ({ page, context }) => {
  await setup(page, context, false);
  await page.evaluate(() => { window.open = () => null; });
  await page.getByRole("button", { name: "打开会话 Navigation session", exact: true }).click();
  await expect(page.getByText("无法打开新标签页，请允许此网站打开弹窗后重试", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/sessions$/);
  expect(context.pages()).toHaveLength(1);
});

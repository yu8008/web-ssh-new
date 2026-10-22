import { expect, test, type WebSocketRoute } from "@playwright/test";

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test.describe(viewport.width < 768 ? "mobile navigation" : "desktop navigation", () => {
    test.use({ viewport });

    for (const back of ["arrow", "browser"] as const) {
      test(`${back} returns from a terminal to the updated workbench without a reload`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
        await page.addInitScript(() => {
          const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
          localStorage.setItem("token", `test.${payload}.signature`);
          localStorage.setItem("user_id", "1");
          localStorage.setItem("app_language", "zh-CN");
        });

        const session = {
          id: "navigation",
          connection_id: 1,
          name: "Navigation session",
          status: "active",
          host: "test-host",
          username: "tester",
          started_at: new Date().toISOString(),
          last_activity: new Date().toISOString(),
          enhanced_enabled: false,
          target_avg_rtt_ms: 37,
        };
        await page.route("**/*", async (route) => {
          if (route.request().resourceType() !== "fetch") return route.continue();
          const path = new URL(route.request().url()).pathname;
          if (path === "/sessions") return route.fulfill({ json: [session] });
          if (path === "/sessions/navigation") return route.fulfill({ json: session });
          if (path === "/connections") return route.fulfill({ json: [] });
          if (path === "/health" || path === "/system/settings") return route.fulfill({ json: {} });
          return route.fulfill({ status: 503, json: { detail: "Unavailable in navigation test" } });
        });
        await page.routeWebSocket("**/sessions/ws/sessions/**", () => {});
        const terminalSockets = new Set<WebSocketRoute>();
        await page.routeWebSocket("**/sessions/ws/terminal/**", (socket) => {
          terminalSockets.add(socket);
          socket.onClose(() => terminalSockets.delete(socket));
          socket.send(JSON.stringify({ type: "replay_start" }));
          socket.send(JSON.stringify({ type: "output", seq: 1, data: "Ready\r\n$ " }));
          socket.send(JSON.stringify({ type: "replay_end", seq: 1 }));
        });

        await page.goto("/sessions");
        // This marker disappears on a full document reload.
        await page.evaluate(() => { document.documentElement.dataset.navigationTest = "same-document"; });
        for (let visit = 0; visit < 2; visit++) {
          await page.getByRole("button", { name: "打开会话 " + session.name, exact: true }).click();
          await expect(page).toHaveURL(/\/terminal\/navigation$/);
          await expect(page.locator(".xterm")).toBeVisible();
          await expect(page.getByText("已连接", { exact: true })).toBeVisible();
          await expect(page.getByText(/^网页 \d+ms$/)).toBeVisible();
          await expect(page.getByText("SSH 37ms", { exact: true })).toBeVisible();
          session.name = `Updated session ${visit + 1}`;
          if (back === "arrow") {
            await page.getByRole("button", { name: viewport.width < 768 ? "返回" : "返回会话管理", exact: true }).click();
          } else {
            await page.goBack();
          }
          await expect(page).toHaveURL(/\/sessions$/);
          expect(errors).toEqual([]);
          await expect(page.getByRole("button", { name: "打开会话 " + session.name, exact: true })).toBeVisible();
          await expect(page.locator(".xterm")).toHaveCount(0);
          await expect.poll(() => terminalSockets.size).toBe(0);
          await expect(page.locator("html")).toHaveAttribute("data-navigation-test", "same-document");
          // Terminal-only shortcuts must be released on the workbench.
          expect(await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent("keydown", {
            key: "F2", code: "F2", keyCode: 113, bubbles: true, cancelable: true,
          })))).toBe(true);
          expect(errors).toEqual([]);
        }
      });
    }
  });
}

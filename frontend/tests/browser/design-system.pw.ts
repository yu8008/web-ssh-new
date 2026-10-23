import { expect, test, type BrowserContext } from "@playwright/test";

const now = new Date().toISOString();
const settings = { enhanced_retry_max_attempts: 5, enhanced_retry_schedule_seconds: [2, 4, 8, 16, 32], session_status_refresh_interval_seconds: 3, default_enable_enhanced_session: true, show_session_status_summary: false, clipboard_image_retention_days: 3 };
const connections = [
  { id: 1, name: "Atlas / Production", host: "atlas.internal", port: 22, username: "ops", auth_type: "private_key", remote_probe_status: "verified", remote_arch: "x86_64", remote_os: "Linux", enhanced_supported: true },
  { id: 2, name: "Studio / Development", host: "studio.internal", port: 22, username: "developer", auth_type: "password", remote_probe_status: "verified", remote_arch: "x86_64", remote_os: "Linux", enhanced_supported: true },
  { id: 3, name: "Archive / Storage", host: "archive.internal", port: 22, username: "ops", auth_type: "private_key", remote_probe_status: "verified", remote_arch: "x86_64", remote_os: "Linux", enhanced_supported: true },
];
const sessions = [
  { id: "design", name: "WebSSH / Interface exploration", connection_id: 1, status: "active", host: "atlas.internal", username: "ops", started_at: now, last_activity: now, enhanced_enabled: true, session_order: 0, target_profile: "good", target_avg_rtt_ms: 24 },
  { id: "deploy", name: "Production / Release pipeline", connection_id: 1, status: "active", host: "atlas.internal", username: "ops", started_at: now, last_activity: now, enhanced_enabled: true, session_order: 1, target_profile: "good" },
  { id: "research", name: "Claude / Workspace research", connection_id: 2, status: "disconnected", host: "studio.internal", username: "developer", started_at: now, last_activity: now, enhanced_enabled: true, session_order: 2, target_profile: "good" },
];
const overview = { stats: { cpu: { percent: 12.4, count: 4 }, memory: { used: 1449551462, total: 4294967296, percent: 33.7 }, swap: { total: 0, used: 0, percent: 0 } }, network: { upload_speed: 21504, download_speed: 142336 }, processes: { processes: [{ pid: 1204, name: "codex", cpu_percent: 1.2, memory_bytes: 244318208, memory_percent: 5.6, command: "codex" }] }, disks: { disks: [{ mount: "/", total: 64424509440, used: 12884901888, percent: 20 }] } };

async function harness(context: BrowserContext, theme: string, authenticated = true) {
  await context.addInitScript(({ theme, authenticated }) => {
    if (!localStorage.getItem("theme")) localStorage.setItem("theme", theme);
    localStorage.setItem("app_language", "zh-CN");
    if (authenticated) {
      const payload = btoa(JSON.stringify({ sub: "1", exp: Math.floor(Date.now() / 1000) + 3600 }));
      localStorage.setItem("token", `test.${payload}.signature`); localStorage.setItem("user_id", "1");
    }
  }, { theme, authenticated });
  let saved: unknown = null;
  await context.route("**/*", async route => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    const url = new URL(route.request().url()); const path = url.pathname;
    if (path === "/auth/login") return route.fulfill({ json: { access_token: `test.${btoa(JSON.stringify({ sub: "1", exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`, force_password_change: false } });
    if (path === "/health") return route.fulfill({ json: { status: "ok" } });
    if (path === "/connections") return route.fulfill({ json: connections });
    if (path === "/sessions") return route.fulfill({ json: sessions });
    if (path.startsWith("/sessions/")) return route.fulfill({ json: sessions[0] });
    if (path === "/system/settings") {
      if (route.request().method() === "PUT") saved = route.request().postDataJSON();
      return route.fulfill({ json: { ...settings, ...(saved && typeof saved === "object" ? saved : {}) } });
    }
    if (path.startsWith("/system/clipboard-cache/")) return route.fulfill({ json: { images: [], total_count: 0, total_bytes: 0, expired_count: 0, retention_days: 3, offset: 0, limit: 20 } });
    if (path === "/system/logs") return route.fulfill({ json: { entries: [
      { sequence: 3, timestamp: now, level: "INFO", logger: "gateway.session", request_id: "wsg_48fd", line: "SSH session connected. Persistent workspace is ready." },
      { sequence: 2, timestamp: now, level: "INFO", logger: "gateway.notifications", request_id: "wsg_1b93", line: "Notification stream connected." },
    ], limit: 200, level: null } });
    if (path.startsWith("/system/overview/")) return route.fulfill({ json: overview });
    if (path.startsWith("/system/session-status/")) return route.fulfill({ json: overview });
    if (path.startsWith("/system/clock/")) return route.fulfill({ json: { epoch: Date.now() / 1000, zone: "Etc/UTC", offset: "+0000", zone_name: "UTC" } });
    if (path.startsWith("/system/files/")) return route.fulfill({ json: { path: url.searchParams.get("path") || "/", files: [
      { name: "workspace", path: "/workspace", is_dir: true, size: 4096, modified: now, permissions: "drwxr-xr-x", owner: "ops", group: "ops" },
      { name: "README.md", path: "/README.md", is_dir: false, size: 3456, modified: now, permissions: "-rw-r--r--", owner: "ops", group: "ops" },
    ] } });
    if (path.startsWith("/notifications/setup/")) return route.fulfill({ json: { installed: true, codex_version: "0.163.0", claude_version: "2.1.306", configuration: { codex: "configured", claude: "configured" }, notes: [], runtime: { state: "attached", app: "codex", capabilities: { complete: "verified" }, candidates: [] } } });
    return route.fulfill({ json: {} });
  });
  await context.routeWebSocket("**/notifications/ws", socket => socket.send(JSON.stringify({ type: "snapshot", events: [] })));
  await context.routeWebSocket("**/sessions/ws/sessions/**", () => {});
  await context.routeWebSocket("**/sessions/ws/terminal/**", socket => {
    socket.send(JSON.stringify({ type: "replay_start" }));
    const data = [
      "\x1b[1mCodex / Workspace maintenance\x1b[0m",
      "\x1b[2mops@atlas.internal  /workspace/webssh\x1b[0m",
      "",
      "\x1b[48;5;235m检查当前工作区，并运行相关验证。\x1b[K\x1b[0m",
      "",
      "已检查工作区，正在验证终端配色与任务提醒。",
      "",
      "\x1b[34mRan npm run test\x1b[0m",
      "\x1b[2m  Test Files  11 passed\x1b[0m",
      "\x1b[2m  Tests       108 passed\x1b[0m",
      "",
      "\x1b[32m验证通过\x1b[0m，终端历史和会话连接正常。",
      "",
      "\x1b[2mWorked for 12s\x1b[0m",
      "",
      "\x1b[48;5;236m继续处理工作区中的任务\x1b[K\x1b[0m",
      "\x1b[2mGPT  /  /workspace/webssh\x1b[0m",
    ].join("\r\n");
    socket.send(JSON.stringify({ type: "output", seq: 1, data }));
    socket.send(JSON.stringify({ type: "replay_end", seq: 1 }));
  });
  return { saved: () => saved };
}

for (const mobile of [false, true]) for (const theme of ["dark", "light"]) {
  test(`${mobile ? "mobile" : "desktop"} ${theme}: coherent workspace, settings, logs and terminal files`, async ({ page, context }, info) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const mock = await harness(context, theme);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    for (const [path, selector, name] of [["/sessions", ".workspace-intro", "workspace"], ["/settings", ".page-heading", "settings"], ["/logs", ".page-heading", "logs"], ["/terminal/design", ".xterm", "terminal"]]) {
      await page.goto(path); await expect(page.locator(selector)).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      // Validate readable content and helper text on the actual themed
      // surfaces, rather than just checking that the theme flag changed.
      const colors = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return Object.fromEntries(["--canvas", "--chrome", "--surface", "--elevated", "--ink", "--ink-soft", "--muted", "--brand", "--brand-ink"].map(name =>
          [name, style.getPropertyValue(name).trim().split(/\s+/).map(Number)]));
      });
      const luminance = (color: number[]) => color.map(value => value / 255)
        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const contrast = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
      for (const surface of ["--canvas", "--chrome", "--surface", "--elevated"]) {
        for (const text of ["--ink", "--ink-soft", "--muted", "--brand"]) {
          expect(contrast(colors[surface], colors[text]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(colors["--brand"], colors["--brand-ink"])).toBeGreaterThanOrEqual(4.5);
      if (path === "/terminal/design") {
        await expect(page.locator(".xterm-rows")).toContainText("终端历史和会话连接正常");
        const background = theme === "dark" ? "rgb(33, 33, 33)" : "rgb(255, 255, 255)";
        for (const selector of [".terminal-shell", ".terminal-frame", ".xterm-scrollable-element"]) {
          await expect(page.locator(selector)).toHaveCSS("background-color", background);
        }
      }
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: path !== "/terminal/design", animations: "disabled" });
      if (path === "/sessions") {
        if (mobile) {
          await page.getByRole("button", { name: "搜索", exact: true }).click();
          await page.getByRole("textbox", { name: "搜索", exact: true }).fill("Production");
          await expect(page.getByRole("button", { name: "打开会话 Claude / Workspace research", exact: true })).toHaveCount(0);
          await page.getByRole("button", { name: "清除搜索", exact: true }).click();
          await page.getByRole("button", { name: "搜索", exact: true }).click();
        }
        await expect(page.getByRole("button", { name: "任务提醒与声音", exact: true })).toBeVisible();
        await page.locator(".workspace-intro h1").click(); await page.keyboard.press("/");
        await page.getByRole("textbox", { name: "搜索", exact: true }).fill("research");
        await page.getByRole("button", { name: "查看 2 个在线会话", exact: true }).click();
        await expect(page.getByRole("button", { name: "打开会话 WebSSH / Interface exploration", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "打开会话 Claude / Workspace research", exact: true })).toHaveCount(0);
        await page.getByRole("button", { name: "全部", exact: true }).click();
      }
      if (path === "/settings") {
        await page.getByLabel("粘贴图片自动清理", { exact: true }).selectOption("7");
        await page.getByRole("button", { name: "保存并应用", exact: true }).click();
        await expect.poll(() => mock.saved()).toMatchObject({ clipboard_image_retention_days: 7 });
      }
      if (path === "/terminal/design") {
        await page.getByRole("button", { name: "文件", exact: true }).click();
        await expect(page.getByText("README.md", { exact: true })).toBeVisible();
        await expect(page.locator(".file-workspace .lucide-folder").first()).toBeVisible();
        await page.screenshot({ path: info.outputPath("files.png") });
        if (mobile) await page.getByRole("button", { name: "终端", exact: true }).click();
        else await page.getByRole("button", { name: "关闭文件面板", exact: true }).click();
        await page.getByRole("button", { name: "任务提醒与声音", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "任务提醒与声音" })).toBeVisible();
        await page.screenshot({ path: info.outputPath("notifications.png") });
      }
      expect(await page.locator("svg:not(.lucide)").count()).toBe(0);
    }
    expect(errors).toEqual([]);
  });
  test(`${mobile ? "mobile" : "desktop"} ${theme}: login composition and keyboard authentication`, async ({ page, context }, info) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await harness(context, theme, false);
    await page.goto("/"); await expect(page.getByRole("heading", { name: "进入工作空间" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => page.locator(".auth-art img").evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await page.evaluate(() => [...document.fonts].some(font => font.family.includes("Space Grotesk") && font.status === "loaded"))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("login.png"), fullPage: true, animations: "disabled" });
    await page.getByLabel("密码", { exact: true }).fill("local-fixture-password");
    await page.getByLabel("密码", { exact: true }).press("Enter");
    await expect(page).toHaveURL(/\/sessions$/);
  });
}

test("reduced motion, theme persistence, keyboard navigation and password change presentation", async ({ page, context }) => {
  await harness(context, "light");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/sessions");
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".workspace-intro")).toBeVisible(); await page.locator(".workspace-intro h1").click();
  await page.keyboard.press("/"); await expect(page.getByRole("textbox", { name: "搜索", exact: true })).toBeFocused();
  await page.goto("/force-password"); await expect(page.getByLabel("当前密码", { exact: true })).toBeVisible();
  await expect(page.getByLabel("确认新密码", { exact: true })).toBeVisible();
  expect(await page.locator("svg:not(.lucide)").count()).toBe(0);
});

test("compact and tablet widths keep navigation and search reachable", async ({ page, context }) => {
  await harness(context, "light");
  for (const width of [320, 360, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/sessions"); await expect(page.locator(".workspace-intro")).toBeVisible();
    for (const name of ["切换主题", "系统设置", "系统日志", "任务提醒与声音"]) {
      const button = page.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible(); const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    if (width < 768) {
      await page.getByRole("button", { name: "搜索", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "搜索", exact: true })).toBeFocused();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await page.getByRole("button", { name: "任务提醒与声音", exact: true }).click();
  await page.keyboard.press("/");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
});

test("login artwork responds to the pointer and honors reduced motion", async ({ page, context }) => {
  await harness(context, "dark", false);
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/");
  const art = page.locator(".auth-art"); await expect(art).toBeVisible();
  const box = (await art.boundingBox())!;
  await page.mouse.move(box.x + box.width * .3, box.y + box.height * .4);
  expect(await art.evaluate(element => (element as HTMLElement).style.getPropertyValue("--art-x"))).toBe("");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.mouse.move(box.x + box.width * .32, box.y + box.height * .42);
  await expect.poll(() => art.evaluate(element => (element as HTMLElement).style.getPropertyValue("--art-x"))).not.toBe("");
});

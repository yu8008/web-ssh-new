import { expect, test, type BrowserContext } from "@playwright/test";

const readyGit = {
  state: "ready", root: "/workspace/first", branch: "feature/cli", oid: "abc1234567", remotes: ["origin"],
  branches: ["main", "feature/cli", "origin/main"], upstream: "origin/feature/cli", ahead: 2, behind: 1,
  added_lines: 12, deleted_lines: 4, changed_files: 2, untracked_files: 1, conflicted_files: 0, binary_files: 0,
  files: [{ path: "src/main.ts", status: "MM" }, { path: "old.txt", status: ".D" }, { path: "new.txt", status: "??" }],
};
async function harness(context: BrowserContext) {
  let snapshot: Record<string, unknown> = { state: "ready", cwd: "/workspace/first", app: "codex", git: readyGit };
  let calls = 0, responseStatus = 200;
  const fileCalls: string[] = [];
  const gates = new Map<string, Promise<void>>();
  await context.addInitScript(() => {
    localStorage.setItem("theme", "dark"); localStorage.setItem("app_language", "zh-CN"); localStorage.setItem("user_id", "1");
    localStorage.setItem("token", `test.${btoa(JSON.stringify({ sub: "1", exp: Math.floor(Date.now()/1000)+3600 }))}.sig`);
  });
  await context.route("**/*", async route => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.startsWith("/system/project/")) { calls++; return route.fulfill({ status: responseStatus, json: { ...snapshot, checked_at: Date.now()/1000 } }); }
    if (path.startsWith("/system/files/")) {
      const directory = url.searchParams.get("path") || "/";
      fileCalls.push(directory);
      await gates.get(directory);
      return route.fulfill({ json: { path: directory, files: [
        { name: "src", path: `${directory}/src`, is_dir: true, size: 0 },
        { name: "README.md", path: `${directory}/README.md`, is_dir: false, size: 42 },
        { name: `${directory.split("/").at(-1)}.txt`, path: `${directory}/status.txt`, is_dir: false, size: 9 },
      ] } });
    }
    if (path.startsWith("/system/overview/")) return route.fulfill({ json: {
      stats: { cpu: { count: 4, percent: 8 }, memory: { used: 1073741824, total: 4294967296, percent: 25 }, swap: { used: 0, total: 0, percent: 0 } },
      network: { upload_speed: 2048, download_speed: 4096 }, processes: { processes: [] }, disks: { disks: [{ mount: "/", total: 64424509440, used: 12884901888, percent: 20 }] },
    } });
    if (path.startsWith("/system/clock/")) return route.fulfill({ json: { epoch: Date.now()/1000, zone: "UTC", offset: "+0000", zone_name: "Etc/UTC" } });
    if (path === "/sessions/project") return route.fulfill({ json: { id: "project", name: "CLI workspace", status: "active", enhanced_enabled: true, host: "test", username: "ops", connection_id: 1, started_at: new Date().toISOString() } });
    if (path === "/sessions" || path === "/connections") return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  await context.routeWebSocket("**/notifications/ws", socket => socket.send(JSON.stringify({ type: "snapshot", events: [] })));
  await context.routeWebSocket("**/sessions/ws/sessions/**", () => {});
  const inputs: string[] = [];
  await context.routeWebSocket("**/sessions/ws/terminal/**", socket => {
    socket.onMessage(raw => { const frame = JSON.parse(String(raw)); if (frame.type === "input") inputs.push(frame.data); });
    socket.send(JSON.stringify({ type: "output", seq: 1, data: "ops@host:/wrong-output-path$\r\nCodex is running\r\n" }));
  });
  return { calls: () => calls, inputs, fileCalls,
    hold: (directory: string) => { let release!: () => void; gates.set(directory, new Promise<void>(resolve => { release = resolve; })); return () => { gates.delete(directory); release(); }; },
    set: (value: Record<string, unknown>, status = 200) => { snapshot = value; responseStatus = status; } };
}

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"}: one file list stays inside the CLI directory with only a refresh toolbar`, async ({ page, context }, info) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const mock = await harness(context);
    await page.goto("/terminal/project"); await expect(page.locator(".xterm")).toBeVisible();
    expect(mock.calls()).toBe(0); expect(mock.fileCalls).toEqual([]);
    await page.getByRole("button", { name: "文件", exact: true }).click();
    const panel = page.locator(".file-workspace");
    const input = page.getByRole("textbox", { name: "文件路径", exact: true });
    await expect(input).toHaveValue("/workspace/first");
    await expect(input).toHaveAttribute("readonly", "");
    await expect(panel.getByText("README.md", { exact: true })).toBeVisible();
    await expect(panel.getByRole("tree")).toHaveCount(0);
    await expect(panel.getByRole("table")).toHaveCount(1);
    await expect(panel.getByRole("checkbox")).toHaveCount(0);
    await expect(panel.locator("button")).toHaveCount(1);
    await expect(panel.getByRole("button", { name: "刷新", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: /返回上一级/ })).toHaveCount(0);
    expect(mock.fileCalls).toEqual(["/workspace/first"]);
    await panel.getByRole("row", { name: "src 目录", exact: true }).press("Enter");
    await expect(input).toHaveValue("/workspace/first/src");
    await expect(panel.getByText("README.md", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "返回上一级: /workspace/first", exact: true }).press("Enter");
    await expect(input).toHaveValue("/workspace/first");
    await expect(panel.getByRole("button", { name: /返回上一级/ })).toHaveCount(0);
    mock.set({ state: "ready", cwd: "/workspace/second", app: "claude", git: { ...readyGit, branch: "other" } });
    await panel.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(input).toHaveValue("/workspace/second");
    await expect(panel.getByText("second.txt", { exact: true })).toBeVisible();
    await expect(panel.getByText("first.txt", { exact: true })).toHaveCount(0);
    expect(mock.fileCalls.every(path => path.startsWith("/workspace/first") || path === "/workspace/second")).toBe(true);
    await page.screenshot({ path: info.outputPath("project-files-dark.png") });
    if (mobile) await page.getByRole("button", { name: "终端", exact: true }).click();
    else await page.getByRole("button", { name: "关闭文件面板", exact: true }).click();
    const stopped = mock.calls(); await page.waitForTimeout(2800); expect(mock.calls()).toBe(stopped);
    await page.getByRole("button", { name: mobile ? "浅色" : "切换主题", exact: true }).click();
    await page.getByRole("button", { name: "文件", exact: true }).click();
    await expect(panel.getByText("second.txt", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("project-files-light.png") });
    expect(mock.inputs.every(value => !value.includes("pwd") && !value.includes("git"))).toBe(true);
  });
  test(`${mobile ? "mobile" : "desktop"}: Git follows project changes and distinguishes missing remotes, non-repositories and errors`, async ({ page, context }, info) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const mock = await harness(context);
    await page.goto("/terminal/project"); await expect(page.locator(".xterm")).toBeVisible();
    await page.getByRole("button", { name: mobile ? "Git" : "Git 管理", exact: true }).click();
    const panel = page.getByRole("region", { name: "Git 项目状态", exact: true });
    await expect(panel).toContainText("已配置远端 · origin");
    await expect(panel.locator("summary")).toContainText("feature/cli");
    await expect(panel.locator(".git-change-summary")).toContainText("+12");
    await expect(panel.locator(".git-change-summary")).toContainText("−4");
    await expect(panel).toContainText("另有 1 个未跟踪文件");
    await panel.locator("summary").click(); await expect(panel.getByText("origin/main", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("project-git-dark.png") });
    if (!mobile) await page.getByRole("button", { name: "关闭 Git 面板", exact: true }).click();
    await page.getByRole("button", { name: mobile ? "浅色" : "切换主题", exact: true }).click();
    if (!mobile) {
      await page.getByRole("button", { name: "Git 管理", exact: true }).click();
      await expect(panel.locator("summary")).toContainText("feature/cli");
    }
    await page.screenshot({ path: info.outputPath("project-git-light.png") });
    mock.set({ state: "ready", cwd: "/other/repository", git: { ...readyGit, branch: "second", remotes: [] } });
    await panel.getByRole("button", { name: "刷新 Git 状态", exact: true }).click();
    await expect(panel.locator("summary")).toContainText("second");
    await expect(panel).toContainText("待连接远端"); await expect(panel).toContainText("/other/repository");
    mock.set({ state: "ready", cwd: "/not-a-repository", git: { state: "not_repository" } });
    await panel.getByRole("button", { name: "刷新 Git 状态", exact: true }).click();
    await expect(panel).toContainText("没有可读取的 Git 仓库");
    await expect(panel.locator(".git-change-summary")).toHaveCount(0);
    mock.set({}, 503); await panel.getByRole("button", { name: "刷新 Git 状态", exact: true }).click();
    await expect(panel).toContainText("暂时无法获取终端项目目录");
    await expect(panel).not.toContainText("/not-a-repository");
    expect(await page.locator("svg:not(.lucide)").count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (mobile) await page.getByRole("button", { name: "终端", exact: true }).click();
    else { await page.keyboard.press("Escape"); await expect(panel).toHaveCount(0); }
  });
}

test("Git polling stops while hidden and resumes with fresh metadata", async ({ page, context }) => {
  const mock = await harness(context); await page.goto("/terminal/project");
  await page.getByRole("button", { name: "Git 管理", exact: true }).click();
  await expect(page.locator(".git-panel summary")).toContainText("feature/cli");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  const count = mock.calls(); await page.waitForTimeout(4300); expect(mock.calls()).toBe(count);
  mock.set({ state: "ready", cwd: "/resumed", git: { ...readyGit, branch: "resumed" } });
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.locator(".git-panel summary")).toContainText("resumed");
});


test("directory following pauses during a file operation dialog", async ({ page, context }) => {
  const mock = await harness(context); await page.goto("/terminal/project");
  await page.getByRole("button", { name: "文件", exact: true }).click();
  const input = page.getByRole("textbox", { name: "文件路径", exact: true });
  await expect(input).toHaveValue("/workspace/first");
  await page.getByRole("row", { name: "README.md 文件", exact: true }).click({ button: "right" });
  await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
  await page.getByPlaceholder("输入名称", { exact: true }).fill("draft-folder");
  mock.set({ state: "ready", cwd: "/different-project", git: readyGit });
  await expect(page.locator('.file-workspace span[title="/different-project"]')).toBeVisible({ timeout: 7000 });
  await expect(input).toHaveValue("/workspace/first");
  await expect(page.getByPlaceholder("输入名称", { exact: true })).toHaveValue("draft-folder");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(input).toHaveValue("/different-project");
});

test("pending or unavailable project metadata never opens the system root and refresh recovers", async ({ page, context }) => {
  const mock = await harness(context);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/system/project/project?*", async route => { await gate; await route.fallback(); });
  await page.goto("/terminal/project");
  await page.getByRole("button", { name: "文件", exact: true }).click();
  const panel = page.locator(".file-workspace");
  await expect(panel.getByRole("status")).toHaveText("正在同步终端目录…");
  expect(mock.fileCalls).toEqual([]);
  mock.set({ state: "unavailable" }); release();
  await expect(panel.getByRole("status")).toHaveText("暂时无法同步终端目录，请刷新重试。");
  expect(mock.fileCalls).toEqual([]);
  mock.set({ state: "ready", cwd: "/workspace/first", app: "codex" });
  await panel.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(panel.getByText("README.md", { exact: true })).toBeVisible();
  mock.set({}, 503);
  await panel.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("暂时无法同步终端目录，请刷新重试。");
  await expect(panel.getByText("README.md", { exact: true })).toHaveCount(0);
  expect(mock.fileCalls).not.toContain("/");
});

test("a slow old-project listing cannot overwrite a newly synchronized CLI directory", async ({ page, context }) => {
  const mock = await harness(context);
  const release = mock.hold("/workspace/first");
  await page.goto("/terminal/project");
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await expect.poll(() => mock.fileCalls).toContain("/workspace/first");
  mock.set({ state: "ready", cwd: "/workspace/second", app: "claude" });
  const panel = page.locator(".file-workspace");
  await panel.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(panel.getByText("second.txt", { exact: true })).toBeVisible();
  release();
  await expect(panel.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await expect(panel.getByRole("textbox", { name: "文件路径" })).toHaveValue("/workspace/second");
  await expect(panel.getByText("first.txt", { exact: true })).toHaveCount(0);
  expect(mock.fileCalls).not.toContain("/");
});

test("shell navigation remains available until a CLI scopes the same terminal directory", async ({ page, context }) => {
  const mock = await harness(context);
  mock.set({ state: "ready", cwd: "/workspace/first", app: null });
  await page.goto("/terminal/project");
  await page.getByRole("button", { name: "文件", exact: true }).click();
  const panel = page.locator(".file-workspace");
  const input = panel.getByRole("textbox", { name: "文件路径" });
  await expect(input).toHaveValue("/workspace/first");
  await expect(panel.getByText("README.md", { exact: true })).toBeVisible();
  await input.fill("/manual"); await input.press("Enter");
  await expect(panel.getByText("manual.txt", { exact: true })).toBeVisible();
  mock.set({ state: "ready", cwd: "/workspace/first", app: "codex" });
  await panel.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(input).toHaveValue("/workspace/first");
  await expect(input).toHaveAttribute("readonly", "");
  await expect(panel.getByText("first.txt", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: /返回上一级/ })).toHaveCount(0);
});

import { expect, test, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";
import type { TerminalNotice } from "../../src/notifications/notificationCore";
import type { CliRuntime } from "../../src/notifications/notificationRuntime";

declare global { interface Window { notificationSounds: Array<{ frequency: number; at: number }> } }
const notice = (id: string, kind: TerminalNotice["kind"] = "complete", session = "notify"): TerminalNotice => ({
  id, kind, app: "codex", session_id: session, session_name: "Repository task", created_at: new Date().toISOString(), read_at: null,
});

async function harness(context: BrowserContext, snapshot: TerminalNotice[] = []) {
  await context.addInitScript(() => {
    const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
    localStorage.setItem("token", `test.${payload}.signature`); localStorage.setItem("user_id", "1");
    localStorage.setItem("app_language", "zh-CN");
    window.notificationSounds = [];
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function(when?: number) {
      window.notificationSounds.push({ frequency: this.frequency.value, at: performance.now() });
      return start.call(this, when);
    };
  });
  const sockets = new Set<WebSocketRoute>();
  const items = new Map(snapshot.map(item => [item.id, item]));
  let setupAction = "";
  let runtime: CliRuntime = { state: "observing", app: "codex", capabilities: {}, candidates: [] };
  const session = { id: "notify", name: "Repository task", connection_id: 1, status: "active", host: "test-host", username: "tester", started_at: new Date().toISOString(), last_activity: new Date().toISOString(), enhanced_enabled: true };
  await context.route("**/*", async route => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    const path = new URL(route.request().url()).pathname;
    if (path === "/sessions/notify" || path === "/sessions/other") return route.fulfill({ json: { ...session, id: path.split("/").at(-1) } });
    if (path === "/sessions") return route.fulfill({ json: [session] });
    if (path === "/connections") return route.fulfill({ json: [] });
    if (path.startsWith("/notifications/setup/")) {
      const body = route.request().postDataJSON(); setupAction = body.action;
      if (setupAction === "bind") runtime = { ...runtime, state: "attached", binding: body.binding, capabilities: { complete: "ready" } };
      return route.fulfill({ json: { installed: setupAction !== "uninstall", codex_version: "0.163.0", claude_version: "2.1.306", configuration: { codex: "configured", claude: "configured" }, runtime, notes: [] } });
    }
    if (path.endsWith("/read") && path.startsWith("/notifications/")) {
      const id = path.split("/")[2]; const event = { ...items.get(id)!, read_at: new Date().toISOString() }; items.set(id, event);
      for (const socket of sockets) socket.send(JSON.stringify({ type: "read", id, read_at: event.read_at }));
      return route.fulfill({ json: event });
    }
    if (path === "/health" || path === "/system/settings") return route.fulfill({ json: {} });
    return route.fulfill({ status: 503, json: { detail: "Mocked ancillary endpoint" } });
  });
  await context.routeWebSocket("**/sessions/ws/sessions/**", () => {});
  const terminalInputs: string[] = [];
  await context.routeWebSocket("**/sessions/ws/terminal/**", socket => {
    socket.onMessage(raw => { const item = JSON.parse(String(raw)); if (item.type === "input") terminalInputs.push(item.data); });
    socket.send(JSON.stringify({ type: "replay_start" }));
    socket.send(JSON.stringify({ type: "output", seq: 1, data: Array.from({ length: 120 }, (_, row) => `History row ${row}\r\n`).join("") }));
    socket.send(JSON.stringify({ type: "replay_end", seq: 1 }));
  });
  await context.routeWebSocket("**/notifications/ws", socket => {
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
    socket.send(JSON.stringify({ type: "snapshot", events: [...items.values()] }));
  });
  return {
    sockets, terminalInputs,
    send: (event: TerminalNotice) => { items.set(event.id, event); for (const socket of sockets) socket.send(JSON.stringify({ type: "notification", event })); },
    snapshot: () => { for (const socket of sockets) socket.send(JSON.stringify({ type: "snapshot", events: [...items.values()] })); },
    action: () => setupAction,
    runtime: (value: CliRuntime) => { runtime = value; for (const socket of sockets) socket.send(JSON.stringify({ type: "notification_runtime", session_id: "notify", runtime })); },
  };
}

const starts = (page: Page) => page.evaluate(() => window.notificationSounds.length);
async function activate(page: Page) {
  await page.bringToFront();
  await page.getByRole("button", { name: "任务提醒与声音", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "任务提醒与声音" })).toBeVisible();
  await page.getByRole("button", { name: /^(开启声音并试听|试听并开启声音)$/ }).click();
  await expect(page.getByText(/声音已就绪/)).toBeVisible();
  await page.getByRole("button", { name: "关闭声音设置", exact: true }).click();
}

for (const mobile of [false, true]) test(`${mobile ? "mobile" : "desktop"}: real audio distinguishes completion and attention, preserves terminal focus, and supports mute/setup`, async ({ page, context }, info) => {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const mock = await harness(context);
  await page.goto("/terminal/notify");
  await expect(page.locator(".xterm-rows")).toContainText("History row 119");
  await activate(page);
  const baseline = await starts(page);
  await page.locator(".xterm-helper-textarea").focus();
  const inputsBefore = [...mock.terminalInputs];
  mock.send(notice("finished"));
  await expect.poll(() => starts(page)).toBe(baseline + 1);
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  mock.send(notice("needs-answer", "question"));
  await expect.poll(() => starts(page)).toBe(baseline + 3);
  mock.send(notice("needs-answer", "question")); mock.snapshot();
  await page.waitForTimeout(450);
  expect(await starts(page)).toBe(baseline + 3);
  expect(mock.terminalInputs).toEqual(inputsBefore);
  await page.getByRole("button", { name: "任务提醒与声音", exact: true }).click();
  await page.getByRole("slider", { name: "提示音音量" }).fill("20");
  await page.getByLabel("播放提示音", { exact: true }).uncheck();
  await page.getByRole("button", { name: "接入 CLI 提醒", exact: true }).click();
  await expect.poll(() => mock.action()).toBe("install");
  await expect(page.getByText(/已保存接入记录 · Codex/)).toBeVisible();
  await page.screenshot({ path: info.outputPath("notification-settings.png") });
  await page.getByRole("button", { name: "关闭声音设置", exact: true }).click();
  mock.send(notice("muted-approval", "approval"));
  await expect(page.getByText("等待操作批准", { exact: true })).toBeVisible();
  await page.waitForTimeout(450);
  expect(await starts(page)).toBe(baseline + 3);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("webssh-notification-sound-v1")!).volume)).toBe(.2);
});

test("snapshot, reconnect history, stale notices and terminal replay never replay sounds", async ({ page, context }) => {
  const old = { ...notice("old"), created_at: new Date(Date.now() - 60000).toISOString() };
  const mock = await harness(context, [old]);
  await page.goto("/terminal/notify"); await activate(page);
  const baseline = await starts(page);
  mock.send(old); mock.snapshot(); mock.send({ ...notice("late"), created_at: old.created_at });
  await page.waitForTimeout(500);
  expect(await starts(page)).toBe(baseline);
  for (const socket of mock.sockets) socket.close({ code: 1012, reason: "restart" });
  await expect.poll(() => mock.sockets.size).toBe(1);
  await page.waitForTimeout(400);
  expect(await starts(page)).toBe(baseline);
});

test("two tabs share an atomic sound claim and a burst favors attention", async ({ context }) => {
  const mock = await harness(context);
  const one = await context.newPage(); const two = await context.newPage();
  await one.goto("/terminal/notify"); await activate(one);
  await two.goto("/terminal/notify"); await activate(two);
  const initial = await starts(one) + await starts(two);
  mock.send(notice("batch-complete")); mock.send(notice("batch-question", "question"));
  await expect.poll(async () => await starts(one) + await starts(two)).toBe(initial + 2);
  await one.waitForTimeout(500);
  expect(await starts(one) + await starts(two)).toBe(initial + 2);
  const final = [...await one.evaluate(() => window.notificationSounds), ...await two.evaluate(() => window.notificationSounds)];
  expect(final.filter(item => item.frequency === 880)).toHaveLength(1);
});

test("notifications survive changing sessions and marking one read updates both tabs", async ({ context }) => {
  const mock = await harness(context);
  const one = await context.newPage(); const two = await context.newPage();
  await one.goto("/terminal/notify"); await two.goto("/terminal/other");
  await expect.poll(() => mock.sockets.size).toBe(2);
  mock.send(notice("cross-session", "attention"));
  await expect(two.getByText("需要你处理", { exact: true })).toBeVisible();
  await two.getByText("需要你处理", { exact: true }).click();
  await expect(two).toHaveURL(/\/terminal\/notify$/);
  await one.getByRole("button", { name: "任务提醒与声音", exact: true }).click();
  await expect(one.getByText("最近提醒 (0 未读)", { exact: true })).toBeVisible();
  expect(await starts(one) + await starts(two)).toBe(0);
});

test("background-only sound works while another tab is active and starts promptly", async ({ page, context }, info) => {
  test.skip(info.project.use.headless !== false, "Run this focus test with xvfb-run and --headed; headless Chromium keeps every page foregrounded.");
  const mock = await harness(context);
  await page.goto("/terminal/notify"); await activate(page);
  await page.getByRole("button", { name: "任务提醒与声音", exact: true }).click();
  await page.getByLabel("仅离开当前网页时响铃").check();
  await page.getByRole("button", { name: "关闭声音设置", exact: true }).click();
  const baseline = await starts(page);
  mock.send(notice("foreground-silent")); await page.waitForTimeout(350);
  expect(await starts(page)).toBe(baseline);
  const other = await context.newPage(); await other.bringToFront();
  // Headless Chromium keeps pages visible and emulates focus by default.
  // Disable focus emulation to exercise the browser's actual focus state.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await other.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  const before = await page.evaluate(() => performance.now());
  mock.send(notice("background-answer", "question"));
  await expect.poll(() => starts(page)).toBe(baseline + 2);
  const latency = await page.evaluate(before => window.notificationSounds.at(-1)!.at - before, before);
  expect(latency).toBeLessThan(500);
  await info.attach("browser-event-to-audio-ms", { body: JSON.stringify({ milliseconds: latency, scope: "Local mocked notification socket to real Web Audio start" }), contentType: "application/json" });
});

test("blocked browser audio reports failure without pretending to enable sound", async ({ page, context }) => {
  await harness(context);
  await page.addInitScript(() => {
    Object.defineProperty(window, "AudioContext", { value: class {
      state = "suspended";
      resume() { return Promise.reject(new Error("Blocked by autoplay policy")); }
      close() { return Promise.resolve(); }
    } });
  });
  await page.goto("/terminal/notify");
  await page.getByRole("button", { name: "任务提醒与声音", exact: true }).click();
  await page.getByRole("button", { name: "开启声音并试听", exact: true }).click();
  await expect(page.getByText("浏览器尚未允许播放声音，请检查网站的声音权限后重试。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("播放提示音", { exact: true })).not.toBeChecked();
  expect(await starts(page)).toBe(0);
});

test("running sessions can be bound without terminal input and runtime verification stays separate from configuration", async ({ page, context }) => {
  const mock = await harness(context);
  mock.runtime({ state: "binding_required", app: "codex", cwd: "/project", capabilities: {}, candidates: [{ id: "thread-existing", title: "优化现有终端任务", cwd: "/project", modified_at: Date.now() / 1000 }] });
  await page.goto("/terminal/notify");
  await page.getByRole("button", { name: "任务提醒与声音", exact: true }).click();
  await expect(page.getByText(/配置已验证/)).toBeVisible();
  const status = page.getByLabel("当前 CLI 接入状态");
  await expect(status).toContainText("完成: 待验证");
  await expect(status).toContainText("优化现有终端任务");
  const inputsBefore = [...mock.terminalInputs];
  await page.getByRole("button", { name: "绑定此会话", exact: true }).click();
  await expect(status).toContainText("无需重启 CLI");
  await expect(status).toContainText("已连接，待验证");
  mock.runtime({ state: "attached", app: "codex", capabilities: { complete: "verified", attention: "verified" }, candidates: [] });
  await expect(status).toContainText("完成: 已验证");
  expect(mock.terminalInputs).toEqual(inputsBefore);
  expect(await starts(page)).toBe(0);
});

test("saved volume survives the update and recommended volume is an explicit choice", async ({ page, context }) => {
  await harness(context);
  await page.addInitScript(() => localStorage.setItem("webssh-notification-sound-v1", JSON.stringify({ enabled: false, volume: .35 })));
  await page.goto("/terminal/notify");
  await page.getByRole("button", { name: "任务提醒与声音", exact: true }).click();
  await expect(page.getByRole("slider", { name: "提示音音量" })).toHaveValue("35");
  await page.getByRole("button", { name: "使用推荐音量 60%", exact: true }).click();
  await expect(page.getByRole("slider", { name: "提示音音量" })).toHaveValue("60");
  await expect(page.getByLabel("播放提示音", { exact: true })).not.toBeChecked();
  expect(await starts(page)).toBe(0);
});

test("rendered notification audio has stronger sustained energy, bounded peaks and distinct durations", async ({ page, context }) => {
  await harness(context);
  await page.goto("/terminal/notify");
  const measured = await page.evaluate(async () => {
    // Run the production synthesizer through the browser's actual audio engine.
    const modulePath = "/src/notifications/notificationAudio.ts";
    const { NotificationAudio } = await import(/* @vite-ignore */ modulePath);
    const original = window.AudioContext;
    const results = [];
    try {
      for (const kind of ["complete", "question"]) {
        const offline = new OfflineAudioContext(1, 48000, 48000);
        const facade = { state: "running", currentTime: 0, destination: offline.destination,
          createOscillator: () => offline.createOscillator(), createGain: () => offline.createGain(),
          close: async () => {}, onstatechange: null };
        window.AudioContext = function() { return facade; } as unknown as typeof AudioContext;
        const player = new NotificationAudio();
        await player.enable(); player.play(kind, .6);
        const samples = (await offline.startRendering()).getChannelData(0);
        let peak = 0; let last = 0; let energy = 0;
        for (let index = 0; index < samples.length; index++) {
          const value = samples[index]; peak = Math.max(peak, Math.abs(value));
          if (Math.abs(value) > .0002) last = index / 48000;
          if (index >= 960 && index < 4800) energy += value * value;
        }
        results.push({ kind, peak, end: last, rms: Math.sqrt(energy / 3840) });
        player.dispose();
      }
    } finally { window.AudioContext = original; }
    return results;
  });
  for (const result of measured) {
    expect(result.peak).toBeGreaterThan(.23); expect(result.peak).toBeLessThan(.25);
    expect(result.rms).toBeGreaterThan(.16);
  }
  expect(measured[0].end).toBeGreaterThan(.45); expect(measured[0].end).toBeLessThan(.51);
  expect(measured[1].end).toBeGreaterThan(.70); expect(measured[1].end).toBeLessThan(.76);
});

import { expect, test, type Page } from "@playwright/test";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=", "base64");

async function gateway(page: Page, count = 2) {
  let retention = 3;
  let images = Array.from({ length: count }, (_, index) => ({
    id: `image${index}.png`, path: `/tmp/webssh-clipboard.image${index}/image.png`, size: PNG.length,
    created_at: new Date(Date.now() - (index === 0 ? 4 : 1) * 86400000).toISOString(),
  }));
  const settings = {
    enhanced_retry_max_attempts: 5, enhanced_retry_schedule_seconds: [2, 4, 8, 16, 32],
    session_status_refresh_interval_seconds: 3, default_enable_enhanced_session: false, show_session_status_summary: true,
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
    localStorage.setItem("token", `test.${payload}.signature`);
    localStorage.setItem("user_id", "1");
    localStorage.setItem("app_language", "zh-CN");
  });
  await page.routeWebSocket("**/sessions/ws/sessions/**", () => {});
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.resourceType() !== "fetch") return route.continue();
    const url = new URL(request.url());
    if (url.pathname === "/system/settings") {
      if (request.method() === "PUT") retention = request.postDataJSON().clipboard_image_retention_days;
      return route.fulfill({ json: { ...settings, clipboard_image_retention_days: retention } });
    }
    if (url.pathname === "/connections") return route.fulfill({ json: [1, 2].map((id) => ({ id, name: id === 1 ? "图片服务器" : "离线服务器", username: "tester", host: `host-${id}`, port: 22 })) });
    if (url.pathname.startsWith("/system/clipboard-cache/2")) return route.fulfill({ status: 502, json: { detail: "Could not read clipboard image cache; check the SSH connection" } });
    if (url.pathname === "/system/clipboard-cache/1/cleanup") {
      const before = images.length;
      images = images.filter((image) => Date.parse(image.created_at) + retention * 86400000 > Date.now());
      return route.fulfill({ json: { deleted: before - images.length, freed_bytes: (before - images.length) * PNG.length } });
    }
    if (url.pathname === "/system/clipboard-cache/1") {
      if (request.method() === "DELETE") {
        const ids: string[] = request.postDataJSON().image_ids;
        images = images.filter((image) => !ids.includes(image.id));
        return route.fulfill({ json: { deleted_ids: ids } });
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const items = images.map((image) => ({ ...image, expires_at: new Date(Date.parse(image.created_at) + retention * 86400000).toISOString(), expired: Date.parse(image.created_at) + retention * 86400000 <= Date.now() }));
      return route.fulfill({ json: { images: items.slice(offset, offset + 20), total_count: items.length, total_bytes: items.length * PNG.length, expired_count: items.filter((image) => image.expired).length, retention_days: retention, offset, limit: 20 } });
    }
    if (url.pathname.startsWith("/system/clipboard-cache/1/image/")) return route.fulfill({ body: PNG, contentType: "image/png" });
    if (url.pathname === "/sessions") return route.fulfill({ json: [] });
    if (url.pathname === "/health") return route.fulfill({ json: {} });
    return route.fulfill({ status: 503, json: { detail: "Unexpected request in cache test" } });
  });
  return { errors };
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(viewport.width < 768 ? "mobile image cache" : "desktop image cache", () => {
    test.use({ viewport });
    test("saves retention, previews images, cleans expired files and confirms deletion", async ({ page }, testInfo) => {
      const { errors } = await gateway(page);
      await page.goto("/settings");
      await expect(page.getByText(/共 2 张.*已过期 1 张/)).toBeVisible();
      const retention = page.getByLabel("粘贴图片自动清理", { exact: true });
      await expect(retention).toHaveValue("3");
      await retention.selectOption("7");
      await page.getByRole("button", { name: "保存并应用", exact: true }).click();
      await expect(page.getByText(/共 2 张.*已过期 0 张/)).toBeVisible();
      await expect(page.getByRole("button", { name: "清理过期图片", exact: true })).toBeDisabled();
      await page.reload();
      await expect(retention).toHaveValue("7");
      await retention.selectOption("3");
      await page.getByRole("button", { name: "保存并应用", exact: true }).click();
      await expect(page.getByText(/共 2 张.*已过期 1 张/)).toBeVisible();
      await page.getByRole("button", { name: "预览", exact: true }).last().click();
      await expect(page.getByAltText("缓存图片预览", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "下载图片", exact: true })).toHaveAttribute("href", /^blob:/);
      await page.screenshot({ path: testInfo.outputPath("image-cache.png"), fullPage: true });
      await page.getByRole("button", { name: "清理过期图片", exact: true }).click();
      await expect(page.getByText(/共 1 张.*已过期 0 张/)).toBeVisible();
      await page.getByRole("button", { name: "删除 image1.png", exact: true }).click();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await expect(page.getByText("image1.png", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "删除 image1.png", exact: true }).click();
      await page.getByRole("button", { name: "删除图片", exact: true }).click();
      await expect(page.getByText("暂无粘贴图片缓存", { exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    });
  });
}

test("an offline connection shows an error and switching back recovers", async ({ page }) => {
  const { errors } = await gateway(page);
  await page.goto("/settings");
  await expect(page.getByText(/共 2 张/)).toBeVisible();
  await page.getByLabel("SSH 连接", { exact: true }).selectOption("2");
  await expect(page.getByRole("alert")).toHaveText("无法读取图片缓存，请检查 SSH 连接");
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.getByLabel("SSH 连接", { exact: true }).selectOption("1");
  await expect(page.getByText(/共 2 张/)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("deleting the last item on the last page returns to a valid page", async ({ page }) => {
  await gateway(page, 21);
  await page.goto("/settings");
  await expect(page.getByText(/共 21 张/)).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("button", { name: "删除 image20.png", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "删除 image20.png", exact: true }).click();
  await page.getByRole("button", { name: "删除图片", exact: true }).click();
  await expect(page.getByText(/共 20 张/)).toBeVisible();
  await expect(page.getByRole("button", { name: "删除 image0.png", exact: true })).toBeVisible();
});

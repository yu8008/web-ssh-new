import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.pw.ts",
  use: { baseURL: "http://127.0.0.1:5187", headless: true },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5187 --strictPort",
    url: "http://127.0.0.1:5187",
  },
});

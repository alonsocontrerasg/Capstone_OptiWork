import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e", testMatch: "**/*.spec.mjs", workers: 1,
  timeout: 90000, expect: { timeout: 15000 }, retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://127.0.0.1:3000", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "mobile-chromium", use: { ...devices["Pixel 7"], browserName: "chromium" } }],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1", url: "http://127.0.0.1:3000/login",
    reuseExistingServer: !process.env.CI, timeout: 120000,
  },
});

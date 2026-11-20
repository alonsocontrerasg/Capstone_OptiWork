import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/performance", workers: 1, retries: 0, timeout: 90000,
  outputDir: "test-results/rendimiento",
  reporter: [["list"], ["html", { outputFolder: "playwright-report/rendimiento", open: "never" }]],
  use: { ...devices["Pixel 7"], baseURL: "http://localhost:3000", browserName: "chromium" },
  webServer: {
    command: "npm run start -- --hostname localhost", url: "http://localhost:3000/login",
    reuseExistingServer: false, timeout: 120000,
  },
});

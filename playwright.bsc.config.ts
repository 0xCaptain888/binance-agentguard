import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser", timeout: 45000, workers: 1,
  use: { baseURL: "http://127.0.0.1:43189", headless: true, trace: "retain-on-failure",
    ...(process.env.BSC_PLAYWRIGHT_CHANNEL ? { channel: process.env.BSC_PLAYWRIGHT_CHANNEL } : {}) },
  webServer: { command: "npm run bsc:serve", url: "http://127.0.0.1:43189/healthz", env: { PORT: "43189" }, timeout: 60000, reuseExistingServer: false },
  reporter: "list"
});

import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser", timeout: 45000, workers: 1,
  use: { baseURL: "http://127.0.0.1:43189", headless: true, trace: "retain-on-failure" },
  webServer: { command: "npm run bsc:serve", port: 43189, env: { PORT: "43189" }, timeout: 60000, reuseExistingServer: false },
  reporter: "list"
});

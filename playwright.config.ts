import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/tests",
  timeout: 30000,
  retries: 0,
  maxFailures: undefined,
  workers: 1,
  reporter: [["github"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "sh -c \"vite build --config e2e/app/vite.config.ts && vite preview --config e2e/app/vite.config.ts --host 127.0.0.1 --port 4173 --strictPort\"",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 120000,
  },
});

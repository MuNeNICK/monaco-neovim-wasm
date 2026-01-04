import { defineConfig, devices } from "@playwright/test";

const isCI = !!process.env.CI;
const port = Number(process.env.E2E_PORT ?? "4173");
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  retries: 0,
  maxFailures: isCI ? 1 : undefined,
  workers: 1,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
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
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
      command: `sh -c "vite build --config e2e/app/vite.config.ts && vite preview --config e2e/app/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort"`,
      url: baseURL,
      reuseExistingServer: false,
    },
});

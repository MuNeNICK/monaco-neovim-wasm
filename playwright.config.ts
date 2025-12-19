import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? "4173");
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
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
      // CI: build once + preview for deterministic startup (avoids on-demand dev bundling delays).
      command: process.env.CI
        ? `sh -c "vite build --config e2e/app/vite.config.ts && vite preview --config e2e/app/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort"`
        : `vite --config e2e/app/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
    },
});

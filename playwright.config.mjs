import { defineConfig } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT || 5179);

export default defineConfig({
  testDir: "./scripts",
  testMatch: "**/*.e2e.mjs",
  workers: 2,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    colorScheme: "light",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 360, height: 844 }, isMobile: true, hasTouch: true } }
  ],
  webServer: {
    command: "node scripts/dev-server.mjs",
    url: `http://127.0.0.1:${port}/readyz`,
    env: { HTTP_HOST: "127.0.0.1", HTTP_PORT: String(port) }
  }
});

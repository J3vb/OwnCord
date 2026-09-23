import { defineConfig, devices } from "@playwright/test";
import { PREVIEW_ORIGIN, PREVIEW_PORT } from "./tests/e2e/support/server";

export default defineConfig({
  outputDir: "test-results/fullstack",
  testDir: "./tests/e2e/fullstack",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  failOnFlakyTests: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  globalTimeout: 20 * 60 * 1000,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/fullstack" }],
    ["junit", { outputFile: "test-results/fullstack.xml" }],
  ],
  use: {
    baseURL: PREVIEW_ORIGIN,
    // This suite drives the browser LiveKit path (Windows' WebView2). Chromium
    // on a Linux runner would otherwise report Linux and take the native
    // backend (isLinuxDesktop), which only exists in the Tauri app.
    userAgent: devices["Desktop Chrome"].userAgent,
    permissions: ["microphone", "camera"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --port ${PREVIEW_PORT} --strictPort`,
    url: PREVIEW_ORIGIN,
    reuseExistingServer: false,
  },
});

import { defineConfig } from "@playwright/test";

/**
 * Playwright config for testing against the REAL Tauri production app.
 *
 * Connects to the WebView2 window via Chrome DevTools Protocol (CDP).
 * The custom fixture in tests/e2e/native-fixture.ts launches the Tauri
 * exe with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port
 * and connects Playwright to it via chromium.connectOverCDP().
 *
 * Requirements:
 * - Built Tauri exe:  npm run tauri build
 * - Running server:   Server/chatserver.exe (or set OWNCORD_SERVER_URL)
 *
 * Usage:  npm run test:e2e:native
 */
export default defineConfig({
  testDir: "./tests/e2e/native",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  // Native tests are slower (real app startup) — run sequentially
  fullyParallel: false,
  workers: 1,
  retries: 2,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["junit", { outputFile: "test-results/native-junit.xml" }]]
    : "html",

  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "on-first-retry",
  },

  // No webServer — we launch the Tauri app ourselves in the fixture.
  // No projects — we connect directly to WebView2 via CDP, not via browser launch.
});

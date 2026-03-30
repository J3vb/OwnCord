import { defineConfig } from "@playwright/test";

/**
 * Playwright config for testing against the REAL Tauri production app.
 *
 * Connects to the WebView2 window via Chrome DevTools Protocol (CDP).
 *
 * Two projects:
 *
 * 1. `native-no-auth` — Tests that do NOT need login (smoke tests,
 *    connect page UI, auth flow verification). Each test gets a fresh
 *    Tauri exe via the original per-test fixture.
 *
 * 2. `native-authenticated` — Tests that need a logged-in session
 *    (channel nav, chat ops, settings, voice, overlays, app layout).
 *    Uses the persistent fixture: one Tauri exe for the entire project,
 *    login happens once, all tests reuse the same page.
 *
 * This design eliminates server rate limiting (5 logins/min, 10-failure
 * lockout) that previously caused test failures when 8+ spec files each
 * launched a fresh exe and logged in.
 *
 * Requirements:
 * - Built Tauri exe:  npm run tauri build
 * - Running server:   Server/chatserver.exe (or set OWNCORD_SERVER_URL)
 *
 * Usage:  npm run test:e2e:native
 */
export default defineConfig({
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  // Native tests run sequentially — one app instance at a time
  fullyParallel: false,
  workers: 1,
  retries: 2,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["junit", { outputFile: "test-results/native-junit.xml" }]]
    : "html",

  use: {
    actionTimeout: 30_000,
    navigationTimeout: 45_000,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "on-first-retry",
  },

  projects: [
    {
      name: "native-no-auth",
      testDir: "./tests/e2e/native",
      testMatch: ["smoke.spec.ts", "auth-flow.spec.ts"],
    },
    {
      name: "native-authenticated",
      testDir: "./tests/e2e/native",
      testMatch: [
        "app-layout.spec.ts",
        "channel-navigation.spec.ts",
        "chat-operations.spec.ts",
        "settings-overlay.spec.ts",
        "voice-controls.spec.ts",
        "overlays.spec.ts",
      ],
      dependencies: ["native-no-auth"],
    },
  ],
});

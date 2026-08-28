import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the ADMIN PANEL e2e suite — the server-embedded SPA
 * (Server/admin/static/index.html), driven against a REAL server started by
 * tests/e2e/admin/start-server.sh (fresh temp data dir, TLS off, loopback).
 *
 * Unlike the mocked-Tauri web suite this exercises the true stack: chi
 * router, admin middleware/gates, SQLite, and the SPA itself. The journey is
 * stateful by design (first-run wizard creates the owner the later tests log
 * in as), so it runs serially in one worker against one server instance.
 *
 * Usage:  npm run test:e2e:admin   (requires the Go toolchain)
 */
const PORT = process.env.OWNCORD_ADMIN_E2E_PORT ?? "18446";

export default defineConfig({
  testDir: "./tests/e2e/admin",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 1,
  reporter: process.env.CI
    ? [
        ["html", { open: "never" }],
        ["junit", { outputFile: "test-results/admin-junit.xml" }],
      ]
    : "html",

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    contextOptions: { reducedMotion: "reduce" },
  },

  webServer: {
    command: "bash tests/e2e/admin/start-server.sh",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    // First run compiles the Go server; CI cold caches need the headroom.
    timeout: 240_000,
  },
});

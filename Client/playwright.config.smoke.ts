import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/**
 * Playwright config for the DEVELOPMENT-server smoke run.
 *
 * Usage:  npm run test:e2e:smoke
 *
 * Why this exists. Two jobs ran the same 292 mocked tests — one against the
 * Vite dev server, one against the production bundle — for 10.8 and 8.8 minutes.
 * The 292 duplicated everything: `playwright.config.prod.ts` inherits `testDir`
 * and `testIgnore` from the base config, so the two jobs differ only in which
 * server serves the app. The production run is the authoritative one (it is the
 * bundle Tauri ships) and stays complete; this one is fast feedback, so it runs
 * the journeys that would catch a broken build early.
 *
 * This is a `testMatch` list rather than a tag, because a tag has to be added to
 * every spec it covers and this file is the one place the selection is
 * reviewable. Adding a spec here is a one-line change; the full development run
 * is still available as `npm run test:e2e`, and CI widens to it automatically
 * when the e2e specs or fixtures themselves change (the `harness` capability in
 * scripts/ci-select.mjs).
 *
 * The three `*.parity.spec.ts` files are included deliberately: they are the
 * specs written for dev-versus-production differences, which is exactly what a
 * dev-server run can catch that the production run cannot.
 */
export default defineConfig({
  ...base,
  outputDir: "test-results/smoke",
  reporter: process.env.CI
    ? [
        ["html", { open: "never", outputFolder: "playwright-report/smoke" }],
        ["junit", { outputFile: "test-results/smoke-junit.xml" }],
      ]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report/smoke" }]],
  testMatch: [
    // Boot and identity: nothing else can pass if these break.
    "connect-page.spec.ts",
    "register-flow.spec.ts",
    "logout-flow.spec.ts",
    // The shell and the main surfaces.
    "main-layout.spec.ts",
    "channel-switch-messages.spec.ts",
    "message-list.spec.ts",
    "message-send-flow.spec.ts",
    "dm-system.spec.ts",
    // The two cross-cutting behaviours a dev server most often breaks.
    "reconnection.spec.ts",
    "theme-persistence.spec.ts",
    "a11y-smoke.spec.ts",
    // Dev-versus-production differences, by construction.
    "emoji-voicemod.parity.spec.ts",
    "gating-badges.parity.spec.ts",
    "social.parity.spec.ts",
  ],
});

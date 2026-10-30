import { defineConfig } from "@playwright/test";
import { clientRoot, fromClientRoot } from "./clientRoot";
import base from "../../../playwright.config";

/**
 * Playwright config for the DEVELOPMENT-server smoke run.
 *
 * Usage:  npm run test:e2e:smoke
 *
 * Why this exists. Two jobs ran the same mocked tests — one against the
 * Vite dev server, one against the production bundle — for 10.8 and 8.8 minutes.
 * The run duplicated everything: `playwright.config.prod.ts` inherits `testDir`
 * and `testIgnore` from the base config, so the two jobs differ only in which
 * server serves the app. The production run is the authoritative one (it is the
 * bundle Tauri ships) and stays complete; this one is fast feedback, so it runs
 * the journeys that would catch a broken build early.
 *
 * This is a `testMatch` list rather than a tag, because a tag has to be added to
 * every spec it covers and this file is the one place the selection is
 * reviewable. Adding a spec here is a one-line change; the full development run
 * is still available as `npm run test:e2e`, but CI runs only this smoke set
 * against the dev server. The full suite runs in `client-e2e-parity` against the
 * production bundle.
 *
 * The three `*.parity.spec.ts` files are included deliberately: they are the
 * specs written for dev-versus-production differences, which is exactly what a
 * dev-server run can catch that the production run cannot.
 */
if (base.webServer === undefined || Array.isArray(base.webServer)) {
  throw new Error("playwright.config.ts must declare exactly one webServer");
}

export default defineConfig({
  ...base,
  // The base config's relative paths resolve against Client/; from this folder
  // they would not, so the ones this run inherits are pinned to Client/.
  testDir: fromClientRoot("tests/e2e"),
  globalTeardown: fromClientRoot("tests/e2e/global-teardown.ts"),
  webServer: { ...base.webServer, cwd: clientRoot },
  outputDir: fromClientRoot("test-results/smoke"),
  reporter: process.env.CI
    ? [
        ["html", { open: "never", outputFolder: fromClientRoot("playwright-report/smoke") }],
        ["junit", { outputFile: fromClientRoot("test-results/smoke-junit.xml") }],
      ]
    : [
        ["list"],
        ["html", { open: "never", outputFolder: fromClientRoot("playwright-report/smoke") }],
      ],
  testMatch: [
    // Boot and identity: nothing else can pass if these break.
    "connect-page.spec.ts",
    "register-flow.spec.ts",
    "recovery-flow.spec.ts",
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
    // The B9 accessibility specs that reach the dev server's module graph (the
    // catalog text seam, the voice grid, the logger) and therefore always skip
    // in the production run. They only ever execute here, so leaving them off
    // this list made "16 skipped" a permanent blind spot for silent a11y rot.
    "text-expansion.spec.ts",
    "voice-polish.spec.ts",
    "zoom-reflow.spec.ts",
    // The same holds for these media specs (they reach the voice and stream
    // modules), so they too run only here.
    "reconnect-media-notice.spec.ts",
    "stream-mini-player.spec.ts",
    "stream-popout.spec.ts",
    // Dev-versus-production differences, by construction.
    "emoji-voicemod.parity.spec.ts",
    "gating-badges.parity.spec.ts",
    "social.parity.spec.ts",
  ],
});

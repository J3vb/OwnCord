import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/**
 * Playwright config for testing against the PRODUCTION build.
 * Uses `vite preview` to serve the built dist/ folder — the same
 * HTML/CSS/JS that Tauri bundles into the exe.
 *
 * Usage:  npm run test:e2e:prod
 *
 * Inherits testDir/testIgnore/timeouts/workers/projects from the base config;
 * only the output location, the report paths, the preview port and the server
 * command differ.
 */
export default defineConfig({
  ...base,
  outputDir: "test-results/prod",
  // Cleared, not merely absent: the base config's CI fail-fast, its
  // self-terminate timeout and its globalTeardown all belong to the dev-server
  // run. The teardown in particular kills the listener the base config started,
  // which is not the `vite preview` server spawned below.
  maxFailures: undefined,
  globalTimeout: undefined,
  globalTeardown: undefined,
  reporter: process.env.CI
    ? [
        ["html", { open: "never", outputFolder: "playwright-report/prod" }],
        ["junit", { outputFile: "test-results/prod-junit.xml" }],
      ]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report/prod" }]],

  use: {
    ...base.use,
    baseURL: "http://localhost:4173",
  },

  webServer: {
    // Spawn Vite directly rather than through npm — see the note in
    // playwright.config.ts: an `npm run` wrapper leaves vite alive as an
    // orphaned grandchild on teardown and the runner never exits.
    command: "node node_modules/vite/bin/vite.js preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

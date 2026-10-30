import { defineConfig } from "@playwright/test";
import { fromClientRoot } from "./clientRoot";
import { quarantineGrepInvert } from "../../../scripts/check-quarantine.mjs";

export default defineConfig({
  outputDir: fromClientRoot("test-results/admin"),
  testDir: fromClientRoot("tests/e2e/admin"),
  // Known flakes tracked in tests/e2e/quarantine.json are excluded from the
  // required run; `OWNCORD_FLAKES=1` runs them again. Policy and guard:
  // docs/testing-behavior.md, scripts/check-quarantine.mjs.
  grepInvert: quarantineGrepInvert(),
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  failOnFlakyTests: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  globalTimeout: 10 * 60 * 1000,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: fromClientRoot("playwright-report/admin") }],
    ["junit", { outputFile: fromClientRoot("test-results/admin-junit.xml") }],
  ],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    contextOptions: { reducedMotion: "reduce" },
  },
  // The test-scoped fixture owns a fresh server/database for each retry.
});

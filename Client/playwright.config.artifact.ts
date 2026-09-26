import { defineConfig } from "@playwright/test";

/** B7-17: installed release artifacts (not test builds) on all four targets.
 * Driven by .github/workflows/client-artifact-smoke.yml, which downloads the
 * artifact into OWNCORD_ARTIFACT_DIR first. `artifact-journey` runs on every
 * call; `artifact-update` needs signed artifacts and runs at release time only.
 * CI only — the specs install software and wipe the production app profile.
 */
export default defineConfig({
  testDir: "./tests/e2e/artifact-smoke",
  outputDir: "test-results/artifact",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  // One installed app and one fixed debugging port at a time.
  fullyParallel: false,
  workers: 1,
  // A retry would hide a flaky install or boot, which is what this proves.
  retries: 0,
  forbidOnly: !!process.env.CI,
  globalTimeout: 40 * 60 * 1000,
  reporter: process.env.CI
    ? [
        ["list"],
        ["html", { open: "never", outputFolder: "playwright-report/artifact" }],
        ["junit", { outputFile: "test-results/artifact-junit.xml" }],
      ]
    : "list",
  use: { actionTimeout: 30_000, navigationTimeout: 45_000, trace: "off", video: "off" },
  projects: [
    { name: "artifact-journey", testMatch: ["journey.spec.ts"] },
    { name: "artifact-update", testMatch: ["update.spec.ts"] },
  ],
});

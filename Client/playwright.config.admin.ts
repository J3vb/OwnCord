import { defineConfig } from "@playwright/test";

export default defineConfig({
  outputDir: "test-results/admin",
  testDir: "./tests/e2e/admin",
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
    ["html", { open: "never", outputFolder: "playwright-report/admin" }],
    ["junit", { outputFile: "test-results/admin-junit.xml" }],
  ],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    contextOptions: { reducedMotion: "reduce" },
  },
  // The test-scoped fixture owns a fresh server/database for each retry.
});

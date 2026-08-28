import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: ["**/native/**", "**/admin/**"],
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  // CI fail-fast: a systemic breakage (e.g. the shared login helper) makes
  // most of the 255 tests burn their full timeout × retries — hours of runner
  // time at 1 worker. Abort after 20 failures instead so the job reports a
  // usable red quickly. 0 = unlimited (local runs see every failure).
  maxFailures: process.env.CI ? 20 : 0,
  // Self-terminate before the workflow's timeout-minutes (25) SIGKILLs the
  // runner, so the HTML/JUnit report still gets written and uploaded.
  globalTimeout: process.env.CI ? 20 * 60 * 1000 : 0,
  reporter: process.env.CI
    ? [
        ["html", { open: "never" }],
        ["junit", { outputFile: "test-results/junit.xml" }],
      ]
    : "html",

  use: {
    baseURL: "http://localhost:1420",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "on-first-retry",
    contextOptions: { reducedMotion: "reduce" },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Kills the dev server the runner cannot kill itself; without it the suite
  // passes and then hangs forever. See tests/e2e/global-teardown.ts.
  globalTeardown: "./tests/e2e/global-teardown.ts",

  webServer: {
    // Run Vite's entry point directly so the listening process IS Playwright's
    // child — globalTeardown kills the listener, which only releases the
    // runner's ChildProcess handle if that listener is the child itself. Going
    // through `npm run dev` would leave the npm process holding it open.
    command: "node node_modules/vite/bin/vite.js",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

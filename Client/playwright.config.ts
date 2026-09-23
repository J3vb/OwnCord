import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  outputDir: "test-results/mock",
  testDir: "./tests/e2e",
  testIgnore: ["**/native/**", "**/admin/**", "**/fullstack/**", "**/artifact-smoke/**"],
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  // Two workers on CI. The mocked suites are isolated by construction — each
  // test builds its own Tauri mock and the specs share no server or database —
  // and a GitHub runner has 4 vCPUs, so a second worker buys wall-clock rather
  // than contention. The production run measured 8.8 minutes at 1 worker.
  //
  // The real-server configs (admin, fullstack) and the native config keep
  // workers: 1 of their own — they boot a Go server and a LiveKit process and
  // are not isolated from each other. Only this base config, inherited by the
  // dev, smoke and prod runs, is widened.
  //
  // failOnFlakyTests stays on, so two workers cannot hide a race behind a
  // retry: a spec that needs its retry still fails the run.
  workers: process.env.CI ? 2 : undefined,
  // CI fail-fast: a systemic breakage (e.g. the shared login helper) makes
  // most of the 292 tests burn their full timeout × retries — hours of runner
  // time. Abort after 20 failures instead so the job reports a
  // usable red quickly. 0 = unlimited (local runs see every failure).
  maxFailures: process.env.CI ? 20 : 0,
  // Self-terminate before the workflow's timeout-minutes (25) SIGKILLs the
  // runner, so the HTML/JUnit report still gets written and uploaded.
  globalTimeout: process.env.CI ? 20 * 60 * 1000 : 0,
  reporter: process.env.CI
    ? [
        ["html", { open: "never", outputFolder: "playwright-report/mock" }],
        ["junit", { outputFile: "test-results/mock-junit.xml" }],
      ]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report/mock" }]],

  use: {
    baseURL: "http://localhost:1420",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
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
    // --config is explicit because a bare `vite` resolves the SHARED config,
    // which since the B7-6 split no longer carries the desktop settings.
    command: "node node_modules/vite/bin/vite.js --config vite.config.desktop.ts",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

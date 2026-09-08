import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for testing against the PRODUCTION build.
 * Uses `vite preview` to serve the built dist/ folder — the same
 * HTML/CSS/JS that Tauri bundles into the exe.
 *
 * Usage:  npm run test:e2e:prod
 */
export default defineConfig({
  outputDir: "test-results/prod",
  testDir: "./tests/e2e",
  testIgnore: ["**/native/**", "**/admin/**", "**/fullstack/**"],
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [
        ["html", { open: "never", outputFolder: "playwright-report/prod" }],
        ["junit", { outputFile: "test-results/prod-junit.xml" }],
      ]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report/prod" }]],

  use: {
    baseURL: "http://localhost:4173",
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

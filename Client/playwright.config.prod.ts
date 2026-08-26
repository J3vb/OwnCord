import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for testing against the PRODUCTION build.
 * Uses `vite preview` to serve the built dist/ folder — the same
 * HTML/CSS/JS that Tauri bundles into the exe.
 *
 * Usage:  npm run test:e2e:prod
 */
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
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["junit", { outputFile: "test-results/junit.xml" }]]
    : "html",

  use: {
    baseURL: "http://localhost:4173",
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

  webServer: {
    // Spawn Vite directly rather than through npm — see the note in
    // playwright.config.ts: an `npm run` wrapper leaves vite alive as an
    // orphaned grandchild on teardown and the runner never exits.
    command: "npx vite preview",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

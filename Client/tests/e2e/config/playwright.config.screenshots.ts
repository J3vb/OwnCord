import { defineConfig, devices } from "@playwright/test";
import { clientRoot, fromClientRoot } from "./clientRoot";

// Retakes the README images in .github/images/ from a real server seeded with
// demo data. Run by hand before a release (`npm run screenshots:readme`); it is
// not a test suite and CI does not run it.
export default defineConfig({
  outputDir: fromClientRoot("test-results/screenshots"),
  testDir: fromClientRoot("tests/e2e/screenshots"),
  timeout: 360_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    userAgent: devices["Desktop Chrome"].userAgent,
    colorScheme: "dark",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    contextOptions: { reducedMotion: "reduce" },
    ...(process.env.OWNCORD_SCREENSHOTS_CHROMIUM
      ? { launchOptions: { executablePath: process.env.OWNCORD_SCREENSHOTS_CHROMIUM } }
      : {}),
  },
  webServer: {
    cwd: clientRoot,
    command: "node node_modules/vite/bin/vite.js preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: false,
  },
});

import { defineConfig, devices } from "@playwright/test";
import { clientRoot, fromClientRoot } from "./clientRoot";
import { quarantineGrepInvert } from "../../../scripts/check-quarantine.mjs";

export default defineConfig({
  outputDir: fromClientRoot("test-results/fullstack"),
  testDir: fromClientRoot("tests/e2e/fullstack"),
  // Known flakes tracked in tests/e2e/quarantine.json are excluded from the
  // required run; `OWNCORD_FLAKES=1` runs them again. Policy and guard:
  // docs/testing-behavior.md, scripts/check-quarantine.mjs.
  grepInvert: quarantineGrepInvert(),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  failOnFlakyTests: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // A clean run takes about 18 minutes on CI; the soak's one retry adds about
  // 3, which a 20-minute ceiling could not hold. ci.yml's job timeout sits
  // above this so the reporters still write.
  globalTimeout: 26 * 60 * 1000,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: fromClientRoot("playwright-report/fullstack") }],
    ["junit", { outputFile: fromClientRoot("test-results/fullstack.xml") }],
  ],
  use: {
    baseURL: "http://localhost:4173",
    // This suite drives the browser LiveKit path (Windows' WebView2). Chromium
    // on a Linux runner would otherwise report Linux and take the native
    // backend (isLinuxDesktop), which only exists in the Tauri app.
    userAgent: devices["Desktop Chrome"].userAgent,
    permissions: ["microphone", "camera"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        // V8 drops compiled code it has not run lately, a few hundred KB at a
        // time, and the soak's heap bar reads that as growth or shrinkage.
        // Keeping code resident leaves app data as the only thing it measures.
        "--js-flags=--no-flush-bytecode --no-flush-baseline-code",
      ],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    cwd: clientRoot,
    command: "node node_modules/vite/bin/vite.js preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: false,
  },
});

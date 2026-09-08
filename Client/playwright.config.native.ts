import { defineConfig } from "@playwright/test";

/** Built Windows WebView2 app, isolated credentials/profile and local Go server.
 * `native-core` is the required CI journey. Legacy exploratory suites remain
 * available through the other projects. Binaries are built in CI only.
 */
export default defineConfig({
  outputDir: "test-results/native",
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  // Native tests run sequentially — one app instance at a time
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  failOnFlakyTests: !!process.env.CI,
  globalTimeout: 25 * 60 * 1000,
  reporter: process.env.CI
    ? [
        ["html", { open: "never", outputFolder: "playwright-report/native" }],
        ["junit", { outputFile: "test-results/native-junit.xml" }],
      ]
    : "html",

  use: {
    actionTimeout: 30_000,
    navigationTimeout: 45_000,
    screenshot: "only-on-failure",
    // CDP context lifecycle and traces are owned explicitly by native-app.ts.
    trace: "off",
    video: "off",
  },

  projects: [
    {
      name: "native-updater",
      testDir: "./tests/e2e/native",
      testMatch: ["packaged-update.spec.ts"],
    },
    {
      name: "native-core",
      testDir: "./tests/e2e/native",
      testMatch: ["reconnection.spec.ts", "voice-controls.spec.ts"],
    },
    {
      name: "native-no-auth",
      testDir: "./tests/e2e/native",
      testMatch: ["smoke.spec.ts", "auth-flow.spec.ts"],
    },
    {
      name: "native-authenticated",
      testDir: "./tests/e2e/native",
      testMatch: [
        "app-layout.spec.ts",
        "channel-navigation.spec.ts",
        "chat-operations.spec.ts",
        "dm-system.spec.ts",
        "settings-overlay.spec.ts",
        "theme-persistence.spec.ts",
        "overlays.spec.ts",
      ],
      dependencies: ["native-no-auth"],
    },
  ],
});

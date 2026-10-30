import { defineConfig } from "@playwright/test";
import { fromClientRoot } from "./clientRoot";
import { quarantineGrepInvert } from "../../../scripts/check-quarantine.mjs";

// The browser portal suite (WP 6.13g1): a real Go server with
// `server.browser_client_enabled: true` serves the web bundle at its own
// origin, and the specs drive that page. No Tauri mock, no Vite server, no
// webServer entry here: each test's fixture starts, seeds and stops its own
// server (tests/e2e/web/fixtures.ts, over tests/e2e/support/server.ts) and
// points baseURL at it. The server speaks its self-signed TLS, so the browser
// context ignores certificate errors.
//
// `npm run test:e2e:web` first builds the server WITH the bundle embedded
// (tests/e2e/scripts/build-server.mjs --web). A binary built any other way
// carries only the placeholder and the suite's first test fails with a 404.
export default defineConfig({
  outputDir: fromClientRoot("test-results/web"),
  testDir: fromClientRoot("tests/e2e/web"),
  // Known flakes tracked in tests/e2e/quarantine.json are excluded from the
  // required run; `OWNCORD_FLAKES=1` runs them again. Policy and guard:
  // docs/testing-behavior.md, scripts/check-quarantine.mjs.
  grepInvert: quarantineGrepInvert(),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  failOnFlakyTests: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  globalTimeout: 12 * 60 * 1000,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: fromClientRoot("playwright-report/web") }],
    ["junit", { outputFile: fromClientRoot("test-results/web-junit.xml") }],
  ],
  use: {
    ignoreHTTPSErrors: true,
    permissions: ["microphone", "camera"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    contextOptions: { reducedMotion: "reduce" },
  },
});

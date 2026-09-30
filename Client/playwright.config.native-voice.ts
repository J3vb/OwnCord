// Native-voice interop: the Linux Rust backend (examples/native_voice_interop)
// against livekit-client in Chromium, over a local livekit-server, with
// E2EE on. No OwnCord server and no app bundle: the page is a bare
// livekit-client peer, the way a Windows client encrypts. Run by ci.yml's
// rust-tests job after the crate is built; locally see Client/CLAUDE.md.
import { defineConfig, devices } from "@playwright/test";
import { quarantineGrepInvert } from "./scripts/check-quarantine.mjs";

export default defineConfig({
  outputDir: "test-results/native-voice",
  testDir: "./tests/e2e/native-voice",
  // Known flakes tracked in tests/e2e/quarantine.json are excluded from the
  // required run; `OWNCORD_FLAKES=1` runs them again. Policy and guard:
  // docs/testing-behavior.md, scripts/check-quarantine.mjs.
  grepInvert: quarantineGrepInvert(),
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // A retry hides a flaky interop run, which is exactly what this proof must
  // not do: the same gate the other configs carry, so a run that needs its
  // retry still turns the job red.
  failOnFlakyTests: !!process.env.CI,
  reporter: [["list"], ["junit", { outputFile: "test-results/native-voice.xml" }]],
  use: {
    ...devices["Desktop Chrome"],
    permissions: ["microphone", "camera"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
    trace: "retain-on-failure",
  },
});

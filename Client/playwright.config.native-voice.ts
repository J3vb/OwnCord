// Native-voice interop: the Linux Rust backend (examples/native_voice_interop)
// against livekit-client in Chromium, over a local livekit-server, with
// E2EE on. No OwnCord server and no app bundle: the page is a bare
// livekit-client peer, the way a Windows client encrypts. Run by ci.yml's
// rust-tests job after the crate is built; locally see Client/CLAUDE.md.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  outputDir: "test-results/native-voice",
  testDir: "./tests/e2e/native-voice",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["junit", { outputFile: "test-results/native-voice.xml" }]],
  use: {
    ...devices["Desktop Chrome"],
    permissions: ["microphone"],
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

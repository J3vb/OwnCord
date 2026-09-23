import { defineConfig } from "@playwright/test";
import fullstack from "./playwright.config.fullstack";

// B7-11: the long-session soak's long run (`npm run test:e2e:soak`): the same
// spec the PR soak runs, with enough cycles and an idle-connected phase. 200
// cycles is the plan's floor: at the measured ~6.5 s per cycle, 300 cycles plus
// the 30-minute idle phase would not fit the 60 minutes the run is sized to.
process.env.OWNCORD_SOAK_CYCLES ??= "200";
process.env.OWNCORD_SOAK_IDLE_MIN ??= "30";

export default defineConfig({
  ...fullstack,
  outputDir: "test-results/soak",
  testMatch: /long-session\.spec\.ts/,
  // One attempt: a retry would double an hour-long run, and a failure is a
  // finding to read, not to retry past.
  retries: 0,
  globalTimeout: 90 * 60 * 1000,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/soak" }],
    ["junit", { outputFile: "test-results/soak.xml" }],
  ],
});

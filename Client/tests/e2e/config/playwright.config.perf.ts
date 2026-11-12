import { defineConfig } from "@playwright/test";
import { fromClientRoot } from "./clientRoot";
import fullstack from "./playwright.config.fullstack";

// The opt-in performance baselines (`npm run test:e2e:stream-perf`,
// `npm run test:e2e:chat-perf`): the fullstack setup, running only the
// *-performance.measure.ts files, whose names keep them out of the regular
// fullstack run. Results: test-results/perf/*.jsonl, read by
// scripts/analyze-perf.mjs.
export default defineConfig({
  ...fullstack,
  outputDir: fromClientRoot("test-results/perf-runs"),
  testMatch: /-performance\.measure\.ts/,
  // A retry would append a second run's rows; a failed run is rerun by hand.
  retries: 0,
  globalTimeout: 60 * 60 * 1000,
  // A Chromium other than Playwright's own (a GPU machine's Chrome, or a
  // cloud box whose pinned browser is missing) is named by path.
  use: {
    ...fullstack.use,
    trace: "off",
    launchOptions: {
      ...fullstack.use?.launchOptions,
      ...(process.env.OWNCORD_PERF_CHROMIUM
        ? { executablePath: process.env.OWNCORD_PERF_CHROMIUM }
        : {}),
    },
  },
  reporter: [["list"]],
});

import { defineConfig } from "@playwright/test";
import { fromClientRoot } from "./clientRoot";
import fullstack from "./playwright.config.fullstack";

// The media cost measurement (`npm run test:e2e:media-cost`): the fullstack
// setup, running only tests/e2e/fullstack/media-cost.measure.ts, whose name
// keeps it out of the regular fullstack run.
export default defineConfig({
  ...fullstack,
  outputDir: fromClientRoot("test-results/media-cost"),
  testMatch: /media-cost\.measure\.ts/,
  // A retry would append a second set of rows; a failed run is rerun by hand.
  retries: 0,
  globalTimeout: 30 * 60 * 1000,
  use: { ...fullstack.use, trace: "off" },
  reporter: [["list"]],
});

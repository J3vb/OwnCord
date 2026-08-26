// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: "vitest",
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  vitest: {
    configFile: "vitest.config.ts",
  },
  mutate: [
    "src/lib/**/*.ts",
    "src/stores/**/*.ts",
    "!src/lib/types.ts",
    "!src/**/*.d.ts",
  ],
  reporters: ["html", "clear-text", "progress"],
  htmlReporter: {
    fileName: "reports/mutation/index.html",
  },
  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },
  concurrency: 4,
  timeoutMS: 30000,
  tempDirName: ".stryker-tmp",
};

export default config;

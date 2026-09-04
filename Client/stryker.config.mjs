// @ts-check

// Stryker's vitest runner hard-codes `pool: 'threads'`
// (@stryker-mutator/vitest-runner, #getVitestPoolConfig), overriding the
// `pool: "forks"` that vitest.config.ts pins. A worker thread cannot honor a
// `process.env.TZ` pin, so the TZ-pinned regression blocks would abort the
// run — tests/helpers/tz-pin.ts throws by design rather than skipping in
// silence. This is the single sanctioned opt-out: those blocks are skipped
// here, and nowhere else. Set in the config module so Stryker's child
// processes inherit it.
process.env.OC_ALLOW_UNPINNED_TZ = "1";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: "vitest",
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  vitest: {
    configFile: "vitest.config.ts",
  },
  mutate: ["src/lib/**/*.ts", "src/stores/**/*.ts", "!src/lib/types.ts", "!src/**/*.d.ts"],
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

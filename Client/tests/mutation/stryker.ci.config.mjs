import base from "../../stryker.config.mjs";
// A measured target: 54 killed, 31 compile errors, zero survivors (2026-09-08).
export default {
  ...base,
  mutate: ["src/stores/permissions.ts"],
  // Only the tests that import permissions.ts, and a type-check program rooted
  // at it: the full suite and the full project made this step take ~11 min.
  vitest: { configFile: "tests/mutation/vitest.permissions.config.mjs" },
  tsconfigFile: "tsconfig.mutation-permissions.json",
  thresholds: { high: 100, low: 95, break: 90 },
  ignorePatterns: [
    "tests/e2e/.bin/**",
    "test-results/**",
    "playwright-report/**",
    "dist/**",
    "reports/**",
  ],
};

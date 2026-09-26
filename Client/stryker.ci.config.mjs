import base from "./stryker.config.mjs";
// A measured target: 54 killed, 31 compile errors, zero survivors (2026-09-08).
export default {
  ...base,
  mutate: ["src/lib/permissions.ts"],
  thresholds: { high: 100, low: 95, break: 90 },
  ignorePatterns: [
    "tests/e2e/.bin/**",
    "test-results/**",
    "playwright-report/**",
    "dist/**",
    "reports/**",
  ],
};

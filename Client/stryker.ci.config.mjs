// @ts-check
// Forwards to tests/mutation/stryker.ci.config.mjs. The scheduled nightly runs
// main's copy of nightly-test-depth.yml against dev, and that copy still names
// this path. Delete this file once main carries the workflow that names the
// new path (the next release).
export * from "./tests/mutation/stryker.ci.config.mjs";
export { default } from "./tests/mutation/stryker.ci.config.mjs";

// Forwards to scripts/ci/fuzz-ci.mjs. The scheduled nightly runs main's copy of
// nightly-test-depth.yml against dev, and that copy still names this path.
// Delete this file once main carries the workflow that names the new path (the
// next release).
import "./ci/fuzz-ci.mjs";

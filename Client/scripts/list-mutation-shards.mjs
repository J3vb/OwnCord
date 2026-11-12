#!/usr/bin/env node
// Prints the shard names from tests/mutation/stryker.shard.config.mjs as a
// GitHub Actions output line (names=["livekit-1",...]). The nightly workflow
// builds its mutation matrix from it, so the config alone decides how many
// shards run.
import { join } from "node:path";

const clientDir = new URL("..", import.meta.url).pathname;
process.env.STRYKER_SHARD ||= "livekit-1"; // satisfy the config's own validation on import
const { shards } = await import(join(clientDir, "tests/mutation/stryker.shard.config.mjs"));
const names = Object.keys(shards);
if (names.length === 0) {
  console.error("the shard config lists no shards");
  process.exit(1);
}
process.stdout.write(`names=${JSON.stringify(names)}\n`);

#!/usr/bin/env node
// Proves the union of the mutation shards equals the base config's configured
// surface, so no file silently drops out of the nightly baseline (B7-8 Task 3).
import { globSync } from "node:fs";
import { join } from "node:path";

const clientDir = new URL("..", import.meta.url).pathname;
process.env.STRYKER_SHARD ||= "livekit"; // satisfy the config's own validation on import
const { shards } = await import(join(clientDir, "stryker.shard.config.mjs"));
const base = (await import(join(clientDir, "stryker.config.mjs"))).default;

const globs = base.mutate;
const positive = globs.filter((g) => !g.startsWith("!"));
const negative = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));

const excluded = (p) => negative.some((g) => p === g);
const expected = new Set();
for (const g of positive) {
  for (const p of globSync(g, { cwd: clientDir })) {
    if (!excluded(p)) expected.add(p);
  }
}

const sharded = new Set(Object.values(shards).flat());
const missing = [...expected].filter((p) => !sharded.has(p)).sort();
const extra = [...sharded].filter((p) => !expected.has(p)).sort();

if (missing.length || extra.length) {
  if (missing.length)
    console.error(`missing from every shard (${missing.length}):\n  ${missing.join("\n  ")}`);
  if (extra.length)
    console.error(`in a shard but outside the surface (${extra.length}):\n  ${extra.join("\n  ")}`);
  process.exit(1);
}

console.log(`shard union equals the configured surface: ${expected.size} files`);

#!/usr/bin/env node
// Fail when the Linux desktop-artifact smoke points the sound server's
// default source at a PulseAudio monitor.
//
//   node scripts/check-artifact-smoke-audio.mjs
//   node --test scripts/check-artifact-smoke-audio.test.mjs
//
// Why this exists: that smoke drives the INSTALLED app through a real voice
// join on a runner with no sound card, so it provisions a PulseAudio null sink
// and once used the sink's monitor as the source. The app's native capture
// deliberately leaves monitor sources out — `<sink>.monitor` is a loopback of
// what the sink plays, not a microphone (`is_monitor` in
// Client/src-tauri/src/native_voice/capture.rs) — so the capture found no input
// device, the app joined listen-only, and the widget's Mute control is inert in
// that state by design. The journey's mute assertion could then never pass.
//
// A runner that wants a usable microphone must default to a source that is not
// a monitor: remap the monitor with `module-remap-source` (or load a virtual
// source) and set that default. This asserts the smoke workflow does.
//
// Deliberately text-level, not YAML-parsed, the same tradeoff
// scripts/check-release-environment.mjs documents: no YAML parser among the
// root devDependencies, and this is a presence check, not full semantics.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The workflow that installs and drives the Linux artifacts.
const TARGET_WORKFLOW = ".github/workflows/client-artifact-smoke-target.yml";

// Every `pactl set-default-source <name>` in `src`, as {line, source, monitor}.
export function defaultSources(src) {
  const found = [];
  src.split("\n").forEach((line, i) => {
    const m = line.match(/pactl\s+set-default-source\s+(\S+)/);
    if (m) found.push({ line: i + 1, source: m[1], monitor: m[1].endsWith(".monitor") });
  });
  return found;
}

// What is wrong with `src`'s default source(s), if anything: none at all
// (a runner with no configured source cannot open a capture either), or one
// whose source is a monitor the native capture filters out.
export function auditAudioSource(src) {
  const defaults = defaultSources(src);
  if (defaults.length === 0) return [{ kind: "missing", line: 0 }];
  return defaults
    .filter((d) => d.monitor)
    .map(({ line, source }) => ({ kind: "monitor", line, source }));
}

function main() {
  const src = readFileSync(join(ROOT, TARGET_WORKFLOW), "utf8");
  const failures = auditAudioSource(src);

  if (failures.length) {
    console.error(`\n${failures.length} audio-source problem(s) in ${TARGET_WORKFLOW}:\n`);
    for (const f of failures) {
      console.error(
        f.kind === "missing"
          ? `  no \`pactl set-default-source\` — the Linux smoke leaves the capture with no source`
          : `  line ${f.line}: set-default-source ${f.source} is a monitor`,
      );
    }
    console.error(
      "\nPoint the default source at a real capture device. The native capture " +
        "filters `<sink>.monitor` sources (is_monitor, " +
        "Client/src-tauri/src/native_voice/capture.rs), so a monitor-only runner " +
        "joins voice listen-only and its mute control is inert. Load a non-monitor " +
        "source (module-remap-source / module-virtual-source) and default to it.",
    );
    process.exit(1);
  }
  console.log("artifact-smoke audio: the Linux smoke defaults to a non-monitor capture source");
}

// Only main() reads the file; the audit is exported for the unit suite, so this
// guard keeps `node --test` from running main on import.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();

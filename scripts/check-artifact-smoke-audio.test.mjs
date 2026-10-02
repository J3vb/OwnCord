import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { auditAudioSource, defaultSources } from "./check-artifact-smoke-audio.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_WORKFLOW = join(ROOT, ".github/workflows/client-artifact-smoke-target.yml");

const lines = (...xs) => xs.join("\n");

test("a monitor default source is reported", () => {
  const src = lines(
    "          pulseaudio --start --exit-idle-time=-1",
    "          pactl load-module module-null-sink sink_name=smoke",
    "          pactl set-default-source smoke.monitor",
  );
  assert.deepEqual(auditAudioSource(src), [{ kind: "monitor", line: 3, source: "smoke.monitor" }]);
});

test("a non-monitor default source passes", () => {
  const src = lines(
    "pactl load-module module-remap-source master=smoke.monitor source_name=smoke_mic",
    "pactl set-default-source smoke_mic",
  );
  assert.deepEqual(auditAudioSource(src), []);
});

test("a missing default source is reported", () => {
  const src = "pactl load-module module-null-sink sink_name=smoke";
  assert.deepEqual(auditAudioSource(src), [{ kind: "missing", line: 0 }]);
});

test("every set-default-source is captured, monitor or not", () => {
  const src = "pactl set-default-source a\npactl set-default-source b.monitor\n";
  assert.equal(defaultSources(src).length, 2);
});

// The live file is the real fixture: the Linux artifact smoke must give the
// installed app a capture device the native backend does not filter out, or
// it joins listen-only and its mute assertion can never pass.
test("the artifact-smoke target defaults to a non-monitor source", () => {
  assert.deepEqual(auditAudioSource(readFileSync(TARGET_WORKFLOW, "utf8")), []);
});

// Timing for the payload check on frames far larger than any fixture. Off by
// default so the normal run stays fast; run it with
//   WIRE_BENCH=1 npx vitest run tests/contract/wire-check.bench.test.ts
// The synthetic frames are typed against the real payload types, so a type
// change that makes them stale fails the type check rather than skewing the
// numbers. Medians of 20 runs after a warm-up are written to stdout.

import { describe, expect, it } from "vitest";
import { checkFrame } from "../../src/lib/net/wireCheck";
import type { ReadyChannel, ReadyMember, ReadyVoiceState } from "../../src/lib/wireCommon";
import type { ChatMessagePayload, DmChannelPayload, ReadyPayload } from "../../src/lib/wireServer";
import { FIXTURES, substitute } from "../helpers/protocolFixtures";

const ENABLED = process.env["WIRE_BENCH"] === "1";
const RUNS = 20;
const WARMUP = 5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function timeMs(work: () => void): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

function bench(work: () => void): number {
  for (let i = 0; i < WARMUP; i++) work();
  return median(Array.from({ length: RUNS }, () => timeMs(work)));
}

/** A ready frame from the fixtures, to take channel and role samples from. */
function fixtureReady(): ReadyPayload {
  for (const t of FIXTURES.values()) {
    for (const frames of Object.values(t.connections)) {
      const f = frames.find((x) => x.dir === "s2c" && x.frame.type === "ready");
      if (f !== undefined) return substitute(f.frame.payload, {}, { n: 0 }) as ReadyPayload;
    }
  }
  throw new Error("no ready frame in the fixtures");
}

function syntheticReady(): ReadyPayload {
  const base = fixtureReady();
  const textChannel = { ...(base.channels[0] as ReadyChannel) };
  const voiceChannel = { ...(base.channels[1] as ReadyChannel) };
  const members: ReadyMember[] = Array.from({ length: 5000 }, (_, i) => ({
    id: i + 1,
    username: `user${i}`,
    display_name: `User Number ${i}`,
    avatar: `https://example.invalid/avatars/${i}.png`,
    role: "member",
    role_ids: [4, 5],
    status: i % 3 === 0 ? "online" : "offline",
    about: "A short profile text for the benchmark.",
    custom_status: "benchmarking",
    created_at: "2026-09-05 12:00:00",
    identity_public_key: "YWxpY2UtaWRlbnRpdHktcHVibGljLWtleS1maXh0dXJl",
  }));
  const channels: ReadyChannel[] = Array.from({ length: 500 }, (_, i) => ({
    ...(i % 5 === 0 ? voiceChannel : textChannel),
    id: i + 1,
    name: `channel-${i}`,
    position: i,
  }));
  const dm_channels: DmChannelPayload[] = Array.from({ length: 200 }, (_, i) => ({
    channel_id: 10_000 + i,
    recipient: { id: i + 1, username: `user${i}`, avatar: "", status: "online" },
    last_message_id: i,
    last_message: "see you tomorrow",
    last_message_at: "2026-09-05 12:00:00",
    unread_count: i % 4,
  }));
  const voice_states: ReadyVoiceState[] = Array.from({ length: 300 }, (_, i) => ({
    channel_id: 1 + (i % 100) * 5,
    user_id: i + 1,
    muted: i % 2 === 0,
    deafened: false,
    camera: i % 7 === 0,
  }));
  return { ...base, members, channels, dm_channels, voice_states };
}

function chatMessage(i: number): ChatMessagePayload {
  return {
    id: i,
    channel_id: 1,
    user: { id: 7, username: "alice", display_name: "Alice", avatar: "" },
    content: `message number ${i} with some text in it`,
    reply_to: null,
    attachments: [],
    timestamp: "2026-09-05 12:00:00",
    mentions: [],
    mention_roles: [],
    mentions_everyone: false,
    mentions_here: false,
    referenced_message: null,
  };
}

describe.skipIf(!ENABLED)("payload check timing", () => {
  it("times a large ready and a chat_message burst", { timeout: 120_000 }, () => {
    const ready = syntheticReady();
    const text = JSON.stringify(ready);
    expect(checkFrame("ready", ready)).toBeNull();

    const parse = bench(() => {
      JSON.parse(text);
    });
    const readyCheck = bench(() => {
      checkFrame("ready", ready);
    });

    const burst = Array.from({ length: 1000 }, (_, i) => chatMessage(i));
    for (const m of burst) expect(checkFrame("chat_message", m)).toBeNull();
    const burstCheck = bench(() => {
      for (const m of burst) checkFrame("chat_message", m);
    });

    const line = (label: string, ms: number): string => `${label.padEnd(44)} ${ms.toFixed(3)} ms`;
    process.stdout.write(
      `${[
        `ready: ${(text.length / 1e6).toFixed(2)} MB, 5000 members, 500 channels, 200 DMs, 300 voice states`,
        line("JSON.parse of the ready text (median of 20)", parse),
        line("checkFrame(ready) (median of 20)", readyCheck),
        line("checkFrame x 1000 chat_message (median of 20)", burstCheck),
      ].join("\n")}\n`,
    );
  });
});

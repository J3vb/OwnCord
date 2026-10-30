// N-1 COMPATIBILITY, TOLERANT HALF (ARCH-027). Not part of the normal client
// suite: the `.compat.ts` suffix is outside vitest.config.ts's include globs
// (`tests/**/*.test.ts`, `src/**/*.test.ts`) on purpose. scripts/ci/protocol-n1-compat.mjs
// copies this file into the PREVIOUS release's checkout as
// Client/tests/contract/n1-new-frames.test.ts and runs it there, so every import
// below resolves against the OLD client's dispatcher and stores.
//
// It replays the fixtures that are new since that release, through the old
// dispatcher, and asserts one thing: nothing throws. An old client may not know
// a new frame type, a new field, or a new journey, and may log about it; that is
// fine. What it must never do is crash on it. Content assertions belong to the
// strict half (the old release's own contract test).
//
// Only APIs present in the old tree may be used here: wireDispatcher,
// createMockWsClient, and the same vi.mock list as the old contract test.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@lib/notifications", () => ({
  notifyIncomingMessage: vi.fn(),
  notifyMention: vi.fn(),
  notifyChannelActivity: vi.fn(),
  cleanupNotificationAudio: vi.fn(),
}));
vi.mock("@lib/voice/livekitSession", () => ({
  handleVoiceToken: vi.fn(async () => {}),
  handleParticipantLeft: vi.fn(async () => {}),
  handleE2EEAnnounce: vi.fn(async () => {}),
  handleE2EEOffer: vi.fn(async () => {}),
  leaveVoice: vi.fn(),
  cleanupAll: vi.fn(),
  isVoiceSessionActive: vi.fn(() => false),
  isAutoReconnecting: vi.fn(() => false),
  failPendingRejoin: vi.fn(),
  setMuted: vi.fn(),
  setDeafened: vi.fn(),
  disableCamera: vi.fn(async () => {}),
  disableScreenshare: vi.fn(async () => {}),
}));
vi.mock("@lib/ui/toast", () => ({ showToast: vi.fn() }));
vi.mock("@lib/net/identity", () => ({ ensureIdentityKeyPublished: vi.fn(async () => true) }));
vi.mock("@lib/voice/screenShare", () => ({ rollbackPendingVideo: vi.fn(() => undefined) }));

import { wireDispatcher } from "../../src/lib/dispatcher";
import { createMockWsClient } from "../helpers/mock-ws";
import type { WsClient } from "../../src/lib/ws";
import type { ServerMessage } from "../../src/lib/types";

interface WireFrame {
  readonly dir: "c2s" | "s2c";
  readonly frame: { readonly type: string; readonly payload?: unknown; readonly id?: string };
}
interface WireTranscript {
  readonly connections: Record<string, readonly WireFrame[]>;
}

const DIR = process.env["N1_NEW_FIXTURE_DIR"];
if (DIR === undefined || DIR === "") {
  throw new Error(
    "N1_NEW_FIXTURE_DIR is not set; run this through scripts/ci/protocol-n1-compat.mjs",
  );
}
const FIXTURE_DIR: string = DIR;
const FILES = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

const PLACEHOLDER = /^<(\w+):(\w+)>$/;

/** Replace each typed placeholder with a concrete value of the same type. */
function substitute(value: unknown, counter: { n: number }): unknown {
  if (typeof value === "string") {
    const m = PLACEHOLDER.exec(value);
    if (m === null) return value;
    const [klass, type] = [m[1], m[2]];
    counter.n += 1;
    const n = counter.n;
    switch (type) {
      case "null":
        return null;
      case "number":
        return klass === "id" ? 1000 + n : n;
      case "bool":
        return true;
      case "string":
        if (klass === "ts") return "2026-09-05 12:00:00";
        if (klass === "id") return `req-${n}`;
        return `${klass}-${n}`;
      default:
        return value;
    }
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, counter));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, counter);
    return out;
  }
  return value;
}

describe("n-1 compat: fixtures new since the previous release, through its dispatcher", () => {
  let cleanup: (() => void) | null = null;
  let ws: ReturnType<typeof createMockWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    // An old client may log about frames it does not know. Silence it all.
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    ws = createMockWsClient();
    cleanup = wireDispatcher(ws as unknown as WsClient);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("found at least one new fixture", () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  for (const file of FILES) {
    it(`${file}: no handler throws`, async () => {
      const tr = JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), "utf8")) as WireTranscript;
      for (const frames of Object.values(tr.connections)) {
        const counter = { n: 0 };
        for (const f of frames) {
          if (f.dir !== "s2c") continue;
          const envelope = substitute({ id: f.frame.id }, counter) as { id?: string };
          ws.simulateMessage(
            f.frame.type as ServerMessage["type"],
            substitute(f.frame.payload, counter) as never,
            envelope.id,
          );
          // Handlers lazily import mocked modules without awaiting; let each
          // frame's imports settle before the next, as the strict half does.
          await vi.dynamicImportSettled();
        }
      }
      // Reaching here means every simulateMessage returned. A rejected promise
      // inside a handler surfaces as an unhandled error, which vitest fails on.
      await vi.dynamicImportSettled();
    });
  }
});

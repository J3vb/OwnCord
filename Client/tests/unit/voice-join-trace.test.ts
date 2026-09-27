/**
 * SRE-M2 (client half): the voice-join timeline.
 *
 * A failed join used to leave only `{hasRoom:false}`, with no stage to place
 * the failure at. These tests pin the four things the diagnostics bundle now
 * carries: the failure stage, the URL kind, the retry count, and the phase and
 * milestone timings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abandonJoinAttempt,
  advanceJoinStage,
  beginJoinAttempt,
  classifyJoinUrl,
  countJoinRetry,
  failJoinAttempt,
  finishJoinAttempt,
  markFirstRemoteTrackSubscribed,
  markJoinMilestone,
  markLocalTrackPublished,
  recordDecryptError,
  recordSelfTestStage,
  resetSelfTest,
  setJoinUrlKind,
  voiceJoinSnapshot,
} from "@lib/voiceJoinTrace";
import { addLogListener, setLogLevel, type LogEntry } from "@lib/logger";
import { expectConsole } from "../helpers/console";

const T0 = 1_000_000;

/** Advance the mocked wall clock without running any timers. */
function at(ms: number): void {
  vi.setSystemTime(T0 + ms);
}

function newestJoin() {
  return voiceJoinSnapshot().lastJoins[0];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("classifyJoinUrl", () => {
  it("marks the server's direct_url as direct", () => {
    expect(classifyJoinUrl("ws://127.0.0.1:7880", "ws://127.0.0.1:7880", "/livekit")).toBe(
      "direct",
    );
  });

  it("marks the local TLS tunnel result as tunnel", () => {
    expect(classifyJoinUrl("ws://127.0.0.1:7881/livekit", undefined, "/livekit")).toBe("tunnel");
  });

  it("marks an unchanged proxy path as passthrough", () => {
    expect(classifyJoinUrl("/livekit", undefined, "/livekit")).toBe("passthrough");
  });

  it("is unknown for anything else", () => {
    expect(classifyJoinUrl("wss://livekit.example/rtc", undefined, "/livekit")).toBe("unknown");
  });
});

describe("voice join attempt", () => {
  it("records a resolve failure at stage resolve with the direct_url kind", () => {
    const id = beginJoinAttempt(7);
    setJoinUrlKind(id, "direct");
    failJoinAttempt(id);

    expectConsole("warn", /voice join timeline/);
    expect(newestJoin()).toMatchObject({
      channelId: 7,
      succeeded: false,
      stage: "resolve",
      urlKind: "direct",
      retries: 0,
    });
  });

  it("records a key-exchange failure at stage keyExchange", () => {
    const id = beginJoinAttempt(1);
    setJoinUrlKind(id, "tunnel");
    at(40);
    advanceJoinStage(id, "keyExchange");
    failJoinAttempt(id);

    expectConsole("warn", /voice join timeline/);
    expect(newestJoin()).toMatchObject({
      succeeded: false,
      stage: "keyExchange",
      urlKind: "tunnel",
    });
    expect(newestJoin()?.timings.resolveMs).toBe(40);
  });

  it("records a successful join as live with retries and phase timings", () => {
    const id = beginJoinAttempt(2);
    setJoinUrlKind(id, "tunnel");
    at(10);
    advanceJoinStage(id, "keyExchange");
    at(20);
    advanceJoinStage(id, "connect");
    countJoinRetry(id);
    countJoinRetry(id);
    at(30);
    advanceJoinStage(id, "activate");
    at(40);
    finishJoinAttempt(id);

    const attempt = newestJoin();
    expect(attempt).toMatchObject({ succeeded: true, stage: "live", retries: 2 });
    expect(attempt?.timings).toMatchObject({
      resolveMs: 10,
      keyExchangeMs: 10,
      connectMs: 10,
      activateMs: 10,
      e2eeMs: 20,
    });
  });

  it("logs E2EE key-exchange milestones join-relative, only during a join", () => {
    const entries: LogEntry[] = [];
    const stop = addLogListener((entry) => entries.push(entry));
    setLogLevel("info");
    try {
      markJoinMilestone("e2ee room key applied");
      const id = beginJoinAttempt(4);
      at(15);
      markJoinMilestone("e2ee announce sent");
      at(60);
      markJoinMilestone("e2ee room key applied");
      abandonJoinAttempt(id);
      markJoinMilestone("e2ee room key applied");
    } finally {
      setLogLevel("warn");
      stop();
    }

    expect(
      entries
        .filter((e) => e.message.startsWith("voice join milestone: e2ee"))
        .map((e) => [e.message, e.data]),
    ).toEqual([
      ["voice join milestone: e2ee announce sent", { ms: 15 }],
      ["voice join milestone: e2ee room key applied", { ms: 60 }],
    ]);
  });

  it("marks join-relative ms for the first local and remote track", () => {
    const id = beginJoinAttempt(3);
    at(30);
    markLocalTrackPublished();
    at(100);
    markFirstRemoteTrackSubscribed();
    // A second publication/subscription does not overwrite the first mark.
    at(200);
    markLocalTrackPublished();
    markFirstRemoteTrackSubscribed();
    finishJoinAttempt(id);

    expect(newestJoin()?.timings).toMatchObject({ localTrackMs: 30, remoteTrackMs: 100 });
    expect(newestJoin()?.timings.e2eeMs).toBeNull();
  });

  it("still marks a track the SDK delivers just after the attempt finished", () => {
    const id = beginJoinAttempt(8);
    at(20);
    finishJoinAttempt(id);
    // The first remote track can arrive after connect() returned and the
    // attempt was recorded; it must still land on that join.
    at(120);
    markFirstRemoteTrackSubscribed();

    expect(newestJoin()?.timings.remoteTrackMs).toBe(120);
  });

  it("drops an abandoned attempt without recording it", () => {
    const id = beginJoinAttempt(4);
    const before = voiceJoinSnapshot().lastJoins.length;
    abandonJoinAttempt(id + 1000); // a stale id must not drop the active attempt
    expect(voiceJoinSnapshot().active?.channelId).toBe(4);
    abandonJoinAttempt(id);

    expect(voiceJoinSnapshot().active).toBeNull();
    expect(voiceJoinSnapshot().lastJoins.length).toBe(before);
  });

  it("keeps at most five attempts", () => {
    for (let i = 0; i < 7; i++) {
      const id = beginJoinAttempt(i);
      finishJoinAttempt(id);
    }
    expect(voiceJoinSnapshot().lastJoins).toHaveLength(5);
    expect(voiceJoinSnapshot().lastJoins[0]?.channelId).toBe(6);
  });

  it("ignores stage advances and retries from a superseded attempt", () => {
    const first = beginJoinAttempt(1);
    const second = beginJoinAttempt(2);
    advanceJoinStage(first, "connect");
    countJoinRetry(first);
    finishJoinAttempt(second);

    const attempt = newestJoin();
    expect(attempt?.channelId).toBe(2);
    expect(attempt?.retries).toBe(0);
  });
});

describe("decrypt count and self-test", () => {
  it("counts receive-side decrypt failures", () => {
    const before = voiceJoinSnapshot().decryptErrorCount;
    recordDecryptError();
    recordDecryptError();
    expect(voiceJoinSnapshot().decryptErrorCount).toBe(before + 2);
  });

  it("keeps a run's stages, replacing a changed stage", () => {
    resetSelfTest();
    recordSelfTestStage("connection", "passed");
    recordSelfTestStage("signaling", "failed");
    recordSelfTestStage("signaling", "passed");

    expect(voiceJoinSnapshot().selfTest?.stages).toEqual({
      connection: "passed",
      signaling: "passed",
    });
  });

  it("drops the previous run's stages when a new run starts", () => {
    recordSelfTestStage("connection", "passed");
    recordSelfTestStage("signaling", "passed");
    recordSelfTestStage("media", "passed");
    resetSelfTest();
    recordSelfTestStage("connection", "failed");

    expect(voiceJoinSnapshot().selfTest?.stages).toEqual({ connection: "failed" });
  });
});

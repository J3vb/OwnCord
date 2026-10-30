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
  redactTunnelUrl,
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
} from "@lib/voice/voiceJoinTrace";
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

describe("redactTunnelUrl", () => {
  it("replaces the tunnel path token and keeps the rest", () => {
    const token = "ab".repeat(32);
    expect(redactTunnelUrl(`ws://127.0.0.1:5123/${token}/livekit`)).toBe(
      "ws://127.0.0.1:5123/…/livekit",
    );
  });

  it("leaves a URL without a tunnel token unchanged", () => {
    expect(redactTunnelUrl("ws://127.0.0.1:7880")).toBe("ws://127.0.0.1:7880");
    expect(redactTunnelUrl("wss://voice.example.com/livekit")).toBe(
      "wss://voice.example.com/livekit",
    );
  });
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

  it("leaves a track mark long after the attempt finished off the join", () => {
    const id = beginJoinAttempt(9);
    at(20);
    finishJoinAttempt(id);
    // A first PTT press or a peer joining minutes later is not part of the join.
    at(300_000);
    markLocalTrackPublished();
    markFirstRemoteTrackSubscribed();

    expect(newestJoin()?.timings).toMatchObject({ localTrackMs: null, remoteTrackMs: null });
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

const TIMELINE = "voice join timeline";

/** Every log line the trace writes while `run` executes, at info level. */
function captureLogs(run: () => void): LogEntry[] {
  const entries: LogEntry[] = [];
  const stop = addLogListener((entry) => entries.push(entry));
  setLogLevel("info");
  try {
    run();
  } finally {
    setLogLevel("warn");
    stop();
  }
  return entries;
}

describe("redactTunnelUrl token shape", () => {
  it("redacts only a full 64-character lowercase hex segment followed by a slash", () => {
    const tok = "0123456789abcdef".repeat(4);
    expect(redactTunnelUrl(`ws://127.0.0.1:1/${tok.slice(1)}/x`)).toBe(
      `ws://127.0.0.1:1/${tok.slice(1)}/x`,
    );
    expect(redactTunnelUrl(`ws://127.0.0.1:1/${tok}0/x`)).toBe(`ws://127.0.0.1:1/${tok}0/x`);
    expect(redactTunnelUrl(`ws://127.0.0.1:1/${tok.toUpperCase()}/x`)).toBe(
      `ws://127.0.0.1:1/${tok.toUpperCase()}/x`,
    );
    expect(redactTunnelUrl(`ws://127.0.0.1:1/${tok}`)).toBe(`ws://127.0.0.1:1/${tok}`);
    expect(redactTunnelUrl(`ws://127.0.0.1:1/${tok}/x`)).toBe("ws://127.0.0.1:1/…/x");
  });

  it("redacts the first token only", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(redactTunnelUrl(`ws://h/${a}/p/${b}/q`)).toBe(`ws://h/…/p/${b}/q`);
  });
});

describe("classifyJoinUrl precedence", () => {
  it("treats a localhost origin as the tunnel and requires the port colon", () => {
    expect(classifyJoinUrl("ws://localhost:9000/x", undefined, "/livekit")).toBe("tunnel");
    expect(classifyJoinUrl("ws://127.0.0.1/x", undefined, "/livekit")).toBe("unknown");
    expect(classifyJoinUrl("ws://localhost/x", undefined, "/livekit")).toBe("unknown");
    expect(classifyJoinUrl("wss://127.0.0.1:9000/x", undefined, "/livekit")).toBe("unknown");
  });

  it("prefers direct over passthrough and over tunnel when the strings match", () => {
    expect(classifyJoinUrl("/livekit", "/livekit", "/livekit")).toBe("direct");
    expect(classifyJoinUrl("ws://127.0.0.1:5/x", "ws://127.0.0.1:5/x", "/livekit")).toBe("direct");
  });

  it("is not direct when the server named a different direct_url", () => {
    expect(classifyJoinUrl("/livekit", "ws://127.0.0.1:7880", "/livekit")).toBe("passthrough");
    expect(classifyJoinUrl("ws://127.0.0.1:5/x", "ws://127.0.0.1:7880", "/livekit")).toBe("tunnel");
  });
});

describe("active attempt in the snapshot", () => {
  it("starts at resolve with an unknown URL kind and no retries", () => {
    const id = beginJoinAttempt(11);
    expect(voiceJoinSnapshot().active).toEqual({
      channelId: 11,
      stage: "resolve",
      urlKind: "unknown",
      retries: 0,
    });
    abandonJoinAttempt(id);
  });

  it("follows the stage, URL kind and retry count as the join goes on", () => {
    const id = beginJoinAttempt(12);
    setJoinUrlKind(id, "passthrough");
    advanceJoinStage(id, "keyExchange");
    expect(voiceJoinSnapshot().active?.stage).toBe("keyExchange");
    advanceJoinStage(id, "connect");
    countJoinRetry(id);
    expect(voiceJoinSnapshot().active).toEqual({
      channelId: 12,
      stage: "connect",
      urlKind: "passthrough",
      retries: 1,
    });
    advanceJoinStage(id, "activate");
    expect(voiceJoinSnapshot().active?.stage).toBe("activate");
    abandonJoinAttempt(id);
  });

  it("ignores a stage advance from a superseded attempt", () => {
    const old = beginJoinAttempt(1);
    const current = beginJoinAttempt(2);
    at(30);
    advanceJoinStage(old, "connect");
    expect(voiceJoinSnapshot().active?.stage).toBe("resolve");
    advanceJoinStage(current, "keyExchange");
    advanceJoinStage(old, "activate");
    expect(voiceJoinSnapshot().active?.stage).toBe("keyExchange");
    abandonJoinAttempt(current);
  });

  it("ignores a URL kind from a superseded attempt", () => {
    const old = beginJoinAttempt(1);
    const current = beginJoinAttempt(2);
    setJoinUrlKind(old, "tunnel");
    expect(voiceJoinSnapshot().active?.urlKind).toBe("unknown");
    setJoinUrlKind(current, "direct");
    expect(voiceJoinSnapshot().active?.urlKind).toBe("direct");
    abandonJoinAttempt(current);
  });

  it("is empty once the attempt finished or failed", () => {
    finishJoinAttempt(beginJoinAttempt(1));
    expect(voiceJoinSnapshot().active).toBeNull();
    failJoinAttempt(beginJoinAttempt(2));
    expectConsole("warn", /voice join timeline/);
    expect(voiceJoinSnapshot().active).toBeNull();
  });

  it("ignores finish and fail for an id that is not the active one", () => {
    const id = beginJoinAttempt(3);
    const before = voiceJoinSnapshot().lastJoins.length;
    finishJoinAttempt(id + 500);
    failJoinAttempt(id + 500);
    expect(voiceJoinSnapshot().active?.channelId).toBe(3);
    expect(voiceJoinSnapshot().lastJoins).toHaveLength(before);
    abandonJoinAttempt(id);
  });
});

describe("phase timings", () => {
  it("leaves a phase unmeasured when its predecessor never started", () => {
    const id = beginJoinAttempt(1);
    at(10);
    advanceJoinStage(id, "connect");
    at(25);
    advanceJoinStage(id, "activate");
    at(40);
    finishJoinAttempt(id);
    expect(newestJoin()?.timings).toEqual({
      resolveMs: null,
      keyExchangeMs: null,
      connectMs: 15,
      activateMs: 15,
      e2eeMs: 10,
      localTrackMs: null,
      remoteTrackMs: null,
    });
  });

  it("leaves activate unmeasured when the join was never activated", () => {
    const id = beginJoinAttempt(1);
    at(5);
    finishJoinAttempt(id);
    expect(newestJoin()?.timings.activateMs).toBeNull();
    expect(newestJoin()?.timings.connectMs).toBeNull();
  });

  it("measures an activate that starts at zero elapsed time", () => {
    const id = beginJoinAttempt(1);
    advanceJoinStage(id, "keyExchange");
    advanceJoinStage(id, "connect");
    advanceJoinStage(id, "activate");
    finishJoinAttempt(id);
    expect(newestJoin()?.timings).toMatchObject({
      resolveMs: 0,
      keyExchangeMs: 0,
      connectMs: 0,
      activateMs: 0,
      e2eeMs: 0,
    });
  });

  it("keeps the timings measured before a failure", () => {
    const id = beginJoinAttempt(1);
    at(10);
    advanceJoinStage(id, "keyExchange");
    at(30);
    advanceJoinStage(id, "connect");
    at(60);
    advanceJoinStage(id, "activate");
    failJoinAttempt(id);
    expectConsole("warn", /voice join timeline/);
    expect(newestJoin()).toMatchObject({ succeeded: false, stage: "activate" });
    expect(newestJoin()?.timings).toMatchObject({
      resolveMs: 10,
      keyExchangeMs: 20,
      connectMs: 30,
      activateMs: null,
    });
  });

  it("only moves the stage for resolve and live", () => {
    const id = beginJoinAttempt(1);
    at(10);
    advanceJoinStage(id, "live");
    expect(voiceJoinSnapshot().active?.stage).toBe("live");
    advanceJoinStage(id, "resolve");
    expect(voiceJoinSnapshot().active?.stage).toBe("resolve");
    abandonJoinAttempt(id);
    const done = beginJoinAttempt(2);
    advanceJoinStage(done, "live");
    finishJoinAttempt(done);
    expect(newestJoin()?.timings).toMatchObject({ resolveMs: null, e2eeMs: null });
  });

  it("does not let a later phase change a recorded attempt", () => {
    const id = beginJoinAttempt(1);
    at(10);
    finishJoinAttempt(id);
    const recorded = newestJoin()!;
    const next = beginJoinAttempt(2);
    at(50);
    markLocalTrackPublished();
    expect(recorded.timings.localTrackMs).toBeNull();
    expect(voiceJoinSnapshot().lastJoins[0]).toEqual(recorded);
    abandonJoinAttempt(next);
  });
});

describe("track marks around the end of a join", () => {
  it("accepts a late mark up to five seconds after the join was recorded, not beyond", () => {
    const id = beginJoinAttempt(1);
    finishJoinAttempt(id);
    at(5_000);
    markLocalTrackPublished();
    expect(newestJoin()?.timings.localTrackMs).toBe(5_000);
    at(5_001);
    markFirstRemoteTrackSubscribed();
    expect(newestJoin()?.timings.remoteTrackMs).toBeNull();
  });

  it("keeps the first late mark", () => {
    const id = beginJoinAttempt(1);
    finishJoinAttempt(id);
    at(100);
    markLocalTrackPublished();
    markFirstRemoteTrackSubscribed();
    at(900);
    markLocalTrackPublished();
    markFirstRemoteTrackSubscribed();
    expect(newestJoin()?.timings).toMatchObject({ localTrackMs: 100, remoteTrackMs: 100 });
  });

  it("does not put a late mark on a failed attempt", () => {
    const id = beginJoinAttempt(1);
    failJoinAttempt(id);
    expectConsole("warn", /voice join timeline/);
    at(50);
    markLocalTrackPublished();
    markFirstRemoteTrackSubscribed();
    expect(newestJoin()?.timings).toMatchObject({ localTrackMs: null, remoteTrackMs: null });
  });

  it("does not put a mark on the previous join once a new one began", () => {
    finishJoinAttempt(beginJoinAttempt(1));
    const previous = newestJoin()!;
    const next = beginJoinAttempt(2);
    at(40);
    markLocalTrackPublished();
    expect(previous.timings.localTrackMs).toBeNull();
    finishJoinAttempt(next);
    expect(newestJoin()?.channelId).toBe(2);
    expect(newestJoin()?.timings.localTrackMs).toBe(40);
  });

  it("drops a mark after the attempt was abandoned", () => {
    finishJoinAttempt(beginJoinAttempt(1));
    abandonJoinAttempt(beginJoinAttempt(2));
    at(10);
    markLocalTrackPublished();
    markFirstRemoteTrackSubscribed();
    expect(newestJoin()?.channelId).toBe(1);
    expect(newestJoin()?.timings).toMatchObject({ localTrackMs: null, remoteTrackMs: null });
  });

  it("keeps a mark on the active attempt and never reaches back to the last one", () => {
    finishJoinAttempt(beginJoinAttempt(1));
    const id = beginJoinAttempt(2);
    at(10);
    markLocalTrackPublished();
    at(20);
    markLocalTrackPublished();
    markFirstRemoteTrackSubscribed();
    finishJoinAttempt(id);
    expect(newestJoin()?.timings).toMatchObject({ localTrackMs: 10, remoteTrackMs: 20 });
    expect(voiceJoinSnapshot().lastJoins[1]?.timings).toMatchObject({
      localTrackMs: null,
      remoteTrackMs: null,
    });
  });
});

describe("join log lines", () => {
  it("logs the e2ee milestone at connect and each first track mark once", () => {
    const entries = captureLogs(() => {
      const id = beginJoinAttempt(1);
      at(7);
      advanceJoinStage(id, "keyExchange");
      at(30);
      advanceJoinStage(id, "connect");
      at(31);
      markLocalTrackPublished();
      markLocalTrackPublished();
      at(33);
      markFirstRemoteTrackSubscribed();
      markFirstRemoteTrackSubscribed();
      abandonJoinAttempt(id);
    });
    expect(entries.map((e) => [e.level, e.message, e.data])).toEqual([
      ["info", "voice join milestone: e2ee key exchange complete", { ms: 30 }],
      ["info", "voice join milestone: local track published", { ms: 31 }],
      ["info", "voice join milestone: first remote track subscribed", { ms: 33 }],
    ]);
  });

  it("logs a late mark against the finished join", () => {
    const id = beginJoinAttempt(1);
    finishJoinAttempt(id);
    const entries = captureLogs(() => {
      at(12);
      markLocalTrackPublished();
      markLocalTrackPublished();
      at(14);
      markFirstRemoteTrackSubscribed();
      markFirstRemoteTrackSubscribed();
    });
    expect(entries.map((e) => [e.message, e.data])).toEqual([
      ["voice join milestone: local track published", { ms: 12 }],
      ["voice join milestone: first remote track subscribed", { ms: 14 }],
    ]);
  });

  it("logs a finished join as info and a failed one as a warning, with the attempt", () => {
    const entries = captureLogs(() => {
      const ok = beginJoinAttempt(5);
      setJoinUrlKind(ok, "direct");
      finishJoinAttempt(ok);
      failJoinAttempt(beginJoinAttempt(6));
    });
    expectConsole("warn", /voice join timeline/);
    expect(entries.map((e) => [e.level, e.message])).toEqual([
      ["info", TIMELINE],
      ["warn", TIMELINE],
    ]);
    expect(entries[0]!.data).toMatchObject({
      channelId: 5,
      urlKind: "direct",
      succeeded: true,
      stage: "live",
      retries: 0,
    });
    expect(entries[1]!.data).toMatchObject({ channelId: 6, succeeded: false, stage: "resolve" });
  });
});

describe("recorded attempts", () => {
  it("keeps exactly five, newest first, dropping the oldest", () => {
    for (let i = 0; i < 5; i++) finishJoinAttempt(beginJoinAttempt(100 + i));
    expect(voiceJoinSnapshot().lastJoins.map((a) => a.channelId)).toEqual([
      104, 103, 102, 101, 100,
    ]);
    finishJoinAttempt(beginJoinAttempt(105));
    expect(voiceJoinSnapshot().lastJoins.map((a) => a.channelId)).toEqual([
      105, 104, 103, 102, 101,
    ]);
  });

  it("records a start time from the clock at the attempt's start", () => {
    at(777);
    finishJoinAttempt(beginJoinAttempt(1));
    expect(newestJoin()?.startedAt).toBe(T0 + 777);
  });

  it("hands out copies a caller cannot use to change the record", () => {
    finishJoinAttempt(beginJoinAttempt(1));
    const snap = voiceJoinSnapshot();
    (snap.lastJoins[0]!.timings as { resolveMs: number | null }).resolveMs = 999;
    snap.lastJoins.length = 0;
    expect(newestJoin()?.timings.resolveMs).toBeNull();
    expect(voiceJoinSnapshot().lastJoins.length).toBeGreaterThan(0);
  });
});

describe("self-test snapshot", () => {
  it("is absent after a reset and stamped with the time of the last stage", () => {
    resetSelfTest();
    expect(voiceJoinSnapshot().selfTest).toBeNull();
    at(100);
    recordSelfTestStage("connection", "passed");
    expect(voiceJoinSnapshot().selfTest?.updatedAt).toBe(T0 + 100);
    at(250);
    recordSelfTestStage("media", "failed");
    expect(voiceJoinSnapshot().selfTest?.updatedAt).toBe(T0 + 250);
  });

  it("hands out a copy of the stages", () => {
    resetSelfTest();
    recordSelfTestStage("connection", "passed");
    const snap = voiceJoinSnapshot().selfTest!;
    snap.stages["connection"] = "tampered";
    expect(voiceJoinSnapshot().selfTest?.stages).toEqual({ connection: "passed" });
  });
});

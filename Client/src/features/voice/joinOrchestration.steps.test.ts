/**
 * The steps of a voice join, their order, and what each checkpoint does when a
 * newer attempt (or a leave) has taken the session in the meantime: a
 * superseded attempt releases only its own room and never touches the shared
 * session state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomEvent, type Room } from "livekit-client";
import { captureLogs } from "../../../tests/helpers/log-capture";
import { expectConsole } from "../../../tests/helpers/console";
import type { SessionState } from "./sessionState";

const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@lib/prefs/preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/prefs/preferences")>()),
  loadPref: (key: string, fallback: unknown) => (prefs.has(key) ? prefs.get(key) : fallback),
}));
vi.mock("../../stores/voice.store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../stores/voice.store")>();
  return {
    ...actual,
    setVoiceStatus: vi.fn(actual.setVoiceStatus),
    leaveVoiceChannel: vi.fn(actual.leaveVoiceChannel),
  };
});
vi.mock("../../lib/voice/livekitDiagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/voice/livekitDiagnostics")>()),
  logIceConnectionInfo: vi.fn(),
}));

import { JoinOrchestration, type JoinHost } from "./joinOrchestration";
import { onRoom } from "./releaseRoom";
import { voiceJoinSnapshot } from "../../lib/voice/voiceJoinTrace";
import { joinRetryInMs, noteJoinSucceeded } from "./joinBackoff";
import { leaveVoiceChannel, setVoiceStatus, voiceStore } from "../../stores/voice.store";
import { logIceConnectionInfo } from "../../lib/voice/livekitDiagnostics";
import { voiceText } from "../../i18n/voice";

type FakeRoom = Room & {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  startAudio: ReturnType<typeof vi.fn>;
  switchActiveDevice: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
};

function fakeRoom(state = "connected"): FakeRoom {
  return {
    state,
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(async () => {}),
    startAudio: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    switchActiveDevice: vi.fn(async () => true),
  } as unknown as FakeRoom;
}

function setup(initial: SessionState = { type: "idle" }) {
  let state = initial;
  let generation = 0;
  const calls: string[] = [];
  const e2ee = {
    clearState: vi.fn(),
    holdAnnouncesForQueuedJoin: vi.fn(),
    releaseHeldAnnounces: vi.fn(() => void calls.push("releaseHeldAnnounces")),
    setupKeyExchange: vi.fn(async () => {
      calls.push("setupKeyExchange");
      return true;
    }),
  };
  const audioPipeline = {
    setRoom: vi.fn(),
    setupAudioPipeline: vi.fn(() => void calls.push("setupAudioPipeline")),
  };
  const audioElements = { setRoom: vi.fn() };
  const deviceManager = {
    setRoom: vi.fn(),
    setAudioPipeline: vi.fn(),
    setOnError: vi.fn(),
    setOnToast: vi.fn(),
  };
  const onError = vi.fn();
  const rooms: FakeRoom[] = [];
  const host = {
    getState: () => state,
    setState: vi.fn((next: SessionState) => {
      state = next;
    }),
    nextJoinGeneration: vi.fn(() => ++generation),
    getRoom: () => (state.type === "connected" ? state.room : null),
    getE2EE: () => e2ee,
    getAudioPipeline: () => audioPipeline,
    getAudioElements: () => audioElements,
    getDeviceManager: () => deviceManager,
    getOnError: () => onError,
    createRoom: vi.fn(async () => {
      calls.push("createRoom");
      const room = fakeRoom();
      rooms.push(room);
      return room;
    }),
    resolveLiveKitUrl: vi.fn(async (proxyPath: string) => {
      calls.push("resolveLiveKitUrl");
      return proxyPath;
    }),
    restoreLocalVoiceState: vi.fn(async () => {
      calls.push("restoreLocalVoiceState");
    }),
    reapplyMuteGain: vi.fn(() => void calls.push("reapplyMuteGain")),
    restateSelfVoiceState: vi.fn(() => void calls.push("restateSelfVoiceState")),
    startTokenRefreshTimer: vi.fn(() => void calls.push("startTokenRefreshTimer")),
    syncModuleRooms: vi.fn(),
    leaveVoice: vi.fn(() => {
      state = { type: "idle" };
    }),
    sweepPublications: vi.fn(() => void calls.push("sweepPublications")),
    handleVoiceTokenRefresh: vi.fn(),
    connectAndSetup: vi.fn(
      async (
        _token: string,
        _url: string,
        _channelId: number,
        _directUrl?: string,
        _isKeyHolder?: boolean,
      ) => true as const,
    ),
  };
  const join = new JoinOrchestration(host as unknown as JoinHost);
  /** A newer attempt claims the shared state. */
  const newerAttempt = (): void => {
    state = { type: "connecting", pendingJoin: null, joinGeneration: 99 };
  };
  return {
    host,
    join,
    e2ee,
    audioPipeline,
    audioElements,
    deviceManager,
    onError,
    rooms,
    calls,
    newerAttempt,
    getState: () => state,
  };
}

const lastJoinCount = (): number => voiceJoinSnapshot().lastJoins.length;
/** A join that fails is written to the log as a warning; claim it. */
const expectTimelineWarning = (): void => expectConsole("warn", /voice join timeline/);

beforeEach(() => {
  prefs.clear();
  noteJoinSucceeded();
  voiceStore.setState((prev) => ({ ...prev, currentChannelId: 6, voiceStatus: "idle" }));
  vi.mocked(setVoiceStatus).mockClear();
  vi.mocked(leaveVoiceChannel).mockClear();
  vi.mocked(logIceConnectionInfo).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a join that goes through", () => {
  it("runs its steps in order, with the saved devices picked before and after the voice state", async () => {
    prefs.set("audioInputDevice", "mic-1");
    prefs.set("audioOutputDevice", "spk-1");
    const logs = captureLogs();
    const ctx = setup();
    ctx.host.createRoom.mockImplementationOnce(async () => {
      ctx.calls.push("createRoom");
      const room = fakeRoom();
      room.connect.mockImplementation(async () => void ctx.calls.push("connect"));
      room.startAudio.mockImplementation(async () => void ctx.calls.push("startAudio"));
      room.switchActiveDevice.mockImplementation(async (kind: string) => {
        ctx.calls.push(`switch:${kind}`);
        return true;
      });
      ctx.rooms.push(room);
      return room;
    });

    await expect(
      ctx.join.connectAndSetup("tok", "/livekit", 6, "ws://127.0.0.1:7880"),
    ).resolves.toBe(true);

    expect(ctx.calls).toEqual([
      "createRoom",
      "resolveLiveKitUrl",
      "setupKeyExchange",
      "connect",
      "releaseHeldAnnounces",
      "sweepPublications",
      "startAudio",
      "switch:audioinput",
      "restoreLocalVoiceState",
      "switch:audiooutput",
      "setupAudioPipeline",
      "reapplyMuteGain",
      "restateSelfVoiceState",
      "startTokenRefreshTimer",
    ]);
    const room = ctx.rooms[0]!;
    expect(room.switchActiveDevice).toHaveBeenNthCalledWith(1, "audioinput", "mic-1", false);
    expect(room.switchActiveDevice).toHaveBeenNthCalledWith(2, "audiooutput", "spk-1");
    expect(room.connect).toHaveBeenCalledWith("/livekit", "tok", { autoSubscribe: false });
    expect(ctx.getState()).toEqual({
      type: "connected",
      room,
      channelId: 6,
      latestToken: "tok",
      lastUrl: "/livekit",
      lastDirectUrl: "ws://127.0.0.1:7880",
    });
    expect(vi.mocked(setVoiceStatus).mock.calls.map((c) => c[0])).toEqual([
      "joining",
      "securing",
      "connected",
    ]);
    expect(logIceConnectionInfo).toHaveBeenCalledExactlyOnceWith(room);
    expect(logs.find("Voice session active")[0]!.component).toBe("livekitSession");
  });

  it("wires every module to the new room and gives them the error callback", async () => {
    const ctx = setup();

    await ctx.join.connectAndSetup("t", "/livekit", 6);

    const room = ctx.rooms[0]!;
    expect(ctx.audioPipeline.setRoom).toHaveBeenCalledExactlyOnceWith(room);
    expect(ctx.audioElements.setRoom).toHaveBeenCalledExactlyOnceWith(room);
    expect(ctx.deviceManager.setRoom).toHaveBeenCalledExactlyOnceWith(room);
    expect(ctx.deviceManager.setAudioPipeline).toHaveBeenCalledExactlyOnceWith(ctx.audioPipeline);
    expect(ctx.deviceManager.setOnError).toHaveBeenCalledExactlyOnceWith(ctx.onError);
    expect(ctx.deviceManager.setOnToast).toHaveBeenCalledExactlyOnceWith(ctx.onError);
  });

  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ])("starts the key exchange as key holder %s -> %s", async (isKeyHolder, expected) => {
    const ctx = setup();

    await ctx.join.connectAndSetup("t", "/livekit", 6, undefined, isKeyHolder);

    expect(ctx.e2ee.setupKeyExchange).toHaveBeenCalledExactlyOnceWith(expected, 6);
  });

  it("records the join as live with the way its URL was resolved", async () => {
    const ctx = setup();
    ctx.host.resolveLiveKitUrl.mockResolvedValueOnce("ws://127.0.0.1:7880");

    await ctx.join.connectAndSetup("t", "/livekit", 6, "ws://127.0.0.1:7880");

    expect(voiceJoinSnapshot().lastJoins[0]).toMatchObject({
      channelId: 6,
      succeeded: true,
      stage: "live",
      urlKind: "direct",
      retries: 0,
    });
    expect(voiceJoinSnapshot().active).toBeNull();
  });

  it("logs the connection with the URL's tunnel token redacted, then the active session", async () => {
    const logs = captureLogs();
    const ctx = setup();
    const token = "a".repeat(64);
    ctx.host.resolveLiveKitUrl.mockResolvedValueOnce(`wss://host/${token}/rtc`);

    await ctx.join.connectAndSetup("t", "/livekit", 6);

    expect(logs.find("Connected to LiveKit room").map((e) => e.data)).toEqual([
      { channelId: 6, url: "wss://host/…/rtc" },
    ]);
    expect(logs.find("Voice session active").map((e) => e.data)).toEqual([{ channelId: 6 }]);
    expect(logs.find("Voice session active")[0]!.component).toBe("livekitSession");
  });

  it("goes on with the default devices when no saved device is set", async () => {
    const ctx = setup();

    await ctx.join.connectAndSetup("t", "/livekit", 6);

    expect(ctx.rooms[0]!.switchActiveDevice).not.toHaveBeenCalled();
  });

  it("goes on with the default devices when a saved device is unavailable", async () => {
    const logs = captureLogs();
    prefs.set("audioInputDevice", "mic-1");
    prefs.set("audioOutputDevice", "spk-1");
    const ctx = setup();
    ctx.host.createRoom.mockImplementationOnce(async () => {
      const room = fakeRoom();
      room.switchActiveDevice.mockRejectedValue(new Error("gone"));
      ctx.rooms.push(room);
      return room;
    });

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe(true);

    expectConsole("warn", /Saved input device unavailable, using default/);
    expectConsole("warn", /Saved output device unavailable, using default/);
    expect(logs.find("Saved input device unavailable, using default")).toHaveLength(1);
    expect(logs.find("Saved output device unavailable, using default")).toHaveLength(1);
    expect(ctx.audioPipeline.setupAudioPipeline).toHaveBeenCalledTimes(1);
  });

  it("only notes that audio could not start yet when the optimistic start is refused", async () => {
    const logs = captureLogs();
    const ctx = setup();
    ctx.host.createRoom.mockImplementationOnce(async () => {
      const room = fakeRoom();
      room.startAudio.mockRejectedValue(new Error("no gesture"));
      ctx.rooms.push(room);
      return room;
    });

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe(true);
    await Promise.resolve();

    expect(logs.find("Optimistic startAudio failed — waiting for user gesture")).toHaveLength(1);
  });

  it("hands what was held for this channel to the live session when the queued join is the same", async () => {
    const ctx = setup();
    ctx.host.createRoom.mockImplementationOnce(async () => {
      const room = fakeRoom();
      room.connect.mockImplementation(async () => {
        const current = ctx.getState();
        if (current.type === "connecting") {
          ctx.host.setState({
            ...current,
            pendingJoin: { token: "t", url: "/livekit", channelId: 6, directUrl: "d" },
          });
        }
      });
      ctx.rooms.push(room);
      return room;
    });

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6, "d")).resolves.toBe(true);

    expect(ctx.e2ee.releaseHeldAnnounces).toHaveBeenCalledExactlyOnceWith(6);
    expect(ctx.getState().type).toBe("connected");
  });
});

describe("a join that is superseded", () => {
  it("stops right after the room is built when a newer attempt owns the state", async () => {
    const logs = captureLogs();
    const ctx = setup();
    ctx.host.createRoom.mockImplementationOnce(async () => {
      ctx.newerAttempt();
      const room = fakeRoom();
      ctx.rooms.push(room);
      return room;
    });

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe("superseded");

    expect(ctx.host.resolveLiveKitUrl).not.toHaveBeenCalled();
    expect(ctx.audioPipeline.setRoom).not.toHaveBeenCalled();
    expect(ctx.deviceManager.setRoom).not.toHaveBeenCalled();
    expect(logs.find("connectAndSetup: superseded after URL resolution — aborting")).toHaveLength(
      0,
    );
    expect(ctx.rooms[0]!.disconnect).toHaveBeenCalledTimes(1);
  });

  it("logs and releases its room when a newer attempt claims the state during URL resolution", async () => {
    const logs = captureLogs();
    const ctx = setup();
    ctx.host.resolveLiveKitUrl.mockImplementationOnce(async (p: string) => {
      ctx.newerAttempt();
      return p;
    });

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe("superseded");

    expect(logs.find("connectAndSetup: superseded after URL resolution — aborting")).toHaveLength(
      1,
    );
    expect(
      logs.find("connectAndSetup: superseded after URL resolution — aborting")[0]!.data,
    ).toEqual({ channelId: 6, myGeneration: 1, currentGeneration: 99 });
    expect(ctx.e2ee.setupKeyExchange).not.toHaveBeenCalled();
    expect(ctx.rooms[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.host.leaveVoice).not.toHaveBeenCalled();
  });

  it("names no newer generation when a leave took the state during URL resolution", async () => {
    const logs = captureLogs();
    const ctx = setup();
    ctx.host.resolveLiveKitUrl.mockImplementationOnce(async (p: string) => {
      ctx.host.setState({ type: "idle" });
      return p;
    });

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe("superseded");

    expect(
      logs.find("connectAndSetup: superseded after URL resolution — aborting")[0]!.data,
    ).toEqual({ channelId: 6, myGeneration: 1, currentGeneration: "n/a" });
    expect(ctx.host.syncModuleRooms).toHaveBeenCalledTimes(1);
  });

  it("leaves a key-exchange failure alone when a newer attempt took the state meanwhile", async () => {
    const logs = captureLogs();
    const ctx = setup();
    ctx.e2ee.setupKeyExchange.mockImplementationOnce(async () => {
      ctx.newerAttempt();
      return false;
    });
    const before = lastJoinCount();

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe("superseded");

    expect(
      logs.find("connectAndSetup: superseded during key exchange — aborting")[0]!.data,
    ).toEqual({ channelId: 6, myGeneration: 1 });
    expect(ctx.rooms[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.onError).not.toHaveBeenCalled();
    expect(ctx.host.leaveVoice).not.toHaveBeenCalled();
    expect(vi.mocked(leaveVoiceChannel)).not.toHaveBeenCalled();
    expect(joinRetryInMs()).toBe(0);
    expect(lastJoinCount()).toBe(before);
    expect(ctx.getState()).toEqual({ type: "connecting", pendingJoin: null, joinGeneration: 99 });
  });

  it.each([
    ["a newer attempt", "newer"],
    ["a leave", "idle"],
  ])("releases only its own room when %s lands during connect", async (_n, kind) => {
    const logs = captureLogs();
    const ctx = setup();
    ctx.host.createRoom.mockImplementationOnce(async () => {
      const room = fakeRoom();
      room.connect.mockImplementation(async () => {
        if (kind === "newer") ctx.newerAttempt();
        else ctx.host.setState({ type: "idle" });
      });
      ctx.rooms.push(room);
      return room;
    });

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe("superseded");

    expect(
      logs.find("connectAndSetup: superseded after room.connect() — aborting")[0]!.data,
    ).toEqual({ channelId: 6, myGeneration: 1, currentGeneration: kind === "newer" ? 99 : "n/a" });
    expect(ctx.rooms[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.host.sweepPublications).not.toHaveBeenCalled();
    expect(ctx.host.leaveVoice).not.toHaveBeenCalled();
  });

  it.each([
    [
      "audio input switch",
      "audioinput",
      "connectAndSetup: superseded after audioinput switch — aborting",
    ],
    [
      "voice state restore",
      "restore",
      "connectAndSetup: superseded after restoreLocalVoiceState — aborting",
    ],
    [
      "audio output switch",
      "audiooutput",
      "connectAndSetup: superseded after audiooutput switch — aborting",
    ],
  ])("stops at the checkpoint after the %s", async (_n, step, message) => {
    prefs.set("audioInputDevice", "mic-1");
    prefs.set("audioOutputDevice", "spk-1");
    const logs = captureLogs();
    const ctx = setup();
    const leave = (): void => ctx.host.setState({ type: "idle" });
    ctx.host.createRoom.mockImplementationOnce(async () => {
      const room = fakeRoom();
      room.switchActiveDevice.mockImplementation(async (kind: string) => {
        if (kind === step) leave();
        return true;
      });
      ctx.rooms.push(room);
      return room;
    });
    if (step === "restore")
      ctx.host.restoreLocalVoiceState.mockImplementationOnce(async () => {
        leave();
      });

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe("superseded");

    expect(logs.find(message)).toHaveLength(1);
    expect(logs.find(message)[0]!.data).toEqual({ channelId: 6 });
    expect(ctx.rooms[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.audioPipeline.setupAudioPipeline).not.toHaveBeenCalled();
    expect(ctx.host.startTokenRefreshTimer).not.toHaveBeenCalled();
    expect(ctx.host.restateSelfVoiceState).not.toHaveBeenCalled();
    // The input switch stops before the voice state is restored; the restore
    // stops before the output device is touched.
    expect(ctx.host.restoreLocalVoiceState).toHaveBeenCalledTimes(step === "audioinput" ? 0 : 1);
    expect(
      ctx.rooms[0]!.switchActiveDevice.mock.calls.filter((c) => c[0] === "audiooutput"),
    ).toHaveLength(step === "audiooutput" ? 1 : 0);
  });

  it("leaves no attempt open on the timeline", async () => {
    const ctx = setup();
    ctx.host.resolveLiveKitUrl.mockImplementationOnce(async (p: string) => {
      ctx.newerAttempt();
      return p;
    });

    await ctx.join.connectAndSetup("t", "/livekit", 6);

    expect(voiceJoinSnapshot().active).toBeNull();
  });

  it("logs a failure to release the room it abandoned", async () => {
    const logs = captureLogs();
    const ctx = setup();
    ctx.host.resolveLiveKitUrl.mockImplementationOnce(async (p: string) => {
      ctx.newerAttempt();
      return p;
    });
    ctx.host.createRoom.mockImplementationOnce(async () => {
      const room = fakeRoom();
      room.disconnect.mockRejectedValue(new Error("already closed"));
      ctx.rooms.push(room);
      return room;
    });

    await ctx.join.connectAndSetup("t", "/livekit", 6);
    await Promise.resolve();

    expect(logs.find("Failed to disconnect superseded room")).toHaveLength(1);
  });
});

describe("a key exchange that gives up", () => {
  it("tells the member, leaves the channel and backs off the next join", async () => {
    const ctx = setup();
    ctx.e2ee.setupKeyExchange.mockResolvedValueOnce(false);

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe(false);
    expectTimelineWarning();

    expect(ctx.onError).toHaveBeenCalledExactlyOnceWith(voiceText("join.securingTimeout"));
    expect(ctx.host.leaveVoice).toHaveBeenCalledExactlyOnceWith(true, false);
    expect(vi.mocked(leaveVoiceChannel)).toHaveBeenCalledTimes(1);
    expect(joinRetryInMs()).toBeGreaterThan(0);
    expect(ctx.rooms[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(voiceJoinSnapshot().lastJoins[0]).toMatchObject({
      channelId: 6,
      succeeded: false,
      stage: "keyExchange",
    });
    expect(ctx.audioPipeline.setupAudioPipeline).not.toHaveBeenCalled();
  });

  it("logs a failure to release the room it gave up on", async () => {
    const logs = captureLogs();
    const ctx = setup();
    ctx.e2ee.setupKeyExchange.mockResolvedValueOnce(false);
    ctx.host.createRoom.mockImplementationOnce(async () => {
      const room = fakeRoom();
      room.disconnect.mockRejectedValue(new Error("already closed"));
      ctx.rooms.push(room);
      return room;
    });

    await ctx.join.connectAndSetup("t", "/livekit", 6);
    expectTimelineWarning();
    await Promise.resolve();

    expect(logs.find("Failed to disconnect room after key exchange failure")).toHaveLength(1);
  });

  it("keeps a queued channel switch and clears only what this attempt left behind", async () => {
    const ctx = setup();
    const queued = { token: "t2", url: "/livekit", channelId: 4 };
    ctx.e2ee.setupKeyExchange.mockImplementationOnce(async () => {
      const current = ctx.getState();
      if (current.type === "connecting") ctx.host.setState({ ...current, pendingJoin: queued });
      return false;
    });

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe(false);
    expectTimelineWarning();

    expect(ctx.e2ee.clearState).toHaveBeenCalledExactlyOnceWith({ keepHeldAnnounces: true });
    expect(ctx.onError).not.toHaveBeenCalled();
    expect(ctx.host.leaveVoice).not.toHaveBeenCalled();
    expect(vi.mocked(leaveVoiceChannel)).not.toHaveBeenCalled();
    expect(ctx.getState()).toMatchObject({ type: "connecting", pendingJoin: queued });
    expect(voiceJoinSnapshot().lastJoins[0]).toMatchObject({
      succeeded: false,
      stage: "keyExchange",
    });
  });
});

describe("connect retries", () => {
  it("retries a refused connect, counts the retries and wires the new room each time", async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const built: FakeRoom[] = [];
    ctx.host.createRoom.mockImplementation(async () => {
      const room = fakeRoom();
      if (built.length < 2) room.connect.mockRejectedValue(new Error("refused"));
      built.push(room);
      return room;
    });
    const listener = vi.fn();

    const joining = ctx.join.connectAndSetup("t", "/livekit", 6);
    await vi.advanceTimersByTimeAsync(0);
    onRoom(built[0] as unknown as Room, RoomEvent.Disconnected, listener);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(joining).resolves.toBe(true);

    expectConsole("warn", /LiveKit connect failed, retrying/);
    expectConsole("warn", /LiveKit connect failed, retrying/);
    expect(built).toHaveLength(3);
    expect(built[0]!.off).toHaveBeenCalledWith(RoomEvent.Disconnected, listener);
    expect(ctx.audioPipeline.setRoom.mock.calls.map((c) => c[0])).toEqual(built);
    expect(ctx.audioElements.setRoom.mock.calls.map((c) => c[0])).toEqual(built);
    expect(ctx.deviceManager.setRoom.mock.calls.map((c) => c[0])).toEqual(built);
    expect(ctx.deviceManager.setAudioPipeline).toHaveBeenCalledTimes(3);
    expect(ctx.getState()).toMatchObject({ type: "connected", room: built[2] });
    expect(voiceJoinSnapshot().lastJoins[0]).toMatchObject({ succeeded: true, retries: 2 });
  });

  it("logs each refusal with the attempt, the limit and the redacted URL", async () => {
    vi.useFakeTimers();
    const logs = captureLogs();
    const ctx = setup();
    const token = "b".repeat(64);
    ctx.host.resolveLiveKitUrl.mockResolvedValueOnce(`wss://host/${token}/rtc`);
    const refusals = [new Error("one"), new Error("two")];
    let attempt = 0;
    ctx.host.createRoom.mockImplementation(async () => {
      const room = fakeRoom();
      const refusal = refusals[attempt++];
      if (refusal !== undefined) room.connect.mockRejectedValue(refusal);
      return room;
    });

    const joining = ctx.join.connectAndSetup("t", "/livekit", 6);
    await vi.advanceTimersByTimeAsync(10_000);
    await joining;

    expectConsole("warn", /LiveKit connect failed, retrying/);
    expectConsole("warn", /LiveKit connect failed, retrying/);
    expect(
      logs.find("LiveKit connect failed, retrying").map((e) => {
        const data = e.data as { attempt: number; maxRetries: number; url: string };
        return { attempt: data.attempt, maxRetries: data.maxRetries, url: data.url };
      }),
    ).toEqual([
      { attempt: 1, maxRetries: 3, url: "wss://host/…/rtc" },
      { attempt: 2, maxRetries: 3, url: "wss://host/…/rtc" },
    ]);
  });

  it("gives up after the third refusal, tells the member and leaves", async () => {
    vi.useFakeTimers();
    const logs = captureLogs();
    const ctx = setup();
    ctx.host.createRoom.mockImplementation(async () => {
      const room = fakeRoom();
      room.connect.mockRejectedValue(new Error("refused"));
      ctx.rooms.push(room);
      return room;
    });

    const joining = ctx.join.connectAndSetup("t", "/livekit", 6);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(joining).resolves.toBe(false);
    expectTimelineWarning();

    expectConsole("warn", /LiveKit connect failed, retrying/);
    expectConsole("warn", /LiveKit connect failed, retrying/);
    expectConsole("error", /Failed to connect to LiveKit/);
    expect(ctx.rooms).toHaveLength(3);
    expect(ctx.onError).toHaveBeenCalledExactlyOnceWith(voiceText("join.connectionError"));
    expect(ctx.host.leaveVoice).toHaveBeenCalledExactlyOnceWith(true, false);
    expect(vi.mocked(leaveVoiceChannel)).toHaveBeenCalledTimes(1);
    expect(joinRetryInMs()).toBeGreaterThan(0);
    expect(ctx.rooms[2]!.disconnect).toHaveBeenCalledTimes(1);
    expect(voiceJoinSnapshot().lastJoins[0]).toMatchObject({
      succeeded: false,
      stage: "connect",
      retries: 2,
    });
    expect(logs.find("Failed to connect to LiveKit")[0]).toMatchObject({
      level: "error",
      data: { url: "/livekit" },
    });
  });

  it.each([
    ["a newer attempt", "newer"],
    ["a leave", "idle"],
  ])("stops waiting to retry when %s lands during the backoff", async (_n, kind) => {
    vi.useFakeTimers();
    const logs = captureLogs();
    const ctx = setup();
    ctx.host.createRoom.mockImplementationOnce(async () => {
      const room = fakeRoom();
      room.connect.mockImplementation(async () => {
        setTimeout(() => {
          if (kind === "newer") ctx.newerAttempt();
          else ctx.host.setState({ type: "idle" });
        }, 1000);
        throw new Error("refused");
      });
      ctx.rooms.push(room);
      return room;
    });

    const joining = ctx.join.connectAndSetup("t", "/livekit", 6);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(joining).resolves.toBe("superseded");

    expectConsole("warn", /LiveKit connect failed, retrying/);
    expect(
      logs.find("connectAndSetup: superseded during retry backoff — aborting")[0]!.data,
    ).toEqual({
      channelId: 6,
      attempt: 1,
    });
    expect(ctx.host.createRoom).toHaveBeenCalledTimes(1);
    expect(ctx.rooms[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.host.leaveVoice).not.toHaveBeenCalled();
    expect(ctx.onError).not.toHaveBeenCalled();
  });

  it("releases the replacement room, and wires nothing to it, when it is superseded as it is built", async () => {
    vi.useFakeTimers();
    const ctx = setup();
    let built = 0;
    ctx.host.createRoom.mockImplementation(async () => {
      const room = fakeRoom();
      if (built++ === 0) room.connect.mockRejectedValue(new Error("refused"));
      else ctx.newerAttempt();
      ctx.rooms.push(room);
      return room;
    });

    const joining = ctx.join.connectAndSetup("t", "/livekit", 6);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(joining).resolves.toBe("superseded");

    expectConsole("warn", /LiveKit connect failed, retrying/);
    expect(ctx.rooms[1]!.disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.audioPipeline.setRoom).toHaveBeenCalledExactlyOnceWith(ctx.rooms[0]);
    expect(ctx.deviceManager.setRoom).toHaveBeenCalledExactlyOnceWith(ctx.rooms[0]);
  });
});

describe("a queued channel switch during connect", () => {
  const queued = { token: "t", url: "/livekit", channelId: 6, directUrl: "d" };
  const identical = { ...queued };
  const differing: Array<[string, Partial<typeof queued>]> = [
    ["token", { token: "t2" }],
    ["url", { url: "/other" }],
    ["channel", { channelId: 7 }],
    ["direct URL", { directUrl: "d2" }],
  ];

  const appListener = vi.fn();
  function connectingWithQueue(pending: typeof queued) {
    const ctx = setup();
    ctx.host.createRoom.mockImplementationOnce(async () => {
      const room = fakeRoom();
      onRoom(room as unknown as Room, RoomEvent.Disconnected, appListener);
      room.connect.mockImplementation(async () => {
        const current = ctx.getState();
        if (current.type === "connecting") {
          ctx.host.setState({ ...current, pendingJoin: pending });
        }
      });
      ctx.rooms.push(room);
      return room;
    });
    return ctx;
  }

  it.each(differing)(
    "drops the connected room when the queued join has another %s",
    async (_n, change) => {
      const logs = captureLogs();
      const pending = { ...queued, ...change };
      const ctx = connectingWithQueue(pending);

      await expect(ctx.join.connectAndSetup("t", "/livekit", 6, "d")).resolves.toBe(false);

      const room = ctx.rooms[0]!;
      expect(room.disconnect).toHaveBeenCalledTimes(1);
      expect(room.off).toHaveBeenCalled();
      expect(logs.find("Discarding stale voice join in favor of queued request")[0]!.data).toEqual({
        channelId: 6,
        queuedChannelId: pending.channelId,
      });
      expect(ctx.audioPipeline.setRoom).toHaveBeenLastCalledWith(null);
      expect(ctx.audioElements.setRoom).toHaveBeenLastCalledWith(null);
      expect(ctx.deviceManager.setRoom).toHaveBeenLastCalledWith(null);
      expect(ctx.deviceManager.setAudioPipeline).toHaveBeenLastCalledWith(null);
      expect(ctx.getState()).toMatchObject({ type: "connecting", pendingJoin: pending });
      expect(ctx.e2ee.releaseHeldAnnounces).not.toHaveBeenCalled();
      expect(ctx.host.sweepPublications).not.toHaveBeenCalled();
      expect(ctx.audioPipeline.setupAudioPipeline).not.toHaveBeenCalled();
    },
  );

  it("logs a failure to disconnect the room it discards", async () => {
    const logs = captureLogs();
    const ctx = connectingWithQueue({ ...queued, channelId: 7 });
    ctx.host.createRoom.mockReset();
    ctx.host.createRoom.mockImplementationOnce(async () => {
      const room = fakeRoom();
      room.disconnect.mockRejectedValue(new Error("already closed"));
      room.connect.mockImplementation(async () => {
        const current = ctx.getState();
        if (current.type === "connecting") {
          ctx.host.setState({ ...current, pendingJoin: { ...queued, channelId: 7 } });
        }
      });
      ctx.rooms.push(room);
      return room;
    });

    await ctx.join.connectAndSetup("t", "/livekit", 6, "d");
    await Promise.resolve();

    expect(logs.find("Failed to disconnect room during cleanup")).toHaveLength(1);
  });

  it("keeps the room when the queued join is identical to this one", async () => {
    const ctx = connectingWithQueue(identical);

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6, "d")).resolves.toBe(true);

    expect(ctx.rooms[0]!.disconnect).not.toHaveBeenCalled();
    expect(ctx.getState().type).toBe("connected");
  });
});

describe("a join that throws", () => {
  it("logs the failure with the redacted URL, releases the room and tells the member", async () => {
    const logs = captureLogs();
    const ctx = setup();
    ctx.host.restoreLocalVoiceState.mockRejectedValueOnce(new Error("restore failed"));

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe(false);
    expectTimelineWarning();

    expectConsole("error", /Failed to connect to LiveKit/);
    expect(logs.find("Failed to connect to LiveKit")[0]).toMatchObject({
      level: "error",
      data: { url: "/livekit" },
    });
    expect(ctx.rooms[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.onError).toHaveBeenCalledExactlyOnceWith(voiceText("join.connectionError"));
    expect(voiceJoinSnapshot().lastJoins[0]).toMatchObject({ succeeded: false, stage: "activate" });
  });

  it("names an empty URL when the room could not even be built", async () => {
    const logs = captureLogs();
    const ctx = setup();
    ctx.host.createRoom.mockRejectedValueOnce(new Error("no worker"));

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe(false);
    expectTimelineWarning();

    expectConsole("error", /Failed to connect to LiveKit/);
    expect((logs.find("Failed to connect to LiveKit")[0]!.data as { url: string }).url).toBe("");
    expect(ctx.onError).not.toHaveBeenCalled();
    expect(ctx.host.leaveVoice).toHaveBeenCalledExactlyOnceWith(true, false);
    expect(vi.mocked(leaveVoiceChannel)).toHaveBeenCalledTimes(1);
  });

  it("goes on to tell the member when releasing the room throws", async () => {
    const logs = captureLogs();
    const ctx = setup();
    ctx.host.restoreLocalVoiceState.mockRejectedValueOnce(new Error("restore failed"));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        removeEventListener: () => {
          throw new Error("listener table gone");
        },
      },
    });

    try {
      await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe(false);
    } finally {
      Reflect.deleteProperty(navigator, "mediaDevices");
    }
    expectTimelineWarning();

    expectConsole("error", /Failed to connect to LiveKit/);
    expect(logs.find("Room disconnect during error cleanup failed (safe to ignore)")).toHaveLength(
      1,
    );
    expect(ctx.onError).toHaveBeenCalledExactlyOnceWith(voiceText("join.connectionError"));
  });

  it("leaves a newer attempt's session and the timeline alone when it is superseded", async () => {
    const ctx = setup();
    ctx.host.restoreLocalVoiceState.mockImplementationOnce(async () => {
      ctx.newerAttempt();
      throw new Error("restore failed");
    });
    const before = lastJoinCount();

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe(false);

    expectConsole("error", /Failed to connect to LiveKit/);
    expect(ctx.host.leaveVoice).not.toHaveBeenCalled();
    expect(vi.mocked(leaveVoiceChannel)).not.toHaveBeenCalled();
    expect(joinRetryInMs()).toBe(0);
    expect(lastJoinCount()).toBe(before);
    expect(ctx.getState()).toEqual({ type: "connecting", pendingJoin: null, joinGeneration: 99 });
  });

  it("keeps a queued join and does not leave the channel when the connect fails", async () => {
    const ctx = setup();
    const queued = { token: "t2", url: "/livekit", channelId: 4 };
    ctx.host.resolveLiveKitUrl.mockImplementationOnce(async () => {
      const current = ctx.getState();
      if (current.type === "connecting") ctx.host.setState({ ...current, pendingJoin: queued });
      throw new Error("proxy refused");
    });

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe(false);
    expectTimelineWarning();

    expectConsole("error", /Failed to connect to LiveKit/);
    expect(ctx.host.leaveVoice).not.toHaveBeenCalled();
    expect(vi.mocked(leaveVoiceChannel)).not.toHaveBeenCalled();
    expect(ctx.getState()).toMatchObject({ type: "connecting", pendingJoin: queued });
  });

  it("returns the state to idle only while this attempt still owns it and nothing is queued", async () => {
    const ctx = setup();
    ctx.host.restoreLocalVoiceState.mockImplementationOnce(async () => {
      ctx.host.setState({ type: "idle" });
    });

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe("superseded");

    expect(ctx.getState()).toEqual({ type: "idle" });
  });
});

describe("the session state when a join ends", () => {
  it("returns to idle when the attempt that still owns the state fails", async () => {
    const ctx = setup();
    ctx.host.leaveVoice.mockImplementation(() => {});
    ctx.e2ee.setupKeyExchange.mockResolvedValueOnce(false);

    await expect(ctx.join.connectAndSetup("t", "/livekit", 6)).resolves.toBe(false);
    expectConsole("warn", /voice join timeline/);

    expect(ctx.getState()).toEqual({ type: "idle" });
  });
});

const connectedState = (room: Room, channelId = 1): SessionState => ({
  type: "connected",
  room,
  channelId,
  latestToken: "old",
  lastUrl: "u",
  lastDirectUrl: undefined,
});

/** connectAndSetup that runs `steps[n]` on its nth call and never runs away. */
const scripted = (ctx: ReturnType<typeof setup>, steps: Array<() => void>) => {
  let n = 0;
  ctx.host.connectAndSetup.mockImplementation(async () => {
    if (n >= 6) throw new Error("drain did not stop");
    steps[n++]?.();
    return true as const;
  });
};

const queueAfter = (
  ctx: ReturnType<typeof setup>,
  pendingJoin: { token: string; url: string; channelId: number },
): void => {
  ctx.host.setState({ type: "connecting", pendingJoin, joinGeneration: 1 });
};

/** The session turns out connected to `current` as the queue is read. */
const connectedWhenQueueIsRead = (ctx: ReturnType<typeof setup>, current: SessionState): void => {
  const original = ctx.host.setState.getMockImplementation()!;
  ctx.host.setState.mockImplementation((state: SessionState) => {
    original(state);
    if (state.type === "connecting" && state.pendingJoin === null) {
      original(current);
      ctx.host.setState.mockImplementation(original);
    }
  });
};

describe("handleVoiceToken", () => {
  it("rejoins instead of refreshing when the SDK has given up on the room", async () => {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 1 }));
    const ctx = setup(connectedState(fakeRoom("disconnected")));

    await ctx.join.handleVoiceToken("new", "u", 1);

    expect(ctx.host.handleVoiceTokenRefresh).not.toHaveBeenCalled();
    expect(ctx.host.connectAndSetup).toHaveBeenCalledExactlyOnceWith(
      "new",
      "u",
      1,
      undefined,
      undefined,
    );
  });

  it("still refreshes a room that is only reconnecting", async () => {
    const ctx = setup(connectedState(fakeRoom("reconnecting")));

    await ctx.join.handleVoiceToken("new", "u", 1);

    expect(ctx.host.handleVoiceTokenRefresh).toHaveBeenCalledExactlyOnceWith("new");
    expect(ctx.host.connectAndSetup).not.toHaveBeenCalled();
  });

  it("logs a join it queues behind the attempt in flight", async () => {
    const logs = captureLogs();
    const ctx = setup({ type: "connecting", pendingJoin: null, joinGeneration: 1 });

    await ctx.join.handleVoiceToken("t", "u", 2);

    expectConsole("warn", /already connecting, queued latest join request/);
    expect(
      logs.find("handleVoiceToken: already connecting, queued latest join request")[0]!.data,
    ).toEqual({ channelId: 2 });
  });

  it("logs a token for a channel the member already left", async () => {
    const logs = captureLogs();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    const ctx = setup();

    await ctx.join.handleVoiceToken("t", "u", 2);

    expect(
      logs.find("handleVoiceToken: voice_token for a channel we already left — ignoring")[0]!.data,
    ).toEqual({ channelId: 2 });
  });

  describe("draining queued joins", () => {
    const next = { token: "t2", url: "u2", channelId: 4 };
    beforeEach(() => {
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 2 }));
    });

    it("connects each queued join once, in order, and leaves nothing queued", async () => {
      const ctx = setup();
      scripted(ctx, [
        () => queueAfter(ctx, next),
        () => queueAfter(ctx, { token: "t3", url: "u3", channelId: 5 }),
        () => {},
      ]);

      await ctx.join.handleVoiceToken("t", "u", 2);

      expect(ctx.host.connectAndSetup.mock.calls.map((c) => [c[0], c[2]])).toEqual([
        ["t", 2],
        ["t2", 4],
        ["t3", 5],
      ]);
      expect(ctx.getState()).toMatchObject({ type: "connecting", pendingJoin: null });
    });

    it("refreshes the token instead of rejoining when the session is already connected to the queued channel", async () => {
      const ctx = setup();
      scripted(ctx, [() => queueAfter(ctx, next)]);
      connectedWhenQueueIsRead(ctx, connectedState(fakeRoom("connected"), 4));

      await ctx.join.handleVoiceToken("t", "u", 2);

      expect(ctx.host.handleVoiceTokenRefresh).toHaveBeenCalledExactlyOnceWith("t2");
      expect(ctx.host.connectAndSetup).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["another channel", () => connectedState(fakeRoom("connected"), 9)],
      ["a room the SDK gave up on", () => connectedState(fakeRoom("disconnected"), 4)],
    ])("rejoins when the session is connected to %s", async (_n, current) => {
      const ctx = setup();
      scripted(ctx, [() => queueAfter(ctx, next), () => {}]);
      connectedWhenQueueIsRead(ctx, current());

      await ctx.join.handleVoiceToken("t", "u", 2);

      expect(ctx.host.handleVoiceTokenRefresh).not.toHaveBeenCalled();
      expect(ctx.host.connectAndSetup.mock.calls.map((c) => c[2])).toEqual([2, 4]);
    });
  });
});

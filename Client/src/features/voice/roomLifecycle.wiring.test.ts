/**
 * Room lifecycle wiring: the options a room is built with, the permission
 * handler that restores the microphone, the native room's capture settings
 * and the order of a full leave.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import { captureLogs } from "../../../tests/helpers/log-capture";
import { expectConsole } from "../../../tests/helpers/console";
import type { SessionState } from "./sessionState";

interface FakeRoom {
  options: { dynacast: boolean; publishDefaults: { videoEncoding: { maxFramerate: number } } };
  handlers: Map<string, (...args: unknown[]) => void>;
  localParticipant: {
    createTracks: (options: unknown) => Promise<Array<{ kind: string; stop: () => void }>>;
  };
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  setE2EEEnabled: ReturnType<typeof vi.fn>;
}

const env = vi.hoisted(() => ({
  linux: false,
  cameraQuality: "high",
  gated: false,
  prefs: new Map<string, unknown>(),
}));
const shared = vi.hoisted(() => ({
  createdTracks: [] as Array<{ kind: string; stop: () => void }>,
}));

vi.mock("livekit-client", () => {
  const Room = Object.assign(
    vi.fn(function (this: Record<string, unknown>, options: unknown) {
      this.options = options;
      this.handlers = new Map();
      this.on = (event: string, handler: (...args: unknown[]) => void) => {
        (this.handlers as Map<string, unknown>).set(event, handler);
      };
      this.off = vi.fn();
      this.disconnect = vi.fn(async () => {});
      this.setE2EEEnabled = vi.fn(async () => {});
      this.localParticipant = { createTracks: vi.fn(async () => shared.createdTracks) };
    }),
    { cleanupRegistry: undefined },
  );
  return {
    Room,
    RoomEvent: new Proxy({}, { get: (_t, key) => String(key) }),
    Track: { Kind: { Audio: "audio", Video: "video" } },
  };
});
vi.mock("../../stores/voice.store", () => ({
  setLocalCamera: vi.fn(),
  setLocalScreenshare: vi.fn(),
  setVoiceStatus: vi.fn(),
}));
vi.mock("../../lib/preferences", () => ({
  loadPref: (key: string, fallback: unknown) =>
    env.prefs.has(key) ? env.prefs.get(key) : fallback,
}));
vi.mock("../../lib/deviceManager", () => ({ isMicPolicyGated: () => env.gated }));
vi.mock("../../lib/livekitDiagnostics", () => ({ attachDiagnosticListeners: vi.fn() }));
vi.mock("./mediaControl", () => ({ syncShareGrant: vi.fn() }));
vi.mock("./native/platform", () => ({ isLinuxDesktop: () => env.linux }));
const createNativeRoom = vi.hoisted(() => vi.fn());
vi.mock("./native/nativeRoom", () => ({ createNativeRoom }));
vi.mock("../../lib/screenShare", () => ({
  CAMERA_PRESETS: { low: {}, high: {}, source: {} },
  CAMERA_PUBLISH_BITRATES: { low: 1, high: 2, source: 3 },
  getCameraQuality: () => env.cameraQuality,
  getScreenShareQuality: () => "medium",
  getScreenShareFps: () => 30,
  getEffectiveScreenShareFps: () => 30,
  getScreenShareMaxBitrate: () => 1,
  stopManualCameraTrack: vi.fn(),
  stopManualScreenTracks: vi.fn(),
  bumpGeneration: vi.fn(),
}));

const workers: Array<{ url: URL; terminate: ReturnType<typeof vi.fn> }> = [];
globalThis.Worker = vi.fn(function (this: { url: URL; terminate: () => void }, url: URL) {
  this.url = url;
  this.terminate = vi.fn();
  workers.push(this as { url: URL; terminate: ReturnType<typeof vi.fn> });
}) as unknown as typeof Worker;

import { setLocalCamera, setLocalScreenshare, setVoiceStatus } from "../../stores/voice.store";
import {
  bumpGeneration,
  stopManualCameraTrack,
  stopManualScreenTracks,
} from "../../lib/screenShare";
import { syncShareGrant } from "./mediaControl";
import { RoomLifecycle, type RoomLifecycleHost } from "./roomLifecycle";

function setup(initial: SessionState = { type: "idle" }) {
  let state = initial;
  let pendingMicRoom: Room | null = null;
  const eventHandlers = { removeAutoplayUnlock: vi.fn(), resetEncryptionRecovery: vi.fn() };
  const audioPipeline = {
    setRoom: vi.fn(),
    teardownAudioPipeline: vi.fn(),
    attach: vi.fn(async () => {}),
  };
  const audioElements = {
    setRoom: vi.fn(),
    cleanupAllAudioElementsFull: vi.fn(),
    getEffectiveVolume: () => 1,
    getScreenshareGain: () => 1,
    setScreenshareGainListener: vi.fn(),
  };
  const deviceManager = {
    setRoom: vi.fn(),
    setAudioPipeline: vi.fn(),
    setOnError: vi.fn(),
    setOnToast: vi.fn(),
  };
  const tokenManager = { resetBudget: vi.fn() };
  const cameraState = { manualCameraTrack: null };
  const screenState = { manualScreenTracks: [] };
  const ws = { send: vi.fn() };
  const e2ee = { keyProvider: { removeAllListeners: vi.fn() }, clearState: vi.fn() };
  const host = {
    getState: () => state,
    setState: vi.fn((next: SessionState) => {
      state = next;
    }),
    getRoom: () => (state.type === "connected" ? state.room : null),
    getWs: () => ws,
    getOnError: () => null,
    getE2EE: () => e2ee,
    getEventHandlers: () => eventHandlers,
    getAudioPipeline: () => audioPipeline,
    getAudioElements: () => audioElements,
    getDeviceManager: () => deviceManager,
    getTokenManager: () => tokenManager,
    getCameraState: () => cameraState,
    getScreenState: () => screenState,
    getPendingMicrophoneRoom: () => pendingMicRoom,
    setPendingMicrophoneRoom: vi.fn((room: Room | null) => {
      pendingMicRoom = room;
    }),
    clearPendingReconnectFields: vi.fn(),
    clearTokenRefreshTimer: vi.fn(),
    configuredAudioOptions: () => undefined,
    microphonePublishingAllowed: vi.fn(() => true),
    applyMicMuteState: vi.fn(async () => {}),
    dropDeniedVideo: vi.fn(),
  };
  const lifecycle = new RoomLifecycle(host as unknown as RoomLifecycleHost);
  const connect = (room: Room): void => {
    state = {
      type: "connected",
      room,
      channelId: 1,
      latestToken: "t",
      lastUrl: "u",
      lastDirectUrl: undefined,
    };
  };
  return {
    host,
    lifecycle,
    ws,
    e2ee,
    audioPipeline,
    audioElements,
    deviceManager,
    tokenManager,
    eventHandlers,
    cameraState,
    screenState,
    connect,
    setPendingMicRoom: (room: Room | null) => {
      pendingMicRoom = room;
    },
    getState: () => state,
  };
}

beforeEach(() => {
  workers.length = 0;
  env.linux = false;
  env.cameraQuality = "high";
  env.gated = false;
  env.prefs.clear();
  shared.createdTracks = [];
  vi.mocked(bumpGeneration).mockClear();
  vi.mocked(stopManualCameraTrack).mockClear();
  vi.mocked(stopManualScreenTracks).mockClear();
  vi.mocked(syncShareGrant).mockClear();
  vi.mocked(setLocalCamera).mockClear();
  vi.mocked(setLocalScreenshare).mockClear();
  vi.mocked(setVoiceStatus).mockClear();
  createNativeRoom.mockReset();
});

describe("session log", () => {
  it("logs the end of a session under the session's component", async () => {
    const logs = captureLogs();
    const ctx = setup();
    await ctx.lifecycle.leaveVoice(false);
    expect(logs.find("Left voice session")[0]!.component).toBe("livekitSession");
  });
});

describe("createRoom options", () => {
  it("loads the E2EE worker from livekit-client", async () => {
    const { lifecycle } = setup();
    await lifecycle.createRoom(1);
    expect(workers[0]!.url.href).toMatch(/livekit-client.*e2ee.*worker|e2ee.worker/);
  });

  it.each([
    ["low", true, 15],
    ["high", true, 30],
    ["source", false, 30],
  ])("builds a %s-quality room with dynacast %s and %s fps", async (quality, dynacast, fps) => {
    env.cameraQuality = quality;
    const { lifecycle } = setup();

    const room = (await lifecycle.createRoom(1)) as unknown as FakeRoom;

    expect(room.options.dynacast).toBe(dynacast);
    expect(room.options.publishDefaults.videoEncoding.maxFramerate).toBe(fps);
  });
});

describe("the microphone processor", () => {
  it("attaches the processor to the audio track whatever order the tracks come in", async () => {
    const { lifecycle, audioPipeline } = setup();
    const video = { kind: "video", stop: vi.fn() };
    const audio = { kind: "audio", stop: vi.fn() };
    shared.createdTracks = [video, audio];
    const room = (await lifecycle.createRoom(1)) as unknown as FakeRoom;

    await room.localParticipant.createTracks({ audio: true, video: true });

    expect(audioPipeline.attach).toHaveBeenCalledExactlyOnceWith(audio);
  });

  it("attaches nothing for a request that created no audio track", async () => {
    const { lifecycle, audioPipeline } = setup();
    shared.createdTracks = [{ kind: "video", stop: vi.fn() }];
    const room = (await lifecycle.createRoom(1)) as unknown as FakeRoom;

    await room.localParticipant.createTracks({ video: true });

    expect(audioPipeline.attach).not.toHaveBeenCalled();
  });

  it("stops every track it created when the processor cannot attach", async () => {
    const { lifecycle, audioPipeline } = setup();
    const video = { kind: "video", stop: vi.fn() };
    const audio = { kind: "audio", stop: vi.fn() };
    shared.createdTracks = [video, audio];
    audioPipeline.attach.mockRejectedValueOnce(new Error("no worklet"));
    const room = (await lifecycle.createRoom(1)) as unknown as FakeRoom;

    await expect(room.localParticipant.createTracks({ audio: true })).rejects.toThrow("no worklet");

    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(video.stop).toHaveBeenCalledTimes(1);
  });
});

describe("the native room's capture settings", () => {
  it("reads each processing switch from its own saved setting", async () => {
    env.linux = true;
    env.prefs.set("echoCancellation", false);
    env.prefs.set("noiseSuppression", false);
    env.prefs.set("autoGainControl", false);
    env.prefs.set("enhancedNoiseSuppression", true);
    createNativeRoom.mockReturnValue({
      on: vi.fn(),
      applyScreenshareVolumes: vi.fn(),
    });
    const { lifecycle } = setup();

    await lifecycle.createRoom(1);

    expect(createNativeRoom.mock.calls[0]![0]).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      enhancedNoiseSuppression: true,
    });
  });
});

describe("a change of the local participant's permissions", () => {
  async function connectedRoom() {
    const ctx = setup();
    const room = (await ctx.lifecycle.createRoom(1)) as unknown as FakeRoom;
    ctx.connect(room as unknown as Room);
    const handler = room.handlers.get("ParticipantPermissionsChanged")!;
    return {
      ...ctx,
      room,
      local: room.localParticipant,
      fire: (participant: unknown) => handler(undefined, participant),
    };
  }

  it("re-reads the share grant and drops video the grant no longer allows", async () => {
    const { fire, local, room, host } = await connectedRoom();

    fire(local);

    expect(syncShareGrant).toHaveBeenCalledExactlyOnceWith(room);
    expect(host.dropDeniedVideo).toHaveBeenCalledExactlyOnceWith(room);
  });

  it("ignores another participant's change", async () => {
    const { fire, room, host, setPendingMicRoom } = await connectedRoom();
    setPendingMicRoom(room as unknown as Room);

    fire({});

    expect(syncShareGrant).not.toHaveBeenCalled();
    expect(host.dropDeniedVideo).not.toHaveBeenCalled();
    expect(host.applyMicMuteState).not.toHaveBeenCalled();
    expect(host.setPendingMicrophoneRoom).not.toHaveBeenCalled();
  });

  it("ignores a room the session has moved on from", async () => {
    const { fire, local, room, host, setPendingMicRoom, connect } = await connectedRoom();
    setPendingMicRoom(room as unknown as Room);
    connect({} as Room);

    fire(local);

    expect(syncShareGrant).not.toHaveBeenCalled();
    expect(host.dropDeniedVideo).not.toHaveBeenCalled();
    expect(host.applyMicMuteState).not.toHaveBeenCalled();
  });

  it("restores the microphone once publishing is allowed for the room that was waiting", async () => {
    const { fire, local, room, host, setPendingMicRoom } = await connectedRoom();
    setPendingMicRoom(room as unknown as Room);

    fire(local);

    expect(host.setPendingMicrophoneRoom).toHaveBeenCalledExactlyOnceWith(null);
    expect(host.applyMicMuteState).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("restores nothing when no microphone was waiting for this room", async () => {
    const { fire, local, host, setPendingMicRoom } = await connectedRoom();
    setPendingMicRoom({} as Room);

    fire(local);

    expect(host.applyMicMuteState).not.toHaveBeenCalled();
    expect(host.setPendingMicrophoneRoom).not.toHaveBeenCalled();
  });

  it("keeps waiting while publishing is still not allowed", async () => {
    const { fire, local, room, host, setPendingMicRoom } = await connectedRoom();
    setPendingMicRoom(room as unknown as Room);
    host.microphonePublishingAllowed.mockReturnValue(false);

    fire(local);

    expect(host.applyMicMuteState).not.toHaveBeenCalled();
    expect(host.setPendingMicrophoneRoom).not.toHaveBeenCalled();
  });

  it("stops waiting but leaves the microphone off while the mic policy gates it", async () => {
    const { fire, local, room, host, setPendingMicRoom } = await connectedRoom();
    setPendingMicRoom(room as unknown as Room);
    env.gated = true;

    fire(local);

    expect(host.setPendingMicrophoneRoom).toHaveBeenCalledExactlyOnceWith(null);
    expect(host.applyMicMuteState).not.toHaveBeenCalled();
  });

  it("logs a failed restoration instead of rejecting", async () => {
    const logs = captureLogs();
    const { fire, local, room, host, setPendingMicRoom } = await connectedRoom();
    setPendingMicRoom(room as unknown as Room);
    host.applyMicMuteState.mockRejectedValueOnce(new Error("device busy"));

    fire(local);
    await vi.waitFor(() => expect(logs.find("Mic grant restoration failed")).toHaveLength(1));

    expect(logs.find("Mic grant restoration failed")[0]).toMatchObject({
      level: "warn",
      component: "livekitSession",
    });
    expectConsole("warn", /Mic grant restoration failed/);
  });
});

describe("leaveVoice", () => {
  async function liveSession() {
    const ctx = setup();
    const room = (await ctx.lifecycle.createRoom(1)) as unknown as FakeRoom;
    ctx.connect(room as unknown as Room);
    return { ...ctx, room };
  }

  it("tells the server by default and releases every collaborator", async () => {
    const logs = captureLogs();
    const ctx = await liveSession();

    await ctx.lifecycle.leaveVoice();

    expect(ctx.ws.send).toHaveBeenCalledExactlyOnceWith({ type: "voice_leave", payload: {} });
    expect(ctx.tokenManager.resetBudget).toHaveBeenCalledTimes(1);
    expect(ctx.host.clearTokenRefreshTimer).toHaveBeenCalledTimes(1);
    expect(ctx.audioPipeline.teardownAudioPipeline).toHaveBeenCalledTimes(1);
    expect(ctx.eventHandlers.removeAutoplayUnlock).toHaveBeenCalledTimes(1);
    expect(ctx.eventHandlers.resetEncryptionRecovery).toHaveBeenCalledTimes(1);
    expect(ctx.audioElements.cleanupAllAudioElementsFull).toHaveBeenCalledTimes(1);
    expect(ctx.room.disconnect).toHaveBeenCalledTimes(1);
    expect(logs.find("Left voice session")).toHaveLength(1);
    expect(logs.find("Left voice session")[0]!.component).toBe("livekitSession");
  });

  it("bumps both generations before stopping the manual tracks of the room it leaves", async () => {
    const ctx = await liveSession();

    await ctx.lifecycle.leaveVoice(false);

    expect(bumpGeneration).toHaveBeenCalledWith(ctx.cameraState);
    expect(bumpGeneration).toHaveBeenCalledWith(ctx.screenState);
    expect(stopManualCameraTrack).toHaveBeenCalledExactlyOnceWith(ctx.cameraState, ctx.room);
    expect(stopManualScreenTracks).toHaveBeenCalledExactlyOnceWith(ctx.screenState, ctx.room);
    const lastBump = Math.max(...vi.mocked(bumpGeneration).mock.invocationCallOrder);
    expect(lastBump).toBeLessThan(vi.mocked(stopManualCameraTrack).mock.invocationCallOrder[0]!);
    expect(lastBump).toBeLessThan(vi.mocked(stopManualScreenTracks).mock.invocationCallOrder[0]!);
  });

  it("drops the app's listeners before it disconnects the room", async () => {
    const ctx = await liveSession();
    ctx.room.handlers.clear();

    await ctx.lifecycle.leaveVoice(false);

    expect(ctx.room.off).toHaveBeenCalled();
    expect(ctx.room.off.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.room.disconnect.mock.invocationCallOrder[0]!,
    );
  });

  it("clears the display state and unwires the modules from the room", async () => {
    const ctx = await liveSession();

    await ctx.lifecycle.leaveVoice(false);

    expect(setVoiceStatus).toHaveBeenCalledWith("idle");
    expect(setLocalCamera).toHaveBeenCalledWith(false);
    expect(setLocalScreenshare).toHaveBeenCalledWith(false);
    expect(ctx.audioPipeline.setRoom).toHaveBeenLastCalledWith(null);
    expect(ctx.audioElements.setRoom).toHaveBeenLastCalledWith(null);
    expect(ctx.deviceManager.setRoom).toHaveBeenLastCalledWith(null);
    expect(ctx.deviceManager.setAudioPipeline).toHaveBeenLastCalledWith(null);
  });

  it("logs a disconnect that fails and still settles", async () => {
    const logs = captureLogs();
    const ctx = await liveSession();
    ctx.room.disconnect.mockRejectedValueOnce(new Error("native gone"));

    await expect(ctx.lifecycle.leaveVoice(false)).resolves.toBeUndefined();

    expect(logs.find("room.disconnect() error (non-fatal)")).toHaveLength(1);
    expectConsole("warn", /room\.disconnect\(\) error \(non-fatal\)/);
  });
});

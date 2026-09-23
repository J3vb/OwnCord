import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Room } from "livekit-client";
import type { SessionState } from "./sessionState";

vi.mock("livekit-client", () => ({
  Room: vi.fn(function (this: Record<string, unknown>, options: unknown) {
    this.options = options;
    this.on = vi.fn();
    this.setE2EEEnabled = vi.fn(async () => {});
  }),
  RoomEvent: {},
}));
vi.mock("../../stores/voice.store", () => ({
  setLocalCamera: vi.fn(),
  setLocalScreenshare: vi.fn(),
  setVoiceStatus: vi.fn(),
}));
vi.mock("../../components/settings/helpers", () => ({
  loadPref: (_key: string, fallback: unknown) => fallback,
}));
vi.mock("../../lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../lib/deviceManager", () => ({ isMicPolicyGated: () => false }));
vi.mock("../../lib/livekitDiagnostics", () => ({ attachDiagnosticListeners: vi.fn() }));
vi.mock("../../lib/screenShare", () => ({
  CAMERA_PRESETS: { high: {} },
  CAMERA_PUBLISH_BITRATES: { high: 1 },
  getStreamQuality: () => "high",
  getScreenShareFps: () => 30,
  getEffectiveScreenShareFps: () => 30,
  getScreenShareMaxBitrate: () => 1,
  stopManualCameraTrack: vi.fn(),
  stopManualScreenTracks: vi.fn(),
  bumpGeneration: vi.fn(),
}));

const workers: Array<{ terminate: ReturnType<typeof vi.fn> }> = [];
globalThis.Worker = vi.fn(function (this: { terminate: () => void }) {
  this.terminate = vi.fn();
  workers.push(this as { terminate: ReturnType<typeof vi.fn> });
}) as unknown as typeof Worker;

import { setVoiceStatus } from "../../stores/voice.store";
import { RoomLifecycle, type RoomLifecycleHost } from "./roomLifecycle";

function setup(initial: SessionState = { type: "idle" }) {
  let state = initial;
  const audioPipeline = { setRoom: vi.fn(), teardownAudioPipeline: vi.fn() };
  const audioElements = {
    setRoom: vi.fn(),
    cleanupAllAudioElementsFull: vi.fn(),
    getEffectiveVolume: (userId: number) => userId / 10,
    getScreenshareGain: (userId: number) => userId / 20,
    setScreenshareGainListener: vi.fn(),
  };
  const deviceManager = {
    setRoom: vi.fn(),
    setAudioPipeline: vi.fn(),
    setOnError: vi.fn(),
    setOnToast: vi.fn(),
  };
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
    getEventHandlers: () => ({ removeAutoplayUnlock: vi.fn() }),
    getAudioPipeline: () => audioPipeline,
    getAudioElements: () => audioElements,
    getDeviceManager: () => deviceManager,
    getTokenManager: () => ({ resetBudget: vi.fn() }),
    getCameraState: () => ({ manualCameraTrack: null }),
    getScreenState: () => ({ manualScreenTracks: [] }),
    getPendingMicrophoneRoom: () => null,
    setPendingMicrophoneRoom: vi.fn(),
    clearPendingReconnectFields: vi.fn(),
    clearTokenRefreshTimer: vi.fn(),
    configuredAudioOptions: () => undefined,
    microphonePublishingAllowed: () => true,
    applyMicMuteState: vi.fn(async () => {}),
  };
  const lifecycle = new RoomLifecycle(host as unknown as RoomLifecycleHost);
  return {
    host,
    lifecycle,
    ws,
    e2ee,
    audioPipeline,
    audioElements,
    deviceManager,
    getState: () => state,
  };
}

beforeEach(() => {
  workers.length = 0;
});

describe("syncModuleRooms", () => {
  it("wires every module to the given room", () => {
    const { lifecycle, audioPipeline, deviceManager } = setup();
    const room = {} as Room;
    lifecycle.syncModuleRooms(room);
    expect(audioPipeline.setRoom).toHaveBeenCalledWith(room);
    expect(deviceManager.setRoom).toHaveBeenCalledWith(room);
    expect(deviceManager.setAudioPipeline).toHaveBeenCalledWith(audioPipeline);
  });

  it("defaults to the state's room and unwires the pipeline when there is none", () => {
    const { lifecycle, deviceManager } = setup();
    lifecycle.syncModuleRooms();
    expect(deviceManager.setRoom).toHaveBeenCalledWith(null);
    expect(deviceManager.setAudioPipeline).toHaveBeenCalledWith(null);
  });
});

describe("createRoom", () => {
  it("replaces the previous room's E2EE worker and enables encryption", async () => {
    const { lifecycle, e2ee } = setup();
    const first = await lifecycle.createRoom(1);
    await lifecycle.createRoom(1);
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(workers[1]!.terminate).not.toHaveBeenCalled();
    expect(e2ee.keyProvider.removeAllListeners).toHaveBeenCalledTimes(2);
    expect(first.setE2EEEnabled).toHaveBeenCalledWith(true);
  });
});

describe("leaveVoice", () => {
  it("tears the session down to idle and kills the E2EE worker", async () => {
    const room = {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(async () => {}),
    } as unknown as Room;
    const { host, lifecycle, ws, e2ee, getState } = setup({
      type: "connected",
      room,
      channelId: 1,
      latestToken: "t",
      lastUrl: "u",
      lastDirectUrl: undefined,
    });
    await lifecycle.createRoom(1);
    lifecycle.leaveVoice(true);
    expect(ws.send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
    expect(room.disconnect).toHaveBeenCalled();
    expect(e2ee.clearState).toHaveBeenCalled();
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(host.clearPendingReconnectFields).toHaveBeenCalled();
    expect(host.setPendingMicrophoneRoom).toHaveBeenCalledWith(null);
    expect(getState()).toEqual({ type: "idle" });
    expect(setVoiceStatus).toHaveBeenCalledWith("idle");
  });

  it("aborts an in-flight reconnect and sends nothing when asked not to", () => {
    const ac = new AbortController();
    const { lifecycle, ws } = setup({
      type: "reconnecting",
      channelId: 1,
      latestToken: "t",
      lastUrl: "u",
      lastDirectUrl: undefined,
      ac,
    });
    lifecycle.leaveVoice(false);
    expect(ac.signal.aborted).toBe(true);
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("RoomLifecycle on the Linux native backend", () => {
  it("builds a NativeRoom with the same event wiring and no E2EE web worker", async () => {
    vi.resetModules();
    vi.doMock("./native/platform", () => ({ isLinuxDesktop: () => true }));
    const nativeRoom = {
      on: vi.fn(),
      disconnect: vi.fn(async () => {}),
      removeAllListeners: vi.fn(),
      applyScreenshareVolumes: vi.fn(),
    };
    const createNativeRoom = vi.fn(
      (
        _audio: unknown,
        _volumeOf: (identity: string) => number,
        _screenshareVolumeOf: (identity: string) => number,
      ) => nativeRoom,
    );
    vi.doMock("./native/nativeRoom", () => ({ createNativeRoom }));
    const { RoomLifecycle: LinuxLifecycle } = await import("./roomLifecycle");
    const { attachDiagnosticListeners: attach } = await import("../../lib/livekitDiagnostics");
    const { Room: WebRoom } = await import("livekit-client");
    const webRoomsBefore = vi.mocked(WebRoom).mock.calls.length;
    const ctx = setup();
    const lifecycle = new LinuxLifecycle(ctx.host as unknown as RoomLifecycleHost);
    const room = await lifecycle.createRoom(1);
    expect(room).toBe(nativeRoom);
    expect(createNativeRoom).toHaveBeenCalledWith(
      { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      expect.any(Function),
      expect.any(Function),
    );
    // Participants start at their saved per-user volume, keyed by user id.
    const volumeOf = createNativeRoom.mock.calls[0]![1];
    expect(volumeOf("user-7")).toBe(0.7);
    // Screen-share audio too, and a later change is re-read by the room.
    const screenshareVolumeOf = createNativeRoom.mock.calls[0]![2];
    expect(screenshareVolumeOf("user-7")).toBe(0.35);
    const listener = ctx.audioElements.setScreenshareGainListener.mock.calls[0]![0] as () => void;
    listener();
    expect(nativeRoom.applyScreenshareVolumes).toHaveBeenCalledTimes(1);
    expect(vi.mocked(WebRoom).mock.calls.length).toBe(webRoomsBefore);
    expect(workers).toHaveLength(0);
    // The same eight handlers the web room gets (RoomEvent is stubbed empty
    // here, so count the registrations rather than name them).
    expect(nativeRoom.on).toHaveBeenCalledTimes(8);
    expect(attach).toHaveBeenCalledWith(nativeRoom);
    vi.doUnmock("./native/platform");
    vi.doUnmock("./native/nativeRoom");
  });
});

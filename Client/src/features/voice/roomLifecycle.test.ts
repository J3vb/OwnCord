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
  const audioElements = { setRoom: vi.fn(), cleanupAllAudioElementsFull: vi.fn() };
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
  return { host, lifecycle, ws, e2ee, audioPipeline, deviceManager, getState: () => state };
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

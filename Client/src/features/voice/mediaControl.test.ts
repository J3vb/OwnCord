import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Room } from "livekit-client";

const store = vi.hoisted(() => ({
  localMuted: false,
  localDeafened: false,
  localServerMuted: false,
  localServerDeafened: false,
}));
const gate = vi.hoisted(() => ({ gated: false }));

vi.mock("livekit-client", () => ({
  Track: { Source: { Microphone: "microphone" }, sourceToProto: () => 2 },
}));
vi.mock("../../stores/voice.store", () => ({
  voiceStore: { getState: () => store },
  setLocalMuted: vi.fn(),
  setLocalDeafened: vi.fn(),
  setListenOnly: vi.fn(),
}));
vi.mock("../../components/settings/helpers", () => ({
  loadPref: (_key: string, fallback: unknown) => fallback,
}));
vi.mock("../../lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../lib/deviceManager", () => ({ isMicPolicyGated: () => gate.gated }));
vi.mock("../../lib/screenShare", () => ({}));

import { setLocalMuted, setListenOnly } from "../../stores/voice.store";
import { MediaControl, type MediaControlHost } from "./mediaControl";

type Permissions = { canPublish: boolean; canPublishSources: number[] } | undefined;

function fakeRoom(permissions: Permissions = undefined): Room {
  return {
    localParticipant: { permissions, setMicrophoneEnabled: vi.fn(async () => undefined) },
  } as unknown as Room;
}

function setup(room: Room | null = fakeRoom()) {
  let pending: Room | null = null;
  const audioPipeline = { setupAudioPipeline: vi.fn(), teardownAudioPipeline: vi.fn() };
  const audioElements = { applyRemoteAudioSubscriptionState: vi.fn() };
  const onError = vi.fn();
  const host = {
    getRoom: () => room,
    getCurrentChannelId: () => 5,
    getWs: () => null,
    getOnError: () => onError,
    getAudioPipeline: () => audioPipeline,
    getAudioElements: () => audioElements,
    getDeviceManager: () => ({}),
    getCameraState: () => ({ manualCameraTrack: null }),
    getScreenState: () => ({ manualScreenTracks: [] }),
    getPendingMicrophoneRoom: () => pending,
    setPendingMicrophoneRoom: (r: Room | null) => {
      pending = r;
    },
    configuredAudioOptions: vi.fn((): { audioPreset: { maxBitrate: number } } | undefined => ({
      audioPreset: { maxBitrate: 64000 },
    })),
  };
  const media = new MediaControl(host as unknown as MediaControlHost);
  return { host, media, audioPipeline, audioElements, onError, getPending: () => pending };
}

beforeEach(() => {
  Object.assign(store, {
    localMuted: false,
    localDeafened: false,
    localServerMuted: false,
    localServerDeafened: false,
  });
  gate.gated = false;
  vi.mocked(setLocalMuted).mockClear();
  vi.mocked(setListenOnly).mockClear();
});

describe("setMuted / setDeafened", () => {
  it("refuses to lift a moderator's server-mute", () => {
    store.localServerMuted = true;
    const { media } = setup();
    media.setMuted(false);
    expect(setLocalMuted).not.toHaveBeenCalled();
  });

  it("refuses to lift a moderator's server-deafen", () => {
    store.localServerDeafened = true;
    const { media, audioElements } = setup();
    media.setDeafened(false);
    expect(audioElements.applyRemoteAudioSubscriptionState).not.toHaveBeenCalled();
  });

  it("mutes the SDK microphone", async () => {
    const room = fakeRoom();
    const { media, audioPipeline } = setup(room);
    await media.applyMicMuteState(true);
    expect(audioPipeline.teardownAudioPipeline).toHaveBeenCalled();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
  });
});

describe("microphonePublishingAllowed", () => {
  it("allows when permissions are unknown or grant the microphone", () => {
    const { media } = setup();
    expect(media.microphonePublishingAllowed(fakeRoom())).toBe(true);
    expect(
      media.microphonePublishingAllowed(fakeRoom({ canPublish: true, canPublishSources: [] })),
    ).toBe(true);
    expect(
      media.microphonePublishingAllowed(fakeRoom({ canPublish: true, canPublishSources: [2] })),
    ).toBe(true);
  });

  it("refuses when publishing or the microphone source is withheld", () => {
    const { media } = setup();
    expect(
      media.microphonePublishingAllowed(fakeRoom({ canPublish: false, canPublishSources: [] })),
    ).toBe(false);
    expect(
      media.microphonePublishingAllowed(fakeRoom({ canPublish: true, canPublishSources: [3] })),
    ).toBe(false);
  });
});

describe("applyMicMuteState(false)", () => {
  it("publishes with the channel's configured audio bitrate", async () => {
    const room = fakeRoom();
    const { media, host, audioPipeline } = setup(room);
    await media.applyMicMuteState(false);
    expect(host.configuredAudioOptions).toHaveBeenCalledWith(5);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, undefined, {
      audioPreset: { maxBitrate: 64000 },
    });
    expect(audioPipeline.setupAudioPipeline).toHaveBeenCalled();
  });

  it("does not re-publish while the mic policy gate is closed", async () => {
    gate.gated = true;
    const room = fakeRoom();
    const { media } = setup(room);
    await media.applyMicMuteState(false);
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  it("waits for this room's SFU grant instead of publishing", async () => {
    const room = fakeRoom({ canPublish: false, canPublishSources: [] });
    const { media, getPending } = setup(room);
    await media.applyMicMuteState(false);
    expect(getPending()).toBe(room);
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  it("falls back to listen-only and muted when re-publishing fails", async () => {
    const room = fakeRoom();
    vi.mocked(room.localParticipant.setMicrophoneEnabled).mockRejectedValueOnce(
      new Error("device gone"),
    );
    const { media, onError } = setup(room);
    await media.applyMicMuteState(false);
    expect(setListenOnly).toHaveBeenCalledWith(true);
    expect(setLocalMuted).toHaveBeenCalledWith(true);
    expect(onError).toHaveBeenCalledWith("Microphone unavailable — you are muted");
  });
});

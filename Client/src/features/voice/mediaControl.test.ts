import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Room } from "livekit-client";

const store = vi.hoisted(() => ({
  localMuted: false,
  localDeafened: false,
  localServerMuted: false,
  localServerDeafened: false,
  inAfkChannel: false,
  localCamera: false,
  localScreenshare: false,
}));
const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
const loggerTags = vi.hoisted(() => [] as string[]);
const codecSwitch = vi.hoisted(() => ({
  kick: vi.fn(),
  stop: vi.fn(),
  options: null as null | {
    getCameraState(): unknown;
    getScreenState(): unknown;
    getDeps(): {
      getRoom(): unknown;
      getWs(): unknown;
      onError(message: string): void;
      reapplyAudioPipeline(): void;
    };
    readScreenSenderSample(): unknown;
    onSwitchError(err: unknown): void;
  },
}));
const gate = vi.hoisted(() => ({ gated: false }));

vi.mock("livekit-client", () => ({
  Track: {
    Source: { Microphone: "microphone", ScreenShare: "screen_share", Camera: "camera" },
    sourceToProto: (source: string) =>
      source === "screen_share" ? 3 : source === "camera" ? 1 : 2,
  },
}));
vi.mock("../../stores/voice.store", () => ({
  voiceStore: { getState: () => store },
  setLocalMuted: vi.fn(),
  setLocalDeafened: vi.fn(),
  setListenOnly: vi.fn(),
  setShareDenied: vi.fn(),
  bumpLocalCameraRev: vi.fn(),
}));
vi.mock("../../lib/prefs/preferences", () => ({
  loadPref: (_key: string, fallback: unknown) => fallback,
  savePref: vi.fn(),
}));
vi.mock("../../lib/logger", () => ({
  createLogger: (tag: string) => {
    loggerTags.push(tag);
    return log;
  },
}));
vi.mock("../../lib/deviceManager", () => ({ isMicPolicyGated: () => gate.gated }));
// The live codec switch has its own tests (codecSwitch.test.ts).
vi.mock("./codecSwitch", () => ({
  CodecSwitchController: class {
    constructor(options: NonNullable<typeof codecSwitch.options>) {
      codecSwitch.options = options;
    }
    kick(): void {
      codecSwitch.kick();
    }
    stop(): void {
      codecSwitch.stop();
    }
  },
}));
const changeScreenshareSource = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
const setScreenshareQuality = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock("./screenshareChange", () => ({ changeScreenshareSource, setScreenshareQuality }));
const setH264GpuProfiles = vi.hoisted(() => vi.fn());
vi.mock("../../lib/h264Profile", () => ({ setH264GpuProfiles }));
vi.mock("./videoCodec", () => ({ h264GpuPublish: (codec: string) => codec === "h264" }));
const inPlaceSource = vi.hoisted(() => ({ value: null as { changeSource: () => void } | null }));
vi.mock("../../lib/screenShare", () => ({
  enableCamera: vi.fn(async (..._args: unknown[]) => undefined),
  disableCamera: vi.fn(async (..._args: unknown[]) => undefined),
  enableScreenshare: vi.fn(async (..._args: unknown[]) => undefined),
  disableScreenshare: vi.fn(async (..._args: unknown[]) => undefined),
  reconcileVideoFlags: vi.fn(),
  inPlaceSourceChange: vi.fn(() => inPlaceSource.value),
  getLocalScreenshareStats: vi.fn((room: unknown) => ({ sampleOf: room })),
}));

import {
  setLocalMuted,
  setListenOnly,
  setShareDenied,
  bumpLocalCameraRev,
} from "../../stores/voice.store";
import { savePref } from "../../lib/prefs/preferences";
import {
  enableCamera,
  disableCamera,
  enableScreenshare,
  disableScreenshare,
  reconcileVideoFlags,
  inPlaceSourceChange,
} from "../../lib/screenShare";
import { CameraDeviceUnusable, CameraSwitchUnavailable } from "./cameraSwitch";
import { voiceText } from "../../i18n/voice";
import { MediaControl, syncShareGrant, type MediaControlHost } from "./mediaControl";

// Taken at load: the tag the module's logger was created with.
const mediaLoggerTags = [...loggerTags];

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function connectedWs(state = "connected") {
  return { getState: () => state, send: vi.fn() };
}

function setPermissions(room: Room, permissions: Permissions): void {
  (room.localParticipant as unknown as { permissions: Permissions }).permissions = permissions;
}

type Permissions = { canPublish: boolean; canPublishSources: number[] } | undefined;

function fakeRoom(permissions: Permissions = undefined): Room {
  return {
    localParticipant: { permissions, setMicrophoneEnabled: vi.fn(async () => undefined) },
  } as unknown as Room;
}

interface SetupExtras {
  ws?: { getState(): string; send: ReturnType<typeof vi.fn> } | null;
  channelId?: number | null;
  screen?: Record<string, unknown>;
}

function setup(
  room: Room | null = fakeRoom(),
  camera: { manualCameraTrack: unknown } = { manualCameraTrack: null },
  extras: SetupExtras = {},
) {
  let pending: Room | null = null;
  let current: Room | null = room;
  const audioPipeline = {
    setupAudioPipeline: vi.fn(),
    teardownAudioPipeline: vi.fn(),
    setInputVolume: vi.fn(),
    setVoiceSensitivity: vi.fn(),
    applyInputMode: vi.fn(),
    setPttGated: vi.fn(),
    reapplyAudioProcessing: vi.fn(async (..._args: unknown[]) => undefined),
    reapplyEnhancedNoiseSuppression: vi.fn(async (..._args: unknown[]) => undefined),
  };
  const audioElements = {
    applyRemoteAudioSubscriptionState: vi.fn(),
    setUserVolume: vi.fn(),
    getUserVolume: vi.fn(() => 0.5),
    setUserLocalMute: vi.fn(),
    getUserLocalMute: vi.fn(() => true),
    setScreenshareAudioVolume: vi.fn(),
    getScreenshareAudioVolume: vi.fn(() => 0.25),
    muteScreenshareAudio: vi.fn(),
    getScreenshareAudioMuted: vi.fn(() => true),
    setOutputVolume: vi.fn(),
  };
  const deviceManager = {
    switchInputDevice: vi.fn(async (..._args: unknown[]) => undefined),
    switchOutputDevice: vi.fn(async (..._args: unknown[]) => undefined),
  };
  const screen = extras.screen ?? { manualScreenTracks: [] };
  const onError = vi.fn();
  const host = {
    getRoom: () => current,
    getCurrentChannelId: () => (extras.channelId === undefined ? 5 : extras.channelId),
    getWs: () => extras.ws ?? null,
    getOnError: () => onError,
    getAudioPipeline: () => audioPipeline,
    getAudioElements: () => audioElements,
    getDeviceManager: () => deviceManager,
    getCameraState: () => camera,
    getScreenState: () => screen,
    getPendingMicrophoneRoom: () => pending,
    setPendingMicrophoneRoom: (r: Room | null) => {
      pending = r;
    },
    configuredAudioOptions: vi.fn((): { audioPreset: { maxBitrate: number } } | undefined => ({
      audioPreset: { maxBitrate: 64000 },
    })),
  };
  const media = new MediaControl(host as unknown as MediaControlHost);
  return {
    host,
    media,
    audioPipeline,
    audioElements,
    deviceManager,
    screen,
    camera,
    onError,
    getPending: () => pending,
    swapRoom: (next: Room | null) => {
      current = next;
    },
  };
}

beforeEach(() => {
  Object.assign(store, {
    localMuted: false,
    localDeafened: false,
    localServerMuted: false,
    localServerDeafened: false,
    inAfkChannel: false,
    localCamera: false,
    localScreenshare: false,
  });
  gate.gated = false;
  inPlaceSource.value = null;
  vi.mocked(setLocalMuted).mockClear();
  vi.mocked(setListenOnly).mockClear();
  for (const fn of [log.debug, log.info, log.warn, log.error]) fn.mockClear();
  codecSwitch.kick.mockClear();
  codecSwitch.stop.mockClear();
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
    // Mute leaves the processor on the track: no pipeline teardown.
    expect(audioPipeline.teardownAudioPipeline).not.toHaveBeenCalled();
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

describe("syncShareGrant", () => {
  it("marks share denied only when the grant leaves screen share out", () => {
    syncShareGrant(fakeRoom());
    expect(setShareDenied).toHaveBeenLastCalledWith(false);
    syncShareGrant(fakeRoom({ canPublish: true, canPublishSources: [2, 1] }));
    expect(setShareDenied).toHaveBeenLastCalledWith(true);
    syncShareGrant(fakeRoom({ canPublish: true, canPublishSources: [2, 3, 4] }));
    expect(setShareDenied).toHaveBeenLastCalledWith(false);
    syncShareGrant(fakeRoom({ canPublish: false, canPublishSources: [] }));
    expect(setShareDenied).toHaveBeenLastCalledWith(true);
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
    // Unmute keeps the processor the SDK restart carries over: no rebuild.
    expect(audioPipeline.setupAudioPipeline).not.toHaveBeenCalled();
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

function webTrack() {
  let mst = { addEventListener: vi.fn() };
  const track = {
    get mediaStreamTrack() {
      return mst;
    },
    setDeviceId: vi.fn(async (_id: string): Promise<boolean> => {
      mst = { addEventListener: vi.fn() };
      return true;
    }),
  };
  return track;
}

/** A native camera live on /dev/video0 whose in-place switch is refused. */
function nativeTrack(err: Error) {
  return {
    capture: 1,
    device: "/dev/video0",
    mediaStreamTrack: { addEventListener: vi.fn() },
    setDeviceId: vi.fn(async () => {
      throw err;
    }),
  };
}

describe("switchVideoDevice", () => {
  beforeEach(() => {
    vi.mocked(savePref).mockClear();
    vi.mocked(enableCamera).mockClear();
    vi.mocked(disableCamera).mockClear();
    vi.mocked(bumpLocalCameraRev).mockClear();
  });

  it("camera off: only saves the choice", async () => {
    const { media } = setup();
    await media.switchVideoDevice("cam-2");
    expect(savePref).toHaveBeenCalledWith("videoInputDevice", "cam-2");
    expect(enableCamera).not.toHaveBeenCalled();
    expect(bumpLocalCameraRev).not.toHaveBeenCalled();
  });

  it("an in-place switch to a new capture bumps the camera revision once", async () => {
    const track = webTrack();
    const { media } = setup(fakeRoom(), {
      manualCameraTrack: track,
      onCameraEnded: vi.fn(),
    } as never);
    await media.switchVideoDevice("cam-2");
    expect(bumpLocalCameraRev).toHaveBeenCalledTimes(1);
  });

  it("an in-place switch that keeps the same capture bumps nothing", async () => {
    const track = webTrack();
    track.setDeviceId.mockImplementationOnce(async () => true);
    const { media } = setup(fakeRoom(), { manualCameraTrack: track });
    await media.switchVideoDevice("cam-2");
    expect(bumpLocalCameraRev).not.toHaveBeenCalled();
  });

  it("a restart switch bumps the revision, a failed one does not", async () => {
    const { media } = setup(fakeRoom(), { manualCameraTrack: { capture: 1 } });
    await media.switchVideoDevice("/dev/video2");
    expect(bumpLocalCameraRev).toHaveBeenCalledTimes(1);

    const camera: { manualCameraTrack: unknown } = { manualCameraTrack: { capture: 1 } };
    vi.mocked(enableCamera).mockImplementationOnce(async () => {
      camera.manualCameraTrack = null;
    });
    const failing = setup(fakeRoom(), camera);
    await failing.media.switchVideoDevice("/dev/video9");
    expect(bumpLocalCameraRev).toHaveBeenCalledTimes(1);
  });

  it("camera on: moves the live track with setDeviceId and re-arms unplug detection", async () => {
    const track = webTrack();
    const onCameraEnded = vi.fn();
    const { media } = setup(fakeRoom(), { manualCameraTrack: track, onCameraEnded } as never);
    await media.switchVideoDevice("cam-2");
    expect(savePref).toHaveBeenCalledWith("videoInputDevice", "cam-2");
    expect(track.setDeviceId).toHaveBeenCalledWith("cam-2");
    expect(track.mediaStreamTrack.addEventListener).toHaveBeenCalledWith("ended", onCameraEnded, {
      once: true,
    });
    expect(enableCamera).not.toHaveBeenCalled();
  });

  it("carries an H.264 camera's GPU profiles over to the new capture", async () => {
    setH264GpuProfiles.mockClear();
    const track = webTrack();
    const { media } = setup(fakeRoom(), {
      manualCameraTrack: track,
      published: "h264",
    } as never);
    await media.switchVideoDevice("cam-2");
    expect(setH264GpuProfiles).toHaveBeenCalledWith(track.mediaStreamTrack, true);
  });

  it("native camera on: starts the capture again on the new device", async () => {
    const { media } = setup(fakeRoom(), { manualCameraTrack: { capture: 1 } });
    await media.switchVideoDevice("/dev/video2");
    expect(enableCamera).toHaveBeenCalledTimes(1);
    expect(disableCamera).not.toHaveBeenCalled();
  });

  it("native restart that fails tells the server the camera is off", async () => {
    const camera: { manualCameraTrack: unknown } = { manualCameraTrack: { capture: 1 } };
    // enableCamera stopped the old capture, then failed to start the new one.
    vi.mocked(enableCamera).mockImplementationOnce(async () => {
      camera.manualCameraTrack = null;
    });
    const { media } = setup(fakeRoom(), camera);
    await media.switchVideoDevice("/dev/video9");
    expect(disableCamera).toHaveBeenCalledTimes(1);
  });

  it("a picked camera that gives no picture keeps the live one and says so", async () => {
    const track = nativeTrack(new CameraDeviceUnusable("no frame"));
    const { media, onError } = setup(fakeRoom(), { manualCameraTrack: track });
    await media.switchVideoDevice("/dev/video2");
    expect(enableCamera).not.toHaveBeenCalled();
    expect(disableCamera).not.toHaveBeenCalled();
    expect(savePref).toHaveBeenLastCalledWith("videoInputDevice", "/dev/video0");
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      "Couldn't use that camera. Still using the previous one.",
    );
  });

  it("a restart the picked camera fails goes back to the previous camera", async () => {
    const camera: { manualCameraTrack: unknown } = {
      manualCameraTrack: nativeTrack(new CameraSwitchUnavailable("busy")),
    };
    vi.mocked(enableCamera)
      .mockImplementationOnce(async (_state, deps) => {
        camera.manualCameraTrack = null;
        deps.onError("Failed to start camera");
      })
      .mockImplementationOnce(async () => {
        camera.manualCameraTrack = { capture: 3 };
      });
    const { media, onError } = setup(fakeRoom(), camera);
    await media.switchVideoDevice("/dev/video2");
    expect(enableCamera).toHaveBeenCalledTimes(2);
    expect(savePref).toHaveBeenLastCalledWith("videoInputDevice", "/dev/video0");
    expect(disableCamera).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      "Couldn't use that camera. Still using the previous one.",
    );
    expect(bumpLocalCameraRev).toHaveBeenCalledTimes(1);
  });

  it("a pick made during a failing restart still goes back to the previous camera first", async () => {
    const camera: { manualCameraTrack: unknown } = {
      manualCameraTrack: nativeTrack(new CameraSwitchUnavailable("busy")),
    };
    const ref: { media?: MediaControl } = {};
    const saved: string[] = [];
    vi.mocked(savePref).mockImplementation((_key, value) => {
      saved.push(value as string);
    });
    vi.mocked(enableCamera)
      .mockImplementationOnce(async (_state, deps) => {
        // The user picks another camera while this one is still starting.
        void ref.media?.switchVideoDevice("/dev/video4");
        camera.manualCameraTrack = null;
        deps.onError("held");
      })
      .mockImplementationOnce(async () => {
        camera.manualCameraTrack = { capture: 3 };
      });
    const made = setup(fakeRoom(), camera);
    ref.media = made.media;
    await made.media.switchVideoDevice("/dev/video2");
    // Back on the previous camera, with the newer pick left as the choice.
    expect(saved).toEqual(["/dev/video2", "/dev/video4", "/dev/video0", "/dev/video4"]);
    expect(disableCamera).not.toHaveBeenCalled();
    expect(made.onError).not.toHaveBeenCalled();
    vi.mocked(savePref).mockReset();
  });

  it("an unusable pick with a newer pick queued says nothing and keeps the newer choice", async () => {
    const track = nativeTrack(new CameraDeviceUnusable("no frame"));
    const ref: { media?: MediaControl } = {};
    track.setDeviceId.mockImplementationOnce(async () => {
      void ref.media?.switchVideoDevice("/dev/video4");
      throw new CameraDeviceUnusable("no frame");
    });
    const made = setup(fakeRoom(), { manualCameraTrack: track });
    ref.media = made.media;
    await made.media.switchVideoDevice("/dev/video2");
    expect(savePref).toHaveBeenLastCalledWith("videoInputDevice", "/dev/video4");
    expect(made.onError).not.toHaveBeenCalled();
  });

  it("when the previous camera fails too, the camera goes off with the failure", async () => {
    const camera: { manualCameraTrack: unknown } = {
      manualCameraTrack: nativeTrack(new CameraSwitchUnavailable("busy")),
    };
    vi.mocked(enableCamera)
      .mockImplementationOnce(async (_state, deps) => {
        camera.manualCameraTrack = null;
        deps.onError("held");
      })
      .mockImplementationOnce(async (_state, deps) => {
        deps.onError("Failed to start camera");
      });
    const { media, onError } = setup(fakeRoom(), camera);
    await media.switchVideoDevice("/dev/video2");
    expect(enableCamera).toHaveBeenCalledTimes(2);
    expect(disableCamera).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith("Failed to start camera");
  });

  it("a restart on the picked camera that works shows no held message", async () => {
    const camera: { manualCameraTrack: unknown } = {
      manualCameraTrack: nativeTrack(new CameraSwitchUnavailable("busy")),
    };
    vi.mocked(enableCamera).mockImplementationOnce(async () => {
      camera.manualCameraTrack = { capture: 2 };
    });
    const { media, onError } = setup(fakeRoom(), camera);
    await media.switchVideoDevice("/dev/video2");
    expect(enableCamera).toHaveBeenCalledTimes(1);
    expect(savePref).toHaveBeenLastCalledWith("videoInputDevice", "/dev/video2");
    expect(onError).not.toHaveBeenCalled();
  });

  it("falls back to a restart when the in-place switch is unavailable", async () => {
    const track = webTrack();
    track.setDeviceId.mockRejectedValueOnce(new CameraSwitchUnavailable("busy"));
    const { media, onError } = setup(fakeRoom(), { manualCameraTrack: track });
    await media.switchVideoDevice("cam-2");
    expect(enableCamera).toHaveBeenCalledTimes(1);
    expect(disableCamera).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("a non-CameraSwitchUnavailable failure still disables the camera with cameraFailed", async () => {
    const track = webTrack();
    track.setDeviceId.mockRejectedValueOnce(new Error("boom"));
    const { media, onError } = setup(fakeRoom(), { manualCameraTrack: track });
    await media.switchVideoDevice("cam-2");
    expect(enableCamera).not.toHaveBeenCalled();
    expect(disableCamera).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalled();
  });

  it("a failed switch turns the camera off and says so", async () => {
    const track = webTrack();
    track.setDeviceId.mockRejectedValueOnce(new Error("busy"));
    const { media, onError } = setup(fakeRoom(), { manualCameraTrack: track });
    await media.switchVideoDevice("cam-2");
    expect(disableCamera).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalled();
  });

  it("runs switches one at a time, in order", async () => {
    const track = webTrack();
    const order: string[] = [];
    let release: (() => void) | null = null;
    track.setDeviceId.mockImplementationOnce(
      (id: string) =>
        new Promise<boolean>((r) => {
          order.push(`start ${id}`);
          release = () => {
            order.push(`end ${id}`);
            r(true);
          };
        }),
    );
    track.setDeviceId.mockImplementationOnce(async (id: string) => {
      order.push(`start ${id}`);
      return true;
    });
    const { media } = setup(fakeRoom(), { manualCameraTrack: track });
    const first = media.switchVideoDevice("a");
    await Promise.resolve();
    await Promise.resolve();
    const second = media.switchVideoDevice("b");
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start a"]);
    (release as (() => void) | null)?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["start a", "end a", "start b"]);
  });

  it("skips a queued pick that a newer pick replaced", async () => {
    const track = webTrack();
    let release: (() => void) | null = null;
    track.setDeviceId.mockImplementationOnce(
      () =>
        new Promise<boolean>((r) => {
          release = () => r(true);
        }),
    );
    const { media } = setup(fakeRoom(), { manualCameraTrack: track });
    const first = media.switchVideoDevice("a");
    await Promise.resolve();
    await Promise.resolve();
    const skipped = media.switchVideoDevice("b");
    const last = media.switchVideoDevice("c");
    (release as (() => void) | null)?.();
    await Promise.all([first, skipped, last]);
    expect(track.setDeviceId.mock.calls.map((c) => c[0])).toEqual(["a", "c"]);
    expect(savePref).toHaveBeenLastCalledWith("videoInputDevice", "c");
  });
});

describe("retryMicPermission", () => {
  it("does nothing without a room", async () => {
    const { media } = setup(null);
    await media.retryMicPermission();
    expect(setListenOnly).not.toHaveBeenCalled();
  });

  it("does nothing in the AFK channel, which grants no microphone", async () => {
    store.inAfkChannel = true;
    const room = fakeRoom();
    const { media } = setup(room);
    await media.retryMicPermission();
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(setListenOnly).not.toHaveBeenCalled();
  });

  it("leaves listen-only and unmutes once the microphone is granted", async () => {
    const room = fakeRoom();
    const { media } = setup(room);
    await media.retryMicPermission();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, undefined, {
      audioPreset: { maxBitrate: 64000 },
    });
    expect(setListenOnly).toHaveBeenCalledWith(false);
    expect(setLocalMuted).toHaveBeenCalledWith(false);
    expect(log.info).toHaveBeenCalledWith(
      "Microphone permission granted — exited listen-only mode",
    );
  });

  it("keeps the microphone muted while a mute, deafen or server-mute is in force", async () => {
    gate.gated = true;
    const room = fakeRoom();
    const { media } = setup(room);
    await media.retryMicPermission();
    expect(setListenOnly).toHaveBeenCalledWith(false);
    expect(setLocalMuted).not.toHaveBeenCalled();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    expect(log.info).toHaveBeenCalledWith(
      "Microphone acquired but muted (mute/deafen/server-mute active)",
    );
  });

  it("ignores a grant that lands after the call moved to another room", async () => {
    const room = fakeRoom();
    const made = setup(room);
    vi.mocked(room.localParticipant.setMicrophoneEnabled).mockImplementationOnce(async () => {
      made.swapRoom(fakeRoom());
    });
    await made.media.retryMicPermission();
    expect(setListenOnly).not.toHaveBeenCalled();
    expect(setLocalMuted).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("does not report a muted grant for a room the call left while it re-muted", async () => {
    gate.gated = true;
    const room = fakeRoom();
    const made = setup(room);
    vi.mocked(room.localParticipant.setMicrophoneEnabled)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        made.swapRoom(fakeRoom());
      });
    await made.media.retryMicPermission();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("reports a refused retry and stays in listen-only", async () => {
    const room = fakeRoom();
    const err = new Error("denied");
    vi.mocked(room.localParticipant.setMicrophoneEnabled).mockRejectedValueOnce(err);
    const { media, onError } = setup(room);
    await media.retryMicPermission();
    expect(log.warn).toHaveBeenCalledWith(
      "Microphone retry failed — still in listen-only mode",
      err,
    );
    expect(onError).toHaveBeenCalledWith(voiceText("mic.stillUnavailable"));
    expect(setListenOnly).not.toHaveBeenCalled();
  });

  it("says nothing about a refused retry for a room the call already left", async () => {
    const room = fakeRoom();
    const made = setup(room);
    vi.mocked(room.localParticipant.setMicrophoneEnabled).mockImplementationOnce(async () => {
      made.swapRoom(null);
      throw new Error("denied");
    });
    await made.media.retryMicPermission();
    expect(made.onError).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("mute and deafen policy", () => {
  it("logs why an unmute is refused and still allows muting", () => {
    store.localServerMuted = true;
    const { media } = setup();
    media.setMuted(false);
    expect(log.debug).toHaveBeenCalledWith("Ignoring unmute: server-muted by a moderator");
    media.setMuted(true);
    expect(setLocalMuted).toHaveBeenCalledWith(true);
  });

  it("keeps the AFK channel muted: unmute is refused, muting is not", () => {
    store.inAfkChannel = true;
    const { media } = setup();
    media.setMuted(false);
    expect(setLocalMuted).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("Ignoring unmute: AFK channel is listen-only");
    media.setMuted(true);
    expect(setLocalMuted).toHaveBeenCalledWith(true);
  });

  it("logs why an undeafen is refused and still allows deafening", () => {
    store.localServerDeafened = true;
    const { media, audioElements } = setup();
    media.setDeafened(false);
    expect(log.debug).toHaveBeenCalledWith("Ignoring undeafen: server-deafened by a moderator");
    media.setDeafened(true);
    expect(audioElements.applyRemoteAudioSubscriptionState).toHaveBeenCalledWith(true);
  });

  it("logs a failed microphone update from a mute", async () => {
    const room = fakeRoom();
    const err = new Error("sdk");
    vi.mocked(room.localParticipant.setMicrophoneEnabled).mockRejectedValueOnce(err);
    const { media } = setup(room);
    media.setMuted(true);
    await flush();
    expect(log.warn).toHaveBeenCalledWith("applyMicMuteState failed", err);
  });

  it("deafening mutes the microphone and logs the new state", async () => {
    const room = fakeRoom();
    const { media } = setup(room);
    media.setDeafened(true);
    await flush();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    expect(log.debug).toHaveBeenCalledWith("Deafen state changed", { deafened: true });
  });

  it("undeafening keeps a self-muted microphone muted", async () => {
    store.localMuted = true;
    const room = fakeRoom();
    const { media, audioElements } = setup(room);
    media.setDeafened(false);
    await flush();
    expect(audioElements.applyRemoteAudioSubscriptionState).toHaveBeenCalledWith(false);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    expect(log.debug).toHaveBeenCalledWith("Deafen state changed", { deafened: false });
  });

  it("logs a failed microphone update from a deafen change", async () => {
    const room = fakeRoom();
    const err = new Error("sdk");
    vi.mocked(room.localParticipant.setMicrophoneEnabled).mockRejectedValueOnce(err);
    const { media } = setup(room);
    media.setDeafened(true);
    await flush();
    expect(log.warn).toHaveBeenCalledWith("applyMicMuteState failed", err);
  });

  it("re-applies the mute when the audio pipeline resets while muted or deafened", async () => {
    const room = fakeRoom();
    const { media } = setup(room);
    media.reapplyMuteGain();
    await flush();
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();

    store.localMuted = true;
    media.reapplyMuteGain();
    await flush();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);

    store.localMuted = false;
    store.localDeafened = true;
    media.reapplyMuteGain();
    await flush();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(2);
  });

  it("logs a failed re-applied mute", async () => {
    store.localMuted = true;
    const room = fakeRoom();
    const err = new Error("sdk");
    vi.mocked(room.localParticipant.setMicrophoneEnabled).mockRejectedValueOnce(err);
    const { media } = setup(room);
    media.reapplyMuteGain();
    await flush();
    expect(log.warn).toHaveBeenCalledWith("applyMicMuteState failed", err);
  });
});

describe("applyMicMuteState details", () => {
  it("logs each way the microphone state moves", async () => {
    const room = fakeRoom();
    const { media } = setup(room);
    await media.applyMicMuteState(true);
    expect(log.debug).toHaveBeenCalledWith("Mic disabled (muted)");
    await media.applyMicMuteState(false);
    expect(log.debug).toHaveBeenCalledWith("Mic enabled (unmuted)");
    gate.gated = true;
    await media.applyMicMuteState(false);
    expect(log.debug).toHaveBeenCalledWith(
      "Skipping mic re-publish — still gated (mute/deafen/server-mute)",
    );
  });

  it("a mute clears a pending wait for the SFU grant", async () => {
    const room = fakeRoom({ canPublish: false, canPublishSources: [] });
    const { media, getPending } = setup(room);
    await media.applyMicMuteState(false);
    expect(getPending()).toBe(room);
    await media.applyMicMuteState(true);
    expect(getPending()).toBeNull();
  });

  it("does nothing without a room", async () => {
    const { media } = setup(null);
    await media.applyMicMuteState(false);
    await media.applyMicMuteState(true);
    expect(setListenOnly).not.toHaveBeenCalled();
  });

  it("reports nothing for an unmute that finished after the call moved rooms", async () => {
    const room = fakeRoom();
    const made = setup(room);
    vi.mocked(room.localParticipant.setMicrophoneEnabled).mockImplementationOnce(async () => {
      made.swapRoom(fakeRoom());
    });
    await made.media.applyMicMuteState(false);
    expect(log.debug).not.toHaveBeenCalledWith("Mic enabled (unmuted)");
  });

  it("falls back quietly for a publish that failed in a room the call already left", async () => {
    const room = fakeRoom();
    const made = setup(room);
    vi.mocked(room.localParticipant.setMicrophoneEnabled).mockImplementationOnce(async () => {
      made.swapRoom(fakeRoom());
      throw new Error("device gone");
    });
    await made.media.applyMicMuteState(false);
    expect(setListenOnly).not.toHaveBeenCalled();
    expect(setLocalMuted).not.toHaveBeenCalled();
    expect(made.onError).not.toHaveBeenCalled();
  });

  it("waits for the grant when a failed publish was the SFU withdrawing it", async () => {
    const room = fakeRoom();
    vi.mocked(room.localParticipant.setMicrophoneEnabled).mockImplementationOnce(async () => {
      setPermissions(room, { canPublish: false, canPublishSources: [] });
      throw new Error("not allowed");
    });
    const { media, getPending, onError } = setup(room);
    await media.applyMicMuteState(false);
    expect(getPending()).toBe(room);
    expect(setListenOnly).not.toHaveBeenCalled();
    expect(setLocalMuted).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("logs the refused publish and tells the server about the fallback mute", async () => {
    const room = fakeRoom();
    const err = new Error("device gone");
    vi.mocked(room.localParticipant.setMicrophoneEnabled).mockRejectedValueOnce(err);
    const ws = connectedWs();
    const { media } = setup(room, { manualCameraTrack: null }, { ws });
    await media.applyMicMuteState(false);
    expect(log.warn).toHaveBeenCalledWith(
      "Mic re-publish failed — falling back to listen-only/muted",
      err,
    );
    expect(ws.send).toHaveBeenCalledExactlyOnceWith({
      type: "voice_mute",
      payload: { muted: true },
    });
  });

  it("does not restate the fallback mute on a socket that is not connected", async () => {
    const room = fakeRoom();
    vi.mocked(room.localParticipant.setMicrophoneEnabled).mockRejectedValueOnce(new Error("x"));
    const ws = connectedWs("reconnecting");
    const { media } = setup(room, { manualCameraTrack: null }, { ws });
    await media.applyMicMuteState(false);
    expect(setListenOnly).toHaveBeenCalledWith(true);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("does not restate the fallback mute outside a voice channel", async () => {
    const room = fakeRoom();
    vi.mocked(room.localParticipant.setMicrophoneEnabled).mockRejectedValueOnce(new Error("x"));
    const ws = connectedWs();
    const { media } = setup(room, { manualCameraTrack: null }, { ws, channelId: null });
    await media.applyMicMuteState(false);
    expect(setListenOnly).toHaveBeenCalledWith(true);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("publishes without options when the channel has no audio configuration", async () => {
    const room = fakeRoom();
    const made = setup(room);
    made.host.configuredAudioOptions.mockReturnValueOnce(undefined);
    await made.media.enableMicrophone(room, true);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledExactlyOnceWith(true);
    await made.media.enableMicrophone(room, false);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    expect(made.host.configuredAudioOptions).toHaveBeenCalledTimes(1);
  });
});

describe("session wiring", () => {
  beforeEach(() => {
    vi.mocked(enableCamera).mockClear();
    vi.mocked(disableCamera).mockClear();
    vi.mocked(enableScreenshare).mockClear();
    vi.mocked(disableScreenshare).mockClear();
    vi.mocked(reconcileVideoFlags).mockClear();
    changeScreenshareSource.mockClear();
    setScreenshareQuality.mockClear();
  });

  it("logs under the session's tag", () => {
    expect(mediaLoggerTags).toContain("livekitSession");
    expect(mediaLoggerTags).not.toContain("");
  });

  it("hands the codec switch the live session state and reports its failures", () => {
    const room = fakeRoom();
    const ws = connectedWs();
    const made = setup(room, { manualCameraTrack: null }, { ws });
    const options = codecSwitch.options;
    if (options === null) throw new Error("codec switch was not built");
    expect(options.getCameraState()).toBe(made.camera);
    expect(options.getScreenState()).toBe(made.screen);
    expect(options.readScreenSenderSample()).toEqual({ sampleOf: room });
    const deps = options.getDeps();
    expect(deps.getRoom()).toBe(room);
    expect(deps.getWs()).toBe(ws);
    deps.onError("camera broke");
    expect(made.onError).toHaveBeenCalledWith("camera broke");
    const err = new Error("switch");
    options.onSwitchError(err);
    expect(log.warn).toHaveBeenCalledWith("Codec switch failed", err);
  });

  it("track deps re-apply the mute after a track change", async () => {
    store.localMuted = true;
    const room = fakeRoom();
    const made = setup(room);
    await made.media.enableScreenshare();
    const deps = vi.mocked(enableScreenshare).mock.calls[0]?.[1];
    expect(vi.mocked(enableScreenshare).mock.calls[0]?.[0]).toBe(made.screen);
    deps?.reapplyAudioPipeline();
    await flush();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
  });

  it("kicks the codec switch after a camera or share finished starting", async () => {
    const order: string[] = [];
    vi.mocked(enableCamera).mockImplementationOnce(async () => {
      order.push("camera on");
    });
    vi.mocked(enableScreenshare).mockImplementationOnce(async () => {
      order.push("share on");
    });
    codecSwitch.kick.mockImplementation(() => {
      order.push("kick");
    });
    const { media } = setup();
    await media.enableCamera();
    await media.enableScreenshare();
    codecSwitch.kick.mockReset();
    expect(order).toEqual(["camera on", "kick", "share on", "kick"]);
  });

  it("stops the codec switch when the session ends", () => {
    const { media } = setup();
    media.stopCodecSwitch();
    expect(codecSwitch.stop).toHaveBeenCalledTimes(1);
  });

  it("passes the server's video flags to the reconcile", () => {
    const made = setup();
    made.media.reconcileVideoFlags(true, false);
    const call = vi.mocked(reconcileVideoFlags).mock.calls[0];
    expect(call?.[0]).toBe(made.camera);
    expect(call?.[1]).toBe(made.screen);
    expect(call?.[3]).toEqual({ camera: true, screenshare: false });
  });

  it("stops a camera and a share the grant no longer allows", () => {
    store.localCamera = true;
    store.localScreenshare = true;
    const room = fakeRoom({ canPublish: true, canPublishSources: [2] });
    const { media } = setup(room);
    media.dropDeniedVideo(room);
    expect(disableCamera).toHaveBeenCalledTimes(1);
    expect(disableScreenshare).toHaveBeenCalledTimes(1);
  });

  it("keeps a camera and a share the grant still allows", () => {
    store.localCamera = true;
    store.localScreenshare = true;
    const room = fakeRoom({ canPublish: true, canPublishSources: [1, 3] });
    const { media } = setup(room);
    media.dropDeniedVideo(room);
    expect(disableCamera).not.toHaveBeenCalled();
    expect(disableScreenshare).not.toHaveBeenCalled();
  });

  it("only stops what is on", () => {
    const room = fakeRoom({ canPublish: false, canPublishSources: [] });
    const { media } = setup(room);
    media.dropDeniedVideo(room);
    expect(disableCamera).not.toHaveBeenCalled();
    expect(disableScreenshare).not.toHaveBeenCalled();
  });

  it("ignores a grant change from a room the call is no longer in", () => {
    store.localCamera = true;
    store.localScreenshare = true;
    const stale = fakeRoom({ canPublish: false, canPublishSources: [] });
    const { media } = setup(fakeRoom());
    media.dropDeniedVideo(stale);
    expect(disableCamera).not.toHaveBeenCalled();
    expect(disableScreenshare).not.toHaveBeenCalled();
  });

  it("changes the share source and quality through the lazy module with the session state", async () => {
    const made = setup();
    await made.media.changeScreenshareSource();
    expect(changeScreenshareSource).toHaveBeenCalledTimes(1);
    expect(changeScreenshareSource.mock.calls[0]?.[0]).toBe(made.screen);
    await made.media.setScreenshareQuality("high");
    expect(setScreenshareQuality).toHaveBeenCalledTimes(1);
    expect(setScreenshareQuality.mock.calls[0]?.[0]).toBe(made.screen);
    expect(setScreenshareQuality.mock.calls[0]?.[2]).toBe("high");
  });

  it("reports the live share's quality, or null while nothing is published", () => {
    expect(setup().media.getScreenshareQuality()).toBeNull();
    const withQuality = setup(
      fakeRoom(),
      { manualCameraTrack: null },
      {
        screen: { manualScreenTracks: [], quality: "source" },
      },
    );
    expect(withQuality.media.getScreenshareQuality()).toBe("source");
  });

  it("can change the share source when it has a quality or the host can swap in place", () => {
    const none = setup();
    expect(none.media.canChangeScreenshareSource()).toBe(false);
    expect(inPlaceSourceChange).toHaveBeenLastCalledWith(none.screen);

    const withQuality = setup(
      fakeRoom(),
      { manualCameraTrack: null },
      {
        screen: { manualScreenTracks: [], quality: "low" },
      },
    );
    expect(withQuality.media.canChangeScreenshareSource()).toBe(true);

    inPlaceSource.value = { changeSource: vi.fn() };
    expect(setup().media.canChangeScreenshareSource()).toBe(true);
  });

  it("delegates device switches, volumes and pipeline controls to their owners", async () => {
    const made = setup();
    await made.media.switchInputDevice("mic-1");
    await made.media.switchOutputDevice("spk-1");
    expect(made.deviceManager.switchInputDevice).toHaveBeenCalledWith("mic-1");
    expect(made.deviceManager.switchOutputDevice).toHaveBeenCalledWith("spk-1");

    made.media.setUserVolume(3, 70);
    expect(made.audioElements.setUserVolume).toHaveBeenCalledWith(3, 70);
    expect(made.media.getUserVolume(3)).toBe(0.5);
    made.media.setUserLocalMute(3, true);
    expect(made.audioElements.setUserLocalMute).toHaveBeenCalledWith(3, true);
    expect(made.media.getUserLocalMute(3)).toBe(true);
    made.media.setScreenshareAudioVolume(3, 20);
    expect(made.audioElements.setScreenshareAudioVolume).toHaveBeenCalledWith(3, 20);
    expect(made.media.getScreenshareAudioVolume(3)).toBe(0.25);
    made.media.muteScreenshareAudio(3, true);
    expect(made.audioElements.muteScreenshareAudio).toHaveBeenCalledWith(3, true);
    expect(made.media.getScreenshareAudioMuted(3)).toBe(true);
    made.media.setOutputVolume(40);
    expect(made.audioElements.setOutputVolume).toHaveBeenCalledWith(40);

    made.media.setInputVolume(55);
    expect(made.audioPipeline.setInputVolume).toHaveBeenCalledWith(55);
    made.media.setVoiceSensitivity(12);
    expect(made.audioPipeline.setVoiceSensitivity).toHaveBeenCalledWith(12);
    made.media.applyInputMode();
    expect(made.audioPipeline.applyInputMode).toHaveBeenCalledTimes(1);
    made.media.setPttGated(true);
    expect(made.audioPipeline.setPttGated).toHaveBeenCalledWith(true);
    await made.media.reapplyAudioProcessing();
    expect(made.audioPipeline.reapplyAudioProcessing).toHaveBeenCalledWith(made.onError);
    await made.media.reapplyEnhancedNoiseSuppression();
    expect(made.audioPipeline.reapplyEnhancedNoiseSuppression).toHaveBeenCalledWith(made.onError);
  });
});

describe("switchVideoDevice details", () => {
  beforeEach(() => {
    vi.mocked(savePref).mockReset();
    vi.mocked(enableCamera).mockReset();
    vi.mocked(disableCamera).mockReset();
    vi.mocked(bumpLocalCameraRev).mockClear();
    setH264GpuProfiles.mockClear();
  });

  it("an unusable pick on a camera that cannot name its device keeps the saved choice", async () => {
    const track = webTrack();
    track.setDeviceId.mockRejectedValueOnce(new CameraDeviceUnusable("no frame"));
    const { media, onError } = setup(fakeRoom(), { manualCameraTrack: track });
    await media.switchVideoDevice("cam-2");
    expect(vi.mocked(savePref).mock.calls).toEqual([["videoInputDevice", "cam-2"]]);
    expect(onError).toHaveBeenCalledExactlyOnceWith(voiceText("share.cameraSwitchFailed"));
  });

  it("logs a pick that gave no picture", async () => {
    const err = new CameraDeviceUnusable("no frame");
    const track = nativeTrack(err);
    const { media } = setup(fakeRoom(), { manualCameraTrack: track });
    await media.switchVideoDevice("/dev/video2");
    expect(log.warn).toHaveBeenCalledWith(
      "Picked camera gave no picture, keeping the live one",
      err,
    );
  });

  it("logs when a camera restarted on another device than the one picked", async () => {
    const track = webTrack();
    track.setDeviceId.mockImplementationOnce(async () => false);
    const { media } = setup(fakeRoom(), { manualCameraTrack: track });
    await media.switchVideoDevice("cam-2");
    expect(log.warn).toHaveBeenCalledWith("Camera restarted on another device than the one picked");
  });

  it("logs a clean in-place switch and does not warn", async () => {
    const track = webTrack();
    const { media } = setup(fakeRoom(), { manualCameraTrack: track });
    await media.switchVideoDevice("cam-2");
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("Camera device switched");
  });

  it("logs the fallback to a restart and its outcome", async () => {
    const err = new CameraSwitchUnavailable("busy");
    const track = webTrack();
    track.setDeviceId.mockRejectedValueOnce(err);
    const { media } = setup(fakeRoom(), { manualCameraTrack: track });
    await media.switchVideoDevice("cam-2");
    expect(log.info).toHaveBeenCalledWith("In-place camera switch unavailable, restarting", err);
    expect(log.info).toHaveBeenCalledWith("Camera device switched");
  });

  it("logs a switch that failed", async () => {
    const err = new Error("boom");
    const track = webTrack();
    track.setDeviceId.mockRejectedValueOnce(err);
    const { media } = setup(fakeRoom(), { manualCameraTrack: track });
    await media.switchVideoDevice("cam-2");
    expect(log.warn).toHaveBeenCalledWith("Camera device switch failed", err);
  });

  it("a switch that fails after the camera was replaced neither stops nor reports", async () => {
    const track = webTrack();
    const camera: { manualCameraTrack: unknown } = { manualCameraTrack: track };
    track.setDeviceId.mockImplementationOnce(async () => {
      camera.manualCameraTrack = { capture: 9 };
      throw new Error("boom");
    });
    const { media, onError } = setup(fakeRoom(), camera);
    await media.switchVideoDevice("cam-2");
    expect(disableCamera).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps H.264 profiles and the unplug listener off a capture that did not change", async () => {
    const track = webTrack();
    track.setDeviceId.mockImplementationOnce(async () => true);
    const onCameraEnded = vi.fn();
    const { media } = setup(fakeRoom(), {
      manualCameraTrack: track,
      published: "h264",
      onCameraEnded,
    } as never);
    await media.switchVideoDevice("cam-2");
    expect(setH264GpuProfiles).not.toHaveBeenCalled();
    expect(track.mediaStreamTrack.addEventListener).not.toHaveBeenCalled();
  });

  it("leaves a new capture alone when the camera was replaced while it switched", async () => {
    const track = webTrack();
    const onCameraEnded = vi.fn();
    const camera: { manualCameraTrack: unknown; onCameraEnded: () => void } = {
      manualCameraTrack: track,
      onCameraEnded,
    };
    const swapCapture = track.setDeviceId.getMockImplementation();
    track.setDeviceId.mockImplementationOnce(async (id: string) => {
      camera.manualCameraTrack = { capture: 9 };
      return swapCapture?.(id) ?? true;
    });
    const { media } = setup(fakeRoom(), camera);
    const before = track.mediaStreamTrack;
    await media.switchVideoDevice("cam-2");
    // The capture did change, but the track is no longer the camera in use.
    expect(track.mediaStreamTrack).not.toBe(before);
    expect(track.mediaStreamTrack.addEventListener).not.toHaveBeenCalled();
    expect(bumpLocalCameraRev).not.toHaveBeenCalled();
  });

  it("redraws a new capture even when nothing listens for the camera ending", async () => {
    const track = webTrack();
    const { media } = setup(fakeRoom(), { manualCameraTrack: track });
    await media.switchVideoDevice("cam-2");
    expect(track.mediaStreamTrack.addEventListener).not.toHaveBeenCalled();
    expect(bumpLocalCameraRev).toHaveBeenCalledTimes(1);
  });

  it("a native restart of an unnamed camera that fails only stops the server's camera", async () => {
    const camera: { manualCameraTrack: unknown } = { manualCameraTrack: { capture: 1 } };
    vi.mocked(enableCamera).mockImplementationOnce(async () => {
      camera.manualCameraTrack = null;
    });
    const { media, onError } = setup(fakeRoom(), camera);
    await media.switchVideoDevice("/dev/video9");
    expect(enableCamera).toHaveBeenCalledTimes(1);
    expect(disableCamera).toHaveBeenCalledTimes(1);
    expect(vi.mocked(savePref).mock.calls).toEqual([["videoInputDevice", "/dev/video9"]]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("a restart that was replaced by a newer camera is not treated as failed", async () => {
    const camera: { manualCameraTrack: unknown; generation: number } = {
      manualCameraTrack: { capture: 1 },
      generation: 0,
    };
    vi.mocked(enableCamera).mockImplementationOnce(async () => {
      camera.manualCameraTrack = null;
      camera.generation = 1;
    });
    const { media } = setup(fakeRoom(), camera);
    await media.switchVideoDevice("/dev/video9");
    expect(disableCamera).not.toHaveBeenCalled();
    expect(bumpLocalCameraRev).toHaveBeenCalledTimes(1);
  });

  it("a restart that works shows the messages it held back", async () => {
    const camera: { manualCameraTrack: unknown } = {
      manualCameraTrack: nativeTrack(new CameraSwitchUnavailable("busy")),
    };
    vi.mocked(enableCamera).mockImplementationOnce(async (_state, deps) => {
      deps.onError("Camera is using a lower resolution");
      camera.manualCameraTrack = { capture: 2 };
    });
    const { media, onError } = setup(fakeRoom(), camera);
    await media.switchVideoDevice("/dev/video2");
    expect(onError).toHaveBeenCalledExactlyOnceWith("Camera is using a lower resolution");
  });

  it("a pick made while the previous camera is starting again is not overwritten", async () => {
    const camera: { manualCameraTrack: unknown } = {
      manualCameraTrack: nativeTrack(new CameraSwitchUnavailable("busy")),
    };
    const ref: { media?: MediaControl } = {};
    vi.mocked(enableCamera)
      .mockImplementationOnce(async () => {
        camera.manualCameraTrack = null;
      })
      .mockImplementationOnce(async () => {
        void ref.media?.switchVideoDevice("/dev/video4");
        camera.manualCameraTrack = { capture: 3 };
      });
    const made = setup(fakeRoom(), camera);
    ref.media = made.media;
    await made.media.switchVideoDevice("/dev/video2");
    await flush();
    expect(vi.mocked(savePref).mock.calls.at(-1)).toEqual(["videoInputDevice", "/dev/video4"]);
  });

  it("goes back to the previous camera, saved before it starts, and logs why", async () => {
    const camera: { manualCameraTrack: unknown } = {
      manualCameraTrack: nativeTrack(new CameraSwitchUnavailable("busy")),
    };
    let savedWhenRetried: unknown[] = [];
    vi.mocked(enableCamera)
      .mockImplementationOnce(async () => {
        camera.manualCameraTrack = null;
      })
      .mockImplementationOnce(async () => {
        savedWhenRetried = [...(vi.mocked(savePref).mock.calls.at(-1) ?? [])];
        camera.manualCameraTrack = { capture: 3 };
      });
    const { media } = setup(fakeRoom(), camera);
    await media.switchVideoDevice("/dev/video2");
    expect(savedWhenRetried).toEqual(["videoInputDevice", "/dev/video0"]);
    expect(log.warn).toHaveBeenCalledWith(
      "Camera restart on the picked device failed, starting the previous one",
    );
  });

  it("a pick made while the previous camera comes back stays the saved choice", async () => {
    const camera: { manualCameraTrack: unknown } = {
      manualCameraTrack: nativeTrack(new CameraSwitchUnavailable("busy")),
    };
    const ref: { media?: MediaControl } = {};
    vi.mocked(enableCamera)
      .mockImplementationOnce(async () => {
        void ref.media?.switchVideoDevice("/dev/video4");
        camera.manualCameraTrack = null;
      })
      .mockImplementationOnce(async () => {
        camera.manualCameraTrack = { capture: 3 };
      });
    const made = setup(fakeRoom(), camera);
    ref.media = made.media;
    await made.media.switchVideoDevice("/dev/video2");
    const calls = vi.mocked(savePref).mock.calls;
    expect(calls.map((c) => c[0])).toEqual(
      Array.from({ length: calls.length }, () => "videoInputDevice"),
    );
    expect(calls.map((c) => c[1])).toEqual([
      "/dev/video2",
      "/dev/video4",
      "/dev/video0",
      "/dev/video4",
    ]);
  });
});

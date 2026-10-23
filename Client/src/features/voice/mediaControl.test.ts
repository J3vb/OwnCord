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
  Track: {
    Source: { Microphone: "microphone", ScreenShare: "screen_share" },
    sourceToProto: (source: string) => (source === "screen_share" ? 3 : 2),
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
vi.mock("../../lib/preferences", () => ({
  loadPref: (_key: string, fallback: unknown) => fallback,
  savePref: vi.fn(),
}));
vi.mock("../../lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../lib/deviceManager", () => ({ isMicPolicyGated: () => gate.gated }));
// The live codec switch has its own tests (codecSwitch.test.ts).
vi.mock("./codecSwitch", () => ({
  CodecSwitchController: class {
    kick(): void {}
    stop(): void {}
  },
}));
const setH264GpuProfiles = vi.hoisted(() => vi.fn());
vi.mock("../../lib/h264Profile", () => ({ setH264GpuProfiles }));
vi.mock("./videoCodec", () => ({ h264GpuPublish: (codec: string) => codec === "h264" }));
vi.mock("../../lib/screenShare", () => ({
  enableCamera: vi.fn(async () => undefined),
  disableCamera: vi.fn(async () => undefined),
}));

import {
  setLocalMuted,
  setListenOnly,
  setShareDenied,
  bumpLocalCameraRev,
} from "../../stores/voice.store";
import { savePref } from "../../lib/preferences";
import { enableCamera, disableCamera } from "../../lib/screenShare";
import { CameraDeviceUnusable, CameraSwitchUnavailable } from "./cameraSwitch";
import { MediaControl, syncShareGrant, type MediaControlHost } from "./mediaControl";

type Permissions = { canPublish: boolean; canPublishSources: number[] } | undefined;

function fakeRoom(permissions: Permissions = undefined): Room {
  return {
    localParticipant: { permissions, setMicrophoneEnabled: vi.fn(async () => undefined) },
  } as unknown as Room;
}

function setup(
  room: Room | null = fakeRoom(),
  camera: { manualCameraTrack: unknown } = { manualCameraTrack: null },
) {
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
    getCameraState: () => camera,
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

describe("syncShareGrant (WP 1C-3)", () => {
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

// Tests for the track-publishing half of src/lib/voice/screenShare.ts, continued from camera.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/screenShareTracksMocks";
import process from "node:process";
import type { LocalTrack, LocalVideoTrack } from "livekit-client";
import { expectConsole } from "../../helpers/console";
import {
  bumpGeneration,
  disableCamera,
  disableScreenshare,
  enableCamera,
  enableScreenshare,
  stopManualCameraTrack,
  stopManualScreenTracks,
  rollbackPendingVideo,
  reconcileVideoFlags,
  CameraTrackState,
  ScreenTrackState,
  voiceStore,
  fakeVideoTrack,
  fakeAudioTrack,
  RoomRig,
  fakeRoom,
  fakeDeps,
  useScreenShareTracksHarness,
} from "../../helpers/screenShareTracksHarness";

vi.mock("@lib/voice/shareFps", (importOriginal) => mocks.voiceShareFpsMock(importOriginal));
vi.mock("@lib/voice/h264Profile", () => mocks.voiceH264ProfileMock());
vi.mock("../../../src/features/voice/videoCodec", (importOriginal) =>
  mocks.voiceVideoCodecMock(importOriginal),
);
vi.mock("livekit-client", (importOriginal) => mocks.livekitClientMock(importOriginal));
vi.mock("@lib/prefs/preferences", () => mocks.prefsPreferencesMock());
vi.mock("../../../src/features/voice/native/devices", () => mocks.nativeDevicesMock());

const {
  createLocalVideoTrack,
  createLocalScreenTracks,
  loadPref,
  offer120,
  setH264GpuProfiles,
  gpuProfiles,
} = mocks;

useScreenShareTracksHarness();

// ── rollbackPendingVideo ───────────────────────────────────────────────────
//
// dispatcher.ts's ERROR handler correlates a server refusal (FORBIDDEN,
// RATE_LIMITED, INTERNAL, ...) of a voice_camera/voice_screenshare enable
// with the already-published track via the envelope id ws.send() returns.

describe("rollbackPendingVideo", () => {
  it("registers a camera enable's envelope id and resolves it once", async () => {
    const rig = fakeRoom();
    createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());
    const deps = fakeDeps(rig.room);
    deps.wsSend.mockReturnValue("req-camera-1");

    await enableCamera({ manualCameraTrack: null }, deps);

    expect(rollbackPendingVideo("req-camera-1")).toBe("camera");
    // Single-use: a second refusal echoing the same id must not roll back
    // whatever is live by then.
    expect(rollbackPendingVideo("req-camera-1")).toBeUndefined();
  });

  it("registers a screenshare enable's envelope id", async () => {
    const rig = fakeRoom();
    createLocalScreenTracks.mockResolvedValue([fakeVideoTrack()]);
    const deps = fakeDeps(rig.room);
    deps.wsSend.mockReturnValue("req-screen-1");

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expect(rollbackPendingVideo("req-screen-1")).toBe("screen");
  });

  it("returns undefined for an id that was never registered", () => {
    expect(rollbackPendingVideo("never-seen")).toBeUndefined();
  });

  it("supersedes the previous camera enable's id when a new one starts", async () => {
    const rig = fakeRoom();
    createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());
    const deps = fakeDeps(rig.room);
    deps.wsSend.mockReturnValueOnce("req-1").mockReturnValueOnce("req-2");
    const state = { manualCameraTrack: null as LocalVideoTrack | null };

    await enableCamera(state, deps);
    await enableCamera(state, deps);

    // Only the latest in-flight camera enable can still be refused.
    expect(rollbackPendingVideo("req-1")).toBeUndefined();
    expect(rollbackPendingVideo("req-2")).toBe("camera");
  });
});

describe("video lifecycle across pending publication and session changes", () => {
  it.each(["camera", "screen"])(
    "does not let an old %s disable clear a new session",
    async (kind) => {
      const old = fakeRoom();
      const next = fakeRoom();
      let finishDisable!: () => void;
      (kind === "camera" ? old.setCameraEnabled : old.setScreenShareEnabled).mockReturnValue(
        new Promise<void>((resolve) => {
          finishDisable = resolve;
        }),
      );
      let activeRoom = old.room;
      const deps = { ...fakeDeps(old.room), getRoom: () => activeRoom };
      const state = {
        generation: 0,
        manualCameraTrack: null,
        manualScreenTracks: [] as LocalTrack[],
      };
      const stopping =
        kind === "camera" ? disableCamera(state, deps) : disableScreenshare(state, deps);
      // leaveVoice bumps generations before a fresh session takes ownership.
      bumpGeneration(state);
      activeRoom = next.room;
      const track = fakeVideoTrack();
      createLocalVideoTrack.mockResolvedValue(track);
      createLocalScreenTracks.mockResolvedValue([track]);
      await (kind === "camera" ? enableCamera(state, deps) : enableScreenshare(state, deps));
      deps.wsSend.mockClear();
      finishDisable();
      await stopping;
      expect(
        kind === "camera"
          ? voiceStore.getState().localCamera
          : voiceStore.getState().localScreenshare,
      ).toBe(true);
      expect(deps.wsSend).not.toHaveBeenCalled();
    },
  );

  it("does not start screen audio after OS stops video while publish is pending", async () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();
    Object.defineProperty(video.mediaStreamTrack, "readyState", { value: "live", writable: true });
    createLocalScreenTracks.mockResolvedValue([video, audio]);
    let finishPublish!: () => void;
    rig.publishTrack.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPublish = resolve;
        }),
    );
    const deps = fakeDeps(rig.room);
    const state = { manualScreenTracks: [] as LocalTrack[] };
    const enabling = enableScreenshare(state, deps);
    await vi.waitFor(() => expect(rig.publishTrack).toHaveBeenCalledTimes(1));
    Object.defineProperty(video.mediaStreamTrack, "readyState", { value: "ended" });
    (video.mediaStreamTrack as unknown as { dispatch: (name: string) => void }).dispatch("ended");
    finishPublish();
    await enabling;
    expect(rig.publishTrack).not.toHaveBeenCalledWith(audio, expect.anything());
    expect(voiceStore.getState().localScreenshare).toBe(false);
    expect(audio.stop).toHaveBeenCalled();
  });
});

it.each(["camera", "screen"])(
  "stops %s tracks and contains asynchronous unpublish failures",
  async (kind) => {
    const rig = fakeRoom();
    rig.unpublishTrack.mockRejectedValue(new Error("renegotiation failed after disconnect"));
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();
    const state = { manualCameraTrack: video, manualScreenTracks: [video, audio] as LocalTrack[] };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      if (kind === "camera") stopManualCameraTrack(state, rig.room);
      else stopManualScreenTracks(state, rig.room);
      expect(video.stop).toHaveBeenCalled();
      if (kind === "screen") expect(audio.stop).toHaveBeenCalled();
      // Let a rejected unpublish reach the host's unhandled-rejection turn.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expectConsole("warn", /\[screenShare\] Failed to unpublish stopped video track/);
      if (kind === "screen") {
        expectConsole("warn", /\[screenShare\] Failed to unpublish stopped video track/);
      }
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  },
);

it("does not publish capture that already ended before acquisition returned", async () => {
  const rig = fakeRoom();
  const video = fakeVideoTrack();
  const audio = fakeAudioTrack();
  Object.defineProperty(video.mediaStreamTrack, "readyState", { value: "ended" });
  createLocalScreenTracks.mockResolvedValue([video, audio]);
  const deps = fakeDeps(rig.room);
  await enableScreenshare({ manualScreenTracks: [] }, deps);
  expect(rig.publishTrack).not.toHaveBeenCalled();
  expect(video.stop).toHaveBeenCalled();
  expect(audio.stop).toHaveBeenCalled();
  expect(voiceStore.getState().localScreenshare).toBe(false);
});

it("detaches the previous share's ended listener before a replacement becomes live", async () => {
  const rig = fakeRoom();
  const old = fakeVideoTrack();
  const next = fakeVideoTrack();
  createLocalScreenTracks.mockResolvedValueOnce([old]).mockResolvedValueOnce([next]);
  const removeListener = vi.spyOn(old.mediaStreamTrack, "removeEventListener");
  const deps = fakeDeps(rig.room);
  const state = { manualScreenTracks: [] as LocalTrack[] };
  await enableScreenshare(state, deps);
  await disableScreenshare(state, deps);
  expect(removeListener).toHaveBeenCalledWith("ended", expect.any(Function));
  await enableScreenshare(state, deps);
  deps.wsSend.mockClear();
  (old.mediaStreamTrack as unknown as { dispatch: (name: string) => void }).dispatch("ended");
  await Promise.resolve();
  expect(state.manualScreenTracks).toEqual([next]);
  expect(next.stop).not.toHaveBeenCalled();
  expect(voiceStore.getState().localScreenshare).toBe(true);
  expect(deps.wsSend).not.toHaveBeenCalled();
});

// ── video codec ────────────────────────────────────────────────────────────

describe("video codec", () => {
  /** Saved prefs by key; anything unsaved reads as its fallback. */
  function prefs(saved: Record<string, unknown>): void {
    loadPref.mockImplementation((key: string, fallback: unknown) =>
      key in saved ? saved[key] : fallback,
    );
  }

  /** A captured video track whose settings report 1920x1080. */
  function capturedVideoTrack(): ReturnType<typeof fakeVideoTrack> {
    const track = fakeVideoTrack();
    (track.mediaStreamTrack as unknown as { getSettings: () => MediaTrackSettings }).getSettings =
      () => ({ width: 1920, height: 1080 });
    return track;
  }

  const encodingInfo = vi.fn();
  let getContext: { mockRestore(): void } | undefined;
  beforeEach(() => {
    encodingInfo.mockReset();
    Object.defineProperty(navigator, "mediaCapabilities", {
      value: { encodingInfo },
      configurable: true,
    });
    // Auto's GPU check: a non-Intel GPU, so a hardware probe can pick H.264.
    const UNMASKED_RENDERER_WEBGL = 0x9246;
    getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      getExtension: (name: string) =>
        name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL } : null,
      getParameter: () => "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)",
    } as unknown as WebGLRenderingContext);
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaCapabilities");
    getContext?.mockRestore();
  });

  it("publishes the camera as VP8 by default", async () => {
    prefs({});
    const rig = fakeRoom();
    createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());

    await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));

    expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({
      videoCodec: "vp8",
    });
  });

  /** A channel whose one other member reports it decodes VP8 only. */
  function withVp8OnlyPeer(): () => void {
    const before = voiceStore.getState();
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 4,
      voiceUsers: new Map([[4, new Map([[2, { userId: 2, username: "peer" } as never]])]]),
      peerVideoDecode: new Map([[2, ["vp8"]]]),
    }));
    return () => voiceStore.setState(() => before);
  }

  it("downgrades a saved H.264 camera to VP8 for a VP8-only channel peer", async () => {
    prefs({ videoCodec: "h264" });
    const restore = withVp8OnlyPeer();
    try {
      const rig = fakeRoom();
      createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());
      await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));
      expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({ videoCodec: "vp8" });
    } finally {
      restore();
    }
  });

  it("downgrades a saved H.264 share to VP8 for a VP8-only channel peer", async () => {
    prefs({ videoCodec: "h264" });
    const restore = withVp8OnlyPeer();
    try {
      const rig = fakeRoom();
      const video = fakeVideoTrack();
      createLocalScreenTracks.mockResolvedValue([video, fakeAudioTrack()]);
      await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));
      const videoOpts = rig.publishTrack.mock.calls.find((c) => c[0] === video)?.[1];
      expect(videoOpts).toMatchObject({ videoCodec: "vp8" });
    } finally {
      restore();
    }
  });

  it("publishes the camera with the saved codec", async () => {
    prefs({ videoCodec: "h264" });
    const rig = fakeRoom();
    createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());

    await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));

    expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({
      videoCodec: "h264",
    });
  });

  it("records the preferred and the published codec on the camera and the share, for the live switch", async () => {
    prefs({ videoCodec: "h264" });
    const restore = withVp8OnlyPeer();
    try {
      const rig = fakeRoom();
      createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());
      const camera: CameraTrackState = { manualCameraTrack: null };
      await enableCamera(camera, fakeDeps(rig.room));
      expect(camera).toMatchObject({ preferred: "h264", published: "vp8", quality: "medium" });

      createLocalScreenTracks.mockResolvedValue([fakeVideoTrack(), fakeAudioTrack()]);
      const screen: ScreenTrackState = { manualScreenTracks: [] };
      await enableScreenshare(screen, fakeDeps(rig.room));
      expect(screen).toMatchObject({ preferred: "h264", published: "vp8" });

      stopManualCameraTrack(camera, rig.room);
      stopManualScreenTracks(screen, rig.room);
      expect(camera.published).toBeUndefined();
      expect(screen.published).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("offers only H.264 Main/High for an H.264 share where the GPU profiles apply, before publishing", async () => {
    prefs({ videoCodec: "h264" });
    gpuProfiles.value = true;
    encodingInfo.mockResolvedValue({ supported: true, smooth: true, powerEfficient: true });
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    createLocalScreenTracks.mockResolvedValue([video, fakeAudioTrack()]);

    await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    expect(setH264GpuProfiles).toHaveBeenCalledWith(video.mediaStreamTrack, true);
    const publishOrder = rig.publishTrack.mock.invocationCallOrder[0]!;
    expect(setH264GpuProfiles.mock.invocationCallOrder[0]!).toBeLessThan(publishOrder);
  });

  it("marks an H.264 camera where the GPU profiles apply", async () => {
    prefs({ videoCodec: "h264" });
    gpuProfiles.value = true;
    encodingInfo.mockResolvedValue({ supported: true, smooth: true, powerEfficient: true });
    const rig = fakeRoom();
    const track = fakeVideoTrack();
    createLocalVideoTrack.mockResolvedValue(track);

    await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));

    expect(setH264GpuProfiles).toHaveBeenCalledWith(track.mediaStreamTrack, true);
  });

  it("unmarks a camera that publishes VP8, so its offer keeps every H.264 profile", async () => {
    prefs({ videoCodec: "vp8" });
    gpuProfiles.value = true;
    const rig = fakeRoom();
    const track = fakeVideoTrack();
    createLocalVideoTrack.mockResolvedValue(track);

    await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));

    expect(setH264GpuProfiles).toHaveBeenCalledWith(track.mediaStreamTrack, false);
    expect(rig.publishTrack).toHaveBeenCalled();
  });

  it("publishes the screen share's video with the saved codec, audio without", async () => {
    prefs({ videoCodec: "h264" });
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();
    createLocalScreenTracks.mockResolvedValue([video, audio]);

    await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    const videoOpts = rig.publishTrack.mock.calls.find((c) => c[0] === video)?.[1];
    expect(videoOpts).toMatchObject({ videoCodec: "h264" });
    const audioOpts = rig.publishTrack.mock.calls.find((c) => c[0] === audio)?.[1];
    expect(audioOpts).not.toHaveProperty("videoCodec");
  });

  it("on Auto probes the camera at its captured size, 30 fps and preset bitrate", async () => {
    prefs({ videoCodec: "auto" });
    encodingInfo.mockResolvedValue({ supported: true, smooth: true, powerEfficient: true });
    const rig = fakeRoom();
    createLocalVideoTrack.mockResolvedValue(capturedVideoTrack());

    await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));

    expect(encodingInfo).toHaveBeenCalledWith({
      type: "webrtc",
      video: expect.objectContaining({
        width: 1920,
        height: 1080,
        framerate: 30,
        bitrate: 1_700_000,
      }),
    });
    expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({ videoCodec: "h264" });
  });

  it("on Auto probes the screen share at its own frame rate and bitrate, separately from the camera", async () => {
    offer120.value = true;
    prefs({ videoCodec: "auto", screenShareQuality: "high", screenShareFps: 120 });
    encodingInfo.mockResolvedValue({ supported: true, smooth: false, powerEfficient: false });
    const rig = fakeRoom();
    const video = capturedVideoTrack();
    createLocalScreenTracks.mockResolvedValue([video]);

    await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    expect(encodingInfo).toHaveBeenCalledTimes(1);
    expect(encodingInfo).toHaveBeenCalledWith({
      type: "webrtc",
      video: expect.objectContaining({
        width: 1920,
        height: 1080,
        framerate: 120,
        bitrate: 12_000_000,
      }),
    });
    expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({ videoCodec: "vp8" });
  });

  it("at 120 fps a saved VP8 follows Auto's hardware rule", async () => {
    offer120.value = true;
    prefs({ videoCodec: "vp8", screenShareQuality: "high", screenShareFps: 120 });
    encodingInfo.mockResolvedValue({ supported: true, smooth: true, powerEfficient: true });
    const rig = fakeRoom();
    createLocalScreenTracks.mockResolvedValue([capturedVideoTrack()]);

    await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    expect(encodingInfo).toHaveBeenCalledTimes(1);
    expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({
      videoCodec: "h264",
      degradationPreference: "maintain-framerate",
    });
  });

  it("does not publish a camera turned off while Auto's probe is pending", async () => {
    prefs({ videoCodec: "auto" });
    let answer!: (info: MediaCapabilitiesInfo) => void;
    encodingInfo.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const rig = fakeRoom();
    const track = capturedVideoTrack();
    createLocalVideoTrack.mockResolvedValue(track);
    const deps = fakeDeps(rig.room);
    const state = { manualCameraTrack: null as LocalVideoTrack | null };

    const enabling = enableCamera(state, deps);
    await vi.waitFor(() => expect(encodingInfo).toHaveBeenCalled());
    await disableCamera(state, deps);
    answer({ supported: true, smooth: true, powerEfficient: true });
    await enabling;

    expect(rig.publishTrack).not.toHaveBeenCalled();
    expect(deps.wsSend).not.toHaveBeenCalledWith({
      type: "voice_camera",
      payload: { enabled: true },
    });
    expect(track.stop).toHaveBeenCalled();
    expect(voiceStore.getState().localCamera).toBe(false);
  });

  it("does not publish a screen share ended while Auto's probe is pending", async () => {
    prefs({ videoCodec: "auto" });
    let answer!: (info: MediaCapabilitiesInfo) => void;
    encodingInfo.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const rig = fakeRoom();
    const video = capturedVideoTrack();
    const audio = fakeAudioTrack();
    createLocalScreenTracks.mockResolvedValue([video, audio]);
    const deps = fakeDeps(rig.room);
    const state = { manualScreenTracks: [] as LocalTrack[] };

    const enabling = enableScreenshare(state, deps);
    await vi.waitFor(() => expect(encodingInfo).toHaveBeenCalled());
    await disableScreenshare(state, deps);
    answer({ supported: true, smooth: true, powerEfficient: true });
    await enabling;

    expect(rig.publishTrack).not.toHaveBeenCalled();
    expect(deps.wsSend).not.toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: true },
    });
    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });
});

// ── reconcileVideoFlags (WP 1C-8) ──────────────────────────────────────────

describe("reconcileVideoFlags", () => {
  const off = { camera: false, screenshare: false };

  async function liveCamera(rig: RoomRig, deps: ReturnType<typeof fakeDeps>) {
    const track = fakeVideoTrack();
    createLocalVideoTrack.mockResolvedValue(track);
    const state = { manualCameraTrack: null as LocalVideoTrack | null };
    await enableCamera(state, deps);
    deps.wsSend.mockClear();
    return state;
  }

  async function liveShare(rig: RoomRig, deps: ReturnType<typeof fakeDeps>) {
    createLocalScreenTracks.mockResolvedValue([fakeVideoTrack(), fakeAudioTrack()]);
    const state = { manualScreenTracks: [] as LocalTrack[] };
    await enableScreenshare(state, deps);
    deps.wsSend.mockClear();
    return state;
  }

  it("announces a live camera again when the server lost it, and a refusal rolls it back", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    deps.wsSend.mockReturnValue("req-1");
    const camera = await liveCamera(rig, deps);

    reconcileVideoFlags(camera, { manualScreenTracks: [] }, deps, off);

    expect(deps.wsSend).toHaveBeenCalledTimes(1);
    expect(deps.wsSend).toHaveBeenCalledWith({ type: "voice_camera", payload: { enabled: true } });
    deps.wsSend.mockReturnValue("req-2");
    reconcileVideoFlags(camera, { manualScreenTracks: [] }, deps, off);
    expect(rollbackPendingVideo("req-1")).toBeUndefined();
    expect(rollbackPendingVideo("req-2")).toBe("camera");
  });

  it("announces a live share again when the server lost it", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    deps.wsSend.mockReturnValue("req-3");
    const screen = await liveShare(rig, deps);

    reconcileVideoFlags({ manualCameraTrack: null }, screen, deps, off);

    expect(deps.wsSend).toHaveBeenCalledTimes(1);
    expect(deps.wsSend).toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: true },
    });
    expect(rollbackPendingVideo("req-3")).toBe("screen");
  });

  it("turns off a flag the server still holds for media already stopped", () => {
    const deps = fakeDeps(fakeRoom().room);

    reconcileVideoFlags({ manualCameraTrack: null }, { manualScreenTracks: [] }, deps, {
      camera: true,
      screenshare: true,
    });

    expect(deps.wsSend).toHaveBeenCalledWith({ type: "voice_camera", payload: { enabled: false } });
    expect(deps.wsSend).toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: false },
    });
  });

  it("sends nothing when the server already agrees", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const camera = await liveCamera(rig, deps);
    const screen = await liveShare(rig, deps);

    reconcileVideoFlags(camera, screen, deps, { camera: true, screenshare: true });
    reconcileVideoFlags({ manualCameraTrack: null }, { manualScreenTracks: [] }, deps, off);

    expect(deps.wsSend).not.toHaveBeenCalled();
  });

  it("leaves an enable still in flight to announce itself", async () => {
    const rig = fakeRoom();
    let publish!: () => void;
    rig.publishTrack.mockImplementation(() => new Promise<void>((r) => (publish = r)));
    const deps = fakeDeps(rig.room);
    createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());
    const camera = { manualCameraTrack: null as LocalVideoTrack | null };

    const enabling = enableCamera(camera, deps);
    await vi.waitFor(() => expect(publish).toBeDefined());
    reconcileVideoFlags(camera, { manualScreenTracks: [] }, deps, off);
    expect(deps.wsSend).not.toHaveBeenCalled();
    publish();
    await enabling;

    expect(deps.wsSend).toHaveBeenCalledTimes(1);
  });

  it("turns off a stale flag while the media room is still reconnecting", () => {
    const deps = fakeDeps(null);

    reconcileVideoFlags({ manualCameraTrack: null }, { manualScreenTracks: [] }, deps, {
      camera: true,
      screenshare: true,
    });

    expect(deps.wsSend).toHaveBeenCalledWith({ type: "voice_camera", payload: { enabled: false } });
    expect(deps.wsSend).toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: false },
    });
  });

  it("does nothing without a socket", () => {
    const deps = fakeDeps(fakeRoom().room, false);

    reconcileVideoFlags({ manualCameraTrack: null }, { manualScreenTracks: [] }, deps, {
      camera: true,
      screenshare: true,
    });

    expect(deps.wsSend).not.toHaveBeenCalled();
  });
});

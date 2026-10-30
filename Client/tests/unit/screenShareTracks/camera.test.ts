/**
 * Tests for the track-publishing half of src/lib/voice/screenShare.ts.
 *
 * The module sat at 61.1% statements: screen-share-fps.test.ts covers the
 * preset/bitrate helpers, but enableCamera, disableCamera, enableScreenshare,
 * disableScreenshare, the stopManual* helpers and the stream getters had no
 * coverage at all.
 *
 * The failure paths are the point. BUG-100 (stop the created track when publish
 * fails, or the camera light stays on with nothing published) and BUG-101
 * (honour the OS "Stop sharing" button) are both regressions that a happy-path
 * test would sail straight past.
 */
import { describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/screenShareTracksMocks";
import { Track } from "livekit-client";
import type { LocalTrack, LocalVideoTrack, Room } from "livekit-client";
import { expectConsole } from "../../helpers/console";
import {
  disableCamera,
  enableCamera,
  getLocalCameraStream,
  getLocalScreenshareStream,
  getLocalScreenshareStats,
  stopManualCameraTrack,
  stopManualScreenTracks,
  CameraTrackState,
  ScreenTrackState,
  voiceStore,
  fakeVideoTrack,
  fakeAudioTrack,
  fakeRoom,
  fakeNativeRoom,
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

const { createLocalVideoTrack, loadPref, nativeCameraSupport } = mocks;

useScreenShareTracksHarness();

// ── stopManualCameraTrack ──────────────────────────────────────────────────

describe("stopManualCameraTrack", () => {
  it("unpublishes and stops the track", () => {
    const rig = fakeRoom();
    const track = fakeVideoTrack();
    const state = { manualCameraTrack: track };

    stopManualCameraTrack(state, rig.room);

    expect(rig.unpublishTrack).toHaveBeenCalledWith(track.mediaStreamTrack);
    expect(track.stop).toHaveBeenCalled();
    expect(state.manualCameraTrack).toBeNull();
  });

  it("forgets the announced track, so the left room is not kept reachable", () => {
    const rig = fakeRoom();
    const track = fakeVideoTrack();
    const state: CameraTrackState = { manualCameraTrack: track, announced: track };

    stopManualCameraTrack(state, rig.room);

    expect(state.announced).toBeUndefined();
  });

  it("is a no-op with no track", () => {
    const rig = fakeRoom();

    stopManualCameraTrack({ manualCameraTrack: null }, rig.room);

    expect(rig.unpublishTrack).not.toHaveBeenCalled();
  });

  it("is a no-op with no room", () => {
    const track = fakeVideoTrack();
    const state = { manualCameraTrack: track };

    stopManualCameraTrack(state, null);

    expect(track.stop).not.toHaveBeenCalled();
    expect(state.manualCameraTrack).toBe(track);
  });

  it("still stops the track when unpublish throws", () => {
    const rig = fakeRoom();
    rig.unpublishTrack.mockImplementation(() => {
      throw new Error("already unpublished");
    });
    const track = fakeVideoTrack();

    stopManualCameraTrack({ manualCameraTrack: track }, rig.room);

    // Stopping is what releases the hardware; it must not be skipped because
    // the unpublish leg failed.
    expect(track.stop).toHaveBeenCalled();
  });
});

// ── enableCamera ───────────────────────────────────────────────────────────

describe("enableCamera", () => {
  it("publishes the camera track and announces it over the websocket", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const track = fakeVideoTrack();
    createLocalVideoTrack.mockResolvedValue(track);
    const state = { manualCameraTrack: null as LocalVideoTrack | null };

    await enableCamera(state, deps);

    expect(rig.publishTrack).toHaveBeenCalledWith(
      track,
      expect.objectContaining({ source: Track.Source.Camera }),
    );
    expect(deps.wsSend).toHaveBeenCalledWith({
      type: "voice_camera",
      payload: { enabled: true },
    });
    expect(deps.reapplyAudioPipeline).toHaveBeenCalled();
    expect(state.manualCameraTrack).toBe(track);
    expect(voiceStore.getState().localCamera).toBe(true);
  });

  it("uses the saved video input device when one is set", async () => {
    const rig = fakeRoom();
    loadPref.mockReturnValue("cam-2");
    createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());

    await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));

    expect(createLocalVideoTrack).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "cam-2" }),
    );
  });

  it("omits deviceId when no device is saved", async () => {
    const rig = fakeRoom();
    createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());

    await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));

    expect(createLocalVideoTrack.mock.calls[0]?.[0]).not.toHaveProperty("deviceId");
  });

  it("refuses when there is no voice session", async () => {
    const deps = fakeDeps(null);

    await enableCamera({ manualCameraTrack: null }, deps);

    expectConsole("warn", /\[screenShare\] Cannot enable camera: no active voice session/);
    expect(deps.onError).toHaveBeenCalledWith("Join a voice channel first");
    expect(createLocalVideoTrack).not.toHaveBeenCalled();
    expect(voiceStore.getState().localCamera).toBe(false);
  });

  it("refuses when the websocket is gone", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room, false);

    await enableCamera({ manualCameraTrack: null }, deps);

    expectConsole("warn", /\[screenShare\] Cannot enable camera: no active voice session/);
    expect(deps.onError).toHaveBeenCalledWith("Join a voice channel first");
  });

  it("reports missing native camera support instead of starting a capture", async () => {
    const rig = fakeNativeRoom();
    nativeCameraSupport.mockResolvedValue({ available: false, missing: ["v4l2src"] });
    const deps = fakeDeps(rig.room);

    await enableCamera({ manualCameraTrack: null }, deps);

    expectConsole("warn", /\[screenShare\] Cannot enable camera: native camera support is missing/);
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining("Camera support is missing"));
    expect(rig.createCameraTracks).not.toHaveBeenCalled();
    expect(voiceStore.getState().localCamera).toBe(false);
  });

  it("starts the native capture when support is available", async () => {
    const rig = fakeNativeRoom();
    const track = fakeVideoTrack();
    rig.createCameraTracks.mockResolvedValue([track]);
    const deps = fakeDeps(rig.room);

    await enableCamera({ manualCameraTrack: null }, deps);

    expect(nativeCameraSupport).toHaveBeenCalled();
    expect(rig.createCameraTracks).toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
    expect(voiceStore.getState().localCamera).toBe(true);
  });

  it("passes the default 720p preset's size to the native capture", async () => {
    const rig = fakeNativeRoom();
    rig.createCameraTracks.mockResolvedValue([fakeVideoTrack()]);

    await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));

    expect(rig.createCameraTracks).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: expect.objectContaining({ width: 1280, height: 720 }),
      }),
    );
  });

  it("leaves the native capture uncapped for the source quality", async () => {
    loadPref.mockImplementation((key: string) => (key === "streamQuality" ? "source" : ""));
    const rig = fakeNativeRoom();
    rig.createCameraTracks.mockResolvedValue([fakeVideoTrack()]);

    await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));

    expect(rig.createCameraTracks.mock.calls[0]?.[0]).not.toHaveProperty("resolution");
  });

  it("does not re-enable the camera when a disable lands during the support check", async () => {
    const rig = fakeNativeRoom();
    const deps = fakeDeps(rig.room);
    let resolveSupport!: (s: { available: boolean; missing: string[] }) => void;
    nativeCameraSupport.mockReturnValue(
      new Promise((resolve) => {
        resolveSupport = resolve;
      }),
    );
    const state = { manualCameraTrack: null as LocalVideoTrack | null };

    const enabling = enableCamera(state, deps);
    await vi.waitFor(() => {
      expect(nativeCameraSupport).toHaveBeenCalled();
    });
    await disableCamera(state, deps);
    resolveSupport({ available: true, missing: [] });
    await enabling;

    expect(rig.createCameraTracks).not.toHaveBeenCalled();
    expect(deps.wsSend).not.toHaveBeenCalledWith({
      type: "voice_camera",
      payload: { enabled: true },
    });
    expect(voiceStore.getState().localCamera).toBe(false);
  });

  it("marks the camera on before the support check so a second toggle disables it", async () => {
    const rig = fakeNativeRoom();
    const deps = fakeDeps(rig.room);
    let resolveSupport!: (s: { available: boolean; missing: string[] }) => void;
    nativeCameraSupport.mockReturnValue(
      new Promise((resolve) => {
        resolveSupport = resolve;
      }),
    );
    const state = { manualCameraTrack: null as LocalVideoTrack | null };

    const enabling = enableCamera(state, deps);
    await vi.waitFor(() => {
      expect(nativeCameraSupport).toHaveBeenCalled();
    });

    // A second click during the round-trip reads the camera as on, so
    // onCameraToggle routes it to disableCamera rather than re-entering here.
    expect(voiceStore.getState().localCamera).toBe(true);
    await disableCamera(state, deps);
    resolveSupport({ available: true, missing: [] });
    await enabling;

    expect(rig.createCameraTracks).not.toHaveBeenCalled();
    expect(voiceStore.getState().localCamera).toBe(false);
    expect(deps.wsSend).not.toHaveBeenCalledWith({
      type: "voice_camera",
      payload: { enabled: true },
    });
  });

  it("releases the created track when publishing fails", async () => {
    const rig = fakeRoom();
    const track = fakeVideoTrack();
    createLocalVideoTrack.mockResolvedValue(track);
    rig.publishTrack.mockRejectedValue(new Error("publish failed"));
    const deps = fakeDeps(rig.room);
    const state = { manualCameraTrack: null as LocalVideoTrack | null };

    await enableCamera(state, deps);

    expectConsole("error", /\[screenShare\] Failed to enable camera/);
    // Without this the camera indicator light stays on with nothing published.
    expect(track.stop).toHaveBeenCalled();
    expect(state.manualCameraTrack).toBeNull();
    expect(voiceStore.getState().localCamera).toBe(false);
    expect(deps.onError).toHaveBeenCalledWith("Failed to start camera");
  });

  it.each([
    ["NotAllowedError", "Camera permission denied"],
    ["NotFoundError", "No camera found"],
    ["OverconstrainedError", "Failed to start camera"],
  ])("maps a %s to a specific message", async (name, message) => {
    const rig = fakeRoom();
    createLocalVideoTrack.mockRejectedValue(new DOMException("nope", name));
    const deps = fakeDeps(rig.room);

    await enableCamera({ manualCameraTrack: null }, deps);

    expectConsole("error", /\[screenShare\] Failed to enable camera/);
    expect(deps.onError).toHaveBeenCalledWith(message);
  });

  it("stops a previously published track before publishing a new one", async () => {
    const rig = fakeRoom();
    const old = fakeVideoTrack();
    createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());

    await enableCamera({ manualCameraTrack: old }, fakeDeps(rig.room));

    expect(old.stop).toHaveBeenCalled();
  });

  it("discards the track and does not publish when disableCamera runs during device acquisition", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const track = fakeVideoTrack();
    let resolveTrack!: (t: LocalVideoTrack) => void;
    createLocalVideoTrack.mockReturnValue(
      new Promise((resolve) => {
        resolveTrack = resolve;
      }),
    );
    const state = { manualCameraTrack: null as LocalVideoTrack | null };

    const enabling = enableCamera(state, deps);
    // A concurrent disable runs to completion while createLocalVideoTrack is
    // still awaiting the permission prompt / device handshake.
    await disableCamera(state, deps);
    resolveTrack(track);
    await enabling;

    expect(rig.publishTrack).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(state.manualCameraTrack).toBeNull();
    // disableCamera already set this false — the superseded enable must not
    // resurrect it.
    expect(voiceStore.getState().localCamera).toBe(false);
  });

  it("does not announce the camera when disableCamera runs during the publish round-trip", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const track = fakeVideoTrack();
    createLocalVideoTrack.mockResolvedValue(track);
    let resolvePublish!: () => void;
    rig.publishTrack.mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePublish = resolve;
      }),
    );
    const state = { manualCameraTrack: null as LocalVideoTrack | null };

    const enabling = enableCamera(state, deps);
    await vi.waitFor(() => {
      expect(rig.publishTrack).toHaveBeenCalled();
    });
    // A concurrent disable runs to completion while publishTrack is still in
    // flight — it announces voice_camera(false) and stops the track.
    await disableCamera(state, deps);
    resolvePublish();
    await enabling;

    // The superseded enable must not announce voice_camera(true) after the
    // disable's voice_camera(false), or every peer renders a camera tile for
    // a stopped track while the local store says off.
    expect(deps.wsSend).not.toHaveBeenCalledWith({
      type: "voice_camera",
      payload: { enabled: true },
    });
    expect(rig.unpublishTrack).toHaveBeenCalledWith(track.mediaStreamTrack);
    expect(track.stop).toHaveBeenCalled();
    expect(state.manualCameraTrack).toBeNull();
    expect(voiceStore.getState().localCamera).toBe(false);
  });

  it("does not clear a newer attempt's track when a superseded enable's device acquisition rejects", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const trackB = fakeVideoTrack();
    let rejectA!: (err: unknown) => void;
    const promiseA = new Promise<LocalVideoTrack>((_, reject) => {
      rejectA = reject;
    });
    createLocalVideoTrack.mockReturnValueOnce(promiseA).mockResolvedValueOnce(trackB);
    const state = { manualCameraTrack: null as LocalVideoTrack | null };

    // Attempt A starts (generation 0) and is stuck awaiting device acquisition.
    const enablingA = enableCamera(state, deps);
    await vi.waitFor(() => {
      expect(createLocalVideoTrack).toHaveBeenCalledTimes(1);
    });

    // The user cycles the camera off and back on while A is still pending:
    // disable bumps the generation, then a fresh enable (B) captures the new
    // generation, resolves immediately, and goes fully live.
    await disableCamera(state, deps);
    await enableCamera(state, deps);
    expect(state.manualCameraTrack).toBe(trackB);
    expect(voiceStore.getState().localCamera).toBe(true);

    // Now A's stale createLocalVideoTrack call finally rejects (e.g. device
    // contention). A's catch block must recognise it was superseded and
    // leave B's live track and state alone.
    rejectA(new DOMException("busy", "NotReadableError"));
    await enablingA;

    expectConsole("warn", /\[screenShare\] Superseded camera enable failed/);
    expect(trackB.stop).not.toHaveBeenCalled();
    expect(state.manualCameraTrack).toBe(trackB);
    expect(voiceStore.getState().localCamera).toBe(true);
  });

  it("turns the camera off when the device track ends externally", async () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    createLocalVideoTrack.mockResolvedValue(video);
    const deps = fakeDeps(rig.room);
    const state = { manualCameraTrack: null as LocalVideoTrack | null };

    await enableCamera(state, deps);
    deps.wsSend.mockClear();

    (video.mediaStreamTrack as unknown as { dispatch: (t: string) => void }).dispatch("ended");

    await vi.waitFor(() => {
      expect(deps.wsSend).toHaveBeenCalledWith({
        type: "voice_camera",
        payload: { enabled: false },
      });
    });
    expect(voiceStore.getState().localCamera).toBe(false);
    expect(state.manualCameraTrack).toBeNull();
    expect(rig.unpublishTrack).toHaveBeenCalledWith(video.mediaStreamTrack);
  });

  it("turns the camera off when the track had already ended before it was observed", async () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    Object.defineProperty(video.mediaStreamTrack, "readyState", { value: "ended" });
    createLocalVideoTrack.mockResolvedValue(video);
    const deps = fakeDeps(rig.room);
    const state = { manualCameraTrack: null as LocalVideoTrack | null };

    await enableCamera(state, deps);

    expect(deps.wsSend).toHaveBeenCalledWith({
      type: "voice_camera",
      payload: { enabled: false },
    });
    expect(voiceStore.getState().localCamera).toBe(false);
    expect(state.manualCameraTrack).toBeNull();
  });

  it("unpublishes and stays silent when the device unplugs during the publish round-trip", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const video = fakeVideoTrack();
    createLocalVideoTrack.mockResolvedValue(video);
    let resolvePublish!: () => void;
    rig.publishTrack.mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePublish = resolve;
      }),
    );
    const state = { manualCameraTrack: null as LocalVideoTrack | null };

    const enabling = enableCamera(state, deps);
    await vi.waitFor(() => {
      expect(rig.publishTrack).toHaveBeenCalled();
    });
    // The unplug lands after enableCamera observed the track as live but
    // before the publish resolves: it disables the camera, which stops the
    // track and clears state.
    (video.mediaStreamTrack as unknown as { dispatch: (t: string) => void }).dispatch("ended");
    await vi.waitFor(() => {
      expect(voiceStore.getState().localCamera).toBe(false);
    });
    resolvePublish();
    await enabling;

    // Undo the publish that landed after the disable's unpublish, and do not
    // announce a camera that is off.
    expect(rig.unpublishTrack).toHaveBeenCalledWith(video.mediaStreamTrack);
    expect(video.stop).toHaveBeenCalled();
    expect(state.manualCameraTrack).toBeNull();
    expect(deps.wsSend).not.toHaveBeenCalledWith({
      type: "voice_camera",
      payload: { enabled: true },
    });
  });

  it("still turns the camera off on unplug after an earlier enable/disable cycle", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const first = fakeVideoTrack();
    const second = fakeVideoTrack();
    createLocalVideoTrack.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const state = { manualCameraTrack: null as LocalVideoTrack | null };

    // First cycle installs and then removes its ended listener.
    await enableCamera(state, deps);
    await disableCamera(state, deps);
    // A second enable must observe a later unplug too; the per-track listener
    // must not have been lost when the first track stopped.
    await enableCamera(state, deps);
    deps.wsSend.mockClear();

    (second.mediaStreamTrack as unknown as { dispatch: (t: string) => void }).dispatch("ended");

    await vi.waitFor(() => {
      expect(deps.wsSend).toHaveBeenCalledWith({
        type: "voice_camera",
        payload: { enabled: false },
      });
    });
    expect(voiceStore.getState().localCamera).toBe(false);
    expect(state.manualCameraTrack).toBeNull();
    expect(rig.unpublishTrack).toHaveBeenCalledWith(second.mediaStreamTrack);
  });
});

// ── disableCamera ──────────────────────────────────────────────────────────

describe("disableCamera", () => {
  it("stops the track, disables the camera and announces it", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const track = fakeVideoTrack();
    const state = { manualCameraTrack: track as LocalVideoTrack | null };

    await disableCamera(state, deps);

    expect(track.stop).toHaveBeenCalled();
    expect(rig.setCameraEnabled).toHaveBeenCalledWith(false);
    expect(deps.wsSend).toHaveBeenCalledWith({
      type: "voice_camera",
      payload: { enabled: false },
    });
    expect(voiceStore.getState().localCamera).toBe(false);
  });

  it("still clears local state when the room call throws", async () => {
    const rig = fakeRoom();
    rig.setCameraEnabled.mockRejectedValue(new Error("disconnected"));
    const deps = fakeDeps(rig.room);
    voiceStore.setState((prev) => ({ ...prev, localCamera: true }));

    await disableCamera({ manualCameraTrack: null }, deps);

    expectConsole("warn", /\[screenShare\] Failed to disable camera track \(non-fatal\)/);
    // The finally block matters: a failed teardown must not leave the UI
    // showing a camera that is not publishing.
    expect(voiceStore.getState().localCamera).toBe(false);
    expect(deps.wsSend).toHaveBeenCalledWith({
      type: "voice_camera",
      payload: { enabled: false },
    });
  });

  it("works with no room", async () => {
    const deps = fakeDeps(null);

    await disableCamera({ manualCameraTrack: null }, deps);

    expect(voiceStore.getState().localCamera).toBe(false);
  });

  it("skips the websocket notice when the socket is gone", async () => {
    const rig = fakeRoom();

    await expect(
      disableCamera({ manualCameraTrack: null }, fakeDeps(rig.room, false)),
    ).resolves.toBeUndefined();
  });
});

// ── stopManualScreenTracks ─────────────────────────────────────────────────

describe("stopManualScreenTracks", () => {
  it("unpublishes and stops every track", () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();
    const state = { manualScreenTracks: [video, audio] as LocalTrack[] };

    stopManualScreenTracks(state, rig.room);

    expect(rig.unpublishTrack).toHaveBeenCalledTimes(2);
    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
    expect(state.manualScreenTracks).toEqual([]);
  });

  it("forgets the announced track, so the left room is not kept reachable", () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    const state: ScreenTrackState = {
      manualScreenTracks: [video] as LocalTrack[],
      announced: video,
    };

    stopManualScreenTracks(state, rig.room);

    expect(state.announced).toBeUndefined();
  });

  it("is a no-op with no tracks", () => {
    const rig = fakeRoom();

    stopManualScreenTracks({ manualScreenTracks: [] }, rig.room);

    expect(rig.unpublishTrack).not.toHaveBeenCalled();
  });

  it("is a no-op with no room", () => {
    const video = fakeVideoTrack();
    const state = { manualScreenTracks: [video] as LocalTrack[] };

    stopManualScreenTracks(state, null);

    expect(video.stop).not.toHaveBeenCalled();
  });

  it("keeps stopping the remaining tracks when one unpublish throws", () => {
    const rig = fakeRoom();
    rig.unpublishTrack.mockImplementationOnce(() => {
      throw new Error("gone");
    });
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();

    stopManualScreenTracks({ manualScreenTracks: [video, audio] as LocalTrack[] }, rig.room);

    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
  });
});

// ── stream getters ─────────────────────────────────────────────────────────

describe("stream getters", () => {
  function roomWithLocalPub(source: Track.Source, track: unknown): Room {
    return {
      localParticipant: {
        getTrackPublication: (s: Track.Source) => (s === source ? { track } : undefined),
      },
      remoteParticipants: new Map(),
    } as unknown as Room;
  }

  it("getLocalCameraStream returns null without a room", () => {
    expect(getLocalCameraStream(null)).toBeNull();
  });

  it("getLocalCameraStream returns null when nothing is published", () => {
    expect(getLocalCameraStream(fakeRoom().room)).toBeNull();
  });

  it("getLocalCameraStream wraps the published camera track", () => {
    const room = roomWithLocalPub(Track.Source.Camera, { mediaStreamTrack: {} });

    expect(getLocalCameraStream(room)).not.toBeNull();
  });

  it("getLocalScreenshareStream returns null without a room", () => {
    expect(getLocalScreenshareStream(null)).toBeNull();
  });

  it("getLocalScreenshareStream wraps the published screenshare track", () => {
    const room = roomWithLocalPub(Track.Source.ScreenShare, { mediaStreamTrack: {} });

    expect(getLocalScreenshareStream(room)).not.toBeNull();
  });

  it("getLocalScreenshareStream returns null when nothing is published", () => {
    expect(getLocalScreenshareStream(fakeRoom().room)).toBeNull();
  });

  it("getLocalScreenshareStats reads the top layer's sent frame rate", async () => {
    const room = roomWithLocalPub(Track.Source.ScreenShare, {
      mediaStreamTrack: {},
      getSenderStats: async () => [
        { rid: "q", framesPerSecond: 15 },
        { rid: "h", framesPerSecond: 58 },
        { rid: "f" },
      ],
    });
    await expect(getLocalScreenshareStats(room)).resolves.toMatchObject({ sentFps: 58 });
  });

  it("getLocalScreenshareStats reads the WebRTC sender: limit, encoder and codec", async () => {
    const report = new Map<string, Record<string, unknown>>([
      ["c1", { type: "codec", mimeType: "video/VP8" }],
      [
        "o1",
        {
          type: "outbound-rtp",
          framesPerSecond: 61,
          frameWidth: 1920,
          frameHeight: 1080,
          qualityLimitationReason: "cpu",
          encoderImplementation: "libvpx",
          codecId: "c1",
        },
      ],
    ]);
    const room = roomWithLocalPub(Track.Source.ScreenShare, {
      mediaStreamTrack: { getSettings: () => ({ frameRate: 120 }) },
      sender: { getStats: async () => report },
    });
    const layer = {
      rid: undefined,
      active: true,
      width: 1920,
      height: 1080,
      sentFps: 61,
      encodedFps: undefined,
      bitrateBps: undefined,
      encodeMsPerFrame: undefined,
      limitation: "cpu",
      encoder: "libvpx",
      codec: "video/VP8",
      powerEfficient: undefined,
    };
    await expect(getLocalScreenshareStats(room)).resolves.toEqual({
      captureFps: 120,
      captureFpsSource: "configured",
      sentFps: 61,
      width: 1920,
      height: 1080,
      limitation: "cpu",
      encoder: "libvpx",
      codec: "video/VP8",
      layers: [layer],
    });
  });

  it("getLocalScreenshareStats has no rate before a layer reports one, and null with no sender", async () => {
    const unmeasured = roomWithLocalPub(Track.Source.ScreenShare, {
      mediaStreamTrack: {},
      getSenderStats: async () => [{ rid: "h" }],
    });
    expect((await getLocalScreenshareStats(unmeasured))?.sentFps).toBeUndefined();
    // The Linux native track publishes in the backend: no WebRTC sender here.
    const native = roomWithLocalPub(Track.Source.ScreenShare, { mediaStreamTrack: {} });
    await expect(getLocalScreenshareStats(native)).resolves.toBeNull();
    await expect(getLocalScreenshareStats(null)).resolves.toBeNull();
  });
});

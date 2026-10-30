/**
 * Tests for the track-publishing half of src/lib/screenShare.ts.
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

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import process from "node:process";
import { AudioPresets, Track } from "livekit-client";
import type { LocalTrack, LocalVideoTrack, Room } from "livekit-client";
import type { WsClient } from "@lib/ws";
import { expectConsole } from "../helpers/console";
import { initToast, teardownToast } from "@lib/toast";
import type { ToastContainer } from "@components/Toast";

const createLocalVideoTrack = vi.fn();
const createLocalScreenTracks = vi.fn();
const loadPref = vi.fn();

// 120 fps is hidden for now (lib/shareFps); the 120 fps tests turn it back on
// so the dormant 120 handling (one layer, balanced degradation, Auto's
// hardware rule) keeps its coverage.
const offer120 = vi.hoisted(() => ({ value: false }));
vi.mock("@lib/shareFps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lib/shareFps")>();
  return {
    ...actual,
    offeredShareFps: (saved: number) =>
      offer120.value && saved === 120 ? 120 : actual.offeredShareFps(saved),
  };
});

const setH264GpuProfiles = vi.hoisted(() => vi.fn());
vi.mock("@lib/h264Profile", () => ({ setH264GpuProfiles }));
const gpuProfiles = vi.hoisted(() => ({ value: false }));
vi.mock("../../src/features/voice/videoCodec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/features/voice/videoCodec")>();
  return {
    ...actual,
    h264GpuPublish: (codec: string) => codec === "h264" && gpuProfiles.value,
  };
});

vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return {
    ...actual,
    createLocalVideoTrack: (...args: unknown[]) => createLocalVideoTrack(...args) as unknown,
    createLocalScreenTracks: (...args: unknown[]) => createLocalScreenTracks(...args) as unknown,
  };
});

vi.mock("@lib/prefs/preferences", () => ({
  loadPref: (...args: unknown[]) => loadPref(...args) as unknown,
  savePref: vi.fn(),
}));

const nativeCameraSupport = vi.hoisted(() => vi.fn());
vi.mock("../../src/features/voice/native/devices", () => ({
  nativeCameraSupport: (...args: unknown[]) => nativeCameraSupport(...args),
}));

const {
  bumpGeneration,
  disableCamera,
  disableScreenshare,
  enableCamera,
  enableScreenshare,
  getLocalCameraStream,
  getLocalScreenshareStream,
  getLocalScreenshareStats,
  stopManualCameraTrack,
  stopManualScreenTracks,
  rollbackPendingVideo,
  reconcileVideoFlags,
} = await import("@lib/screenShare");

type VideoTrackDeps = Parameters<typeof enableCamera>[1];
type CameraTrackState = Parameters<typeof stopManualCameraTrack>[0];
type ScreenTrackState = Parameters<typeof stopManualScreenTracks>[0];

const { voiceStore } = await import("@stores/voice.store");
const { setScreenSourcePicker } = await import("../../src/features/voice/native/screenPickerSlot");

// ── fakes ──────────────────────────────────────────────────────────────────

function fakeMediaStreamTrack(): MediaStreamTrack {
  const listeners = new Map<string, EventListener>();
  return {
    readyState: "live",
    addEventListener: (type: string, cb: EventListener) => listeners.set(type, cb),
    removeEventListener: (type: string, cb: EventListener) => {
      if (listeners.get(type) === cb) listeners.delete(type);
    },
    dispatch: (type: string) => listeners.get(type)?.(new Event(type)),
  } as unknown as MediaStreamTrack;
}

function fakeVideoTrack(): LocalVideoTrack & { stop: ReturnType<typeof vi.fn> } {
  return {
    kind: Track.Kind.Video,
    mediaStreamTrack: fakeMediaStreamTrack(),
    stop: vi.fn(),
  } as unknown as LocalVideoTrack & { stop: ReturnType<typeof vi.fn> };
}

function fakeAudioTrack(): LocalTrack & { stop: ReturnType<typeof vi.fn> } {
  return {
    kind: Track.Kind.Audio,
    mediaStreamTrack: fakeMediaStreamTrack(),
    stop: vi.fn(),
  } as unknown as LocalTrack & { stop: ReturnType<typeof vi.fn> };
}

interface RoomRig {
  room: Room;
  publishTrack: ReturnType<typeof vi.fn>;
  unpublishTrack: ReturnType<typeof vi.fn>;
  setCameraEnabled: ReturnType<typeof vi.fn>;
  setScreenShareEnabled: ReturnType<typeof vi.fn>;
}

function fakeRoom(): RoomRig {
  const publishTrack = vi.fn().mockResolvedValue(undefined);
  const unpublishTrack = vi.fn().mockResolvedValue(undefined);
  const setCameraEnabled = vi.fn().mockResolvedValue(undefined);
  const setScreenShareEnabled = vi.fn().mockResolvedValue(undefined);
  const room = {
    localParticipant: {
      publishTrack,
      unpublishTrack,
      setCameraEnabled,
      setScreenShareEnabled,
      getTrackPublication: () => undefined,
    },
    remoteParticipants: new Map(),
  } as unknown as Room;
  return { room, publishTrack, unpublishTrack, setCameraEnabled, setScreenShareEnabled };
}

/** A fake native (Linux) room: its local participant exposes
 *  `createCameraTracks`, the method that marks the host-capture path. */
function fakeNativeRoom(): RoomRig & { createCameraTracks: ReturnType<typeof vi.fn> } {
  const rig = fakeRoom();
  const createCameraTracks = vi.fn().mockResolvedValue([]);
  (rig.room.localParticipant as unknown as { createCameraTracks: unknown }).createCameraTracks =
    createCameraTracks;
  return { ...rig, createCameraTracks };
}

/**
 * Builds a VideoTrackDeps with spies attached. `wsSend` is surfaced directly
 * rather than reached through `getWs()`, which narrows to `never` once a test
 * passes `hasWs: false`.
 */
function fakeDeps(
  room: Room | null,
  hasWs = true,
): VideoTrackDeps & {
  wsSend: ReturnType<typeof vi.fn>;
  onError: Mock<(message: string) => void>;
  reapplyAudioPipeline: Mock<() => void>;
} {
  const wsSend = vi.fn();
  const ws = hasWs ? ({ send: wsSend } as unknown as WsClient) : null;
  return {
    getRoom: () => room,
    getWs: () => ws,
    onError: vi.fn<(message: string) => void>(),
    reapplyAudioPipeline: vi.fn<() => void>(),
    wsSend,
  };
}

beforeEach(() => {
  offer120.value = false;
  gpuProfiles.value = false;
  setH264GpuProfiles.mockReset();
  createLocalVideoTrack.mockReset();
  createLocalScreenTracks.mockReset();
  loadPref.mockReset().mockReturnValue("");
  nativeCameraSupport.mockReset().mockResolvedValue({ available: true, missing: [] });
  voiceStore.setState((prev) => ({ ...prev, localCamera: false, localScreenshare: false }));
  vi.stubGlobal(
    "MediaStream",
    class {
      tracks: unknown[];
      constructor(tracks: unknown[] = []) {
        this.tracks = tracks;
      }
    },
  );
});

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

// ── enableScreenshare ──────────────────────────────────────────────────────

describe("enableScreenshare", () => {
  it("publishes video and audio tracks with the right sources", async () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();
    createLocalScreenTracks.mockResolvedValue([video, audio]);
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expect(rig.publishTrack).toHaveBeenCalledWith(
      video,
      expect.objectContaining({ source: Track.Source.ScreenShare }),
    );
    expect(rig.publishTrack).toHaveBeenCalledWith(
      audio,
      expect.objectContaining({ source: Track.Source.ScreenShareAudio }),
    );
    expect(deps.wsSend).toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: true },
    });
    expect(voiceStore.getState().localScreenshare).toBe(true);
  });

  it("publishes the screen audio as music: no DTX, stereo, music preset", async () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();
    createLocalScreenTracks.mockResolvedValue([video, audio]);

    await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    const audioOpts = rig.publishTrack.mock.calls.find((c) => c[0] === audio)?.[1];
    expect(audioOpts).toMatchObject({
      source: Track.Source.ScreenShareAudio,
      dtx: false,
      forceStereo: true,
      audioPreset: AudioPresets.musicHighQualityStereo,
    });
    const videoOpts = rig.publishTrack.mock.calls.find((c) => c[0] === video)?.[1];
    expect(videoOpts).not.toHaveProperty("dtx");
    expect(videoOpts).not.toHaveProperty("forceStereo");
  });

  it("sets a video encoding on the video track only", async () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();
    createLocalScreenTracks.mockResolvedValue([video, audio]);

    await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    const videoOpts = rig.publishTrack.mock.calls.find((c) => c[0] === video)?.[1] as Record<
      string,
      unknown
    >;
    const audioOpts = rig.publishTrack.mock.calls.find((c) => c[0] === audio)?.[1] as Record<
      string,
      unknown
    >;
    // livekit-client reads a screen share's encoding from screenShareEncoding
    // and ignores videoEncoding for that source.
    expect(videoOpts).toHaveProperty("screenShareEncoding");
    expect(audioOpts).not.toHaveProperty("screenShareEncoding");
  });

  it("publishes the default (medium) share as 720p30 with a 720p 15 fps simulcast layer", async () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();
    createLocalScreenTracks.mockResolvedValue([video, audio]);

    await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    expect(createLocalScreenTracks).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: expect.objectContaining({ width: 1280, height: 720, frameRate: 30 }),
      }),
    );
    const videoOpts = rig.publishTrack.mock.calls.find((c) => c[0] === video)?.[1];
    expect(videoOpts).toMatchObject({
      source: Track.Source.ScreenShare,
      simulcast: true,
      screenShareEncoding: { maxBitrate: 3_000_000, maxFramerate: 30 },
      screenShareSimulcastLayers: [
        { width: 1280, height: 720, encoding: { maxBitrate: 1_200_000, maxFramerate: 15 } },
      ],
    });
    const audioOpts = rig.publishTrack.mock.calls.find((c) => c[0] === audio)?.[1] as Record<
      string,
      unknown
    >;
    expect(audioOpts).toMatchObject({ simulcast: false });
    expect(audioOpts).not.toHaveProperty("screenShareSimulcastLayers");
  });

  it("publishes the high share at 1080p with the 720p layer", async () => {
    loadPref.mockImplementation((key: string) => (key === "screenShareQuality" ? "high" : ""));
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    createLocalScreenTracks.mockResolvedValue([video]);

    await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    expect(createLocalScreenTracks).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: expect.objectContaining({ width: 1920, height: 1080, frameRate: 30 }),
      }),
    );
    expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({
      simulcast: true,
      screenShareEncoding: { maxBitrate: 6_000_000, maxFramerate: 30 },
      screenShareSimulcastLayers: [{ width: 1280, height: 720 }],
    });
  });

  it("publishes a high share at 120 fps as one layer", async () => {
    offer120.value = true;
    loadPref.mockImplementation((key: string) =>
      key === "screenShareQuality" ? "high" : key === "screenShareFps" ? 120 : "",
    );
    const rig = fakeRoom();
    createLocalScreenTracks.mockResolvedValue([fakeVideoTrack()]);

    await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    const videoOpts = rig.publishTrack.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(videoOpts).toMatchObject({
      simulcast: false,
      screenShareEncoding: { maxBitrate: 12_000_000, maxFramerate: 120 },
      degradationPreference: "maintain-framerate",
    });
    expect(videoOpts).not.toHaveProperty("screenShareSimulcastLayers");
  });

  it("publishes a saved 120 share at 60 fps while 120 is hidden", async () => {
    loadPref.mockImplementation((key: string) =>
      key === "screenShareQuality" ? "high" : key === "screenShareFps" ? 120 : "",
    );
    const rig = fakeRoom();
    createLocalScreenTracks.mockResolvedValue([fakeVideoTrack()]);

    await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    const videoOpts = rig.publishTrack.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(videoOpts).toMatchObject({
      screenShareEncoding: { maxFramerate: 60 },
      degradationPreference: "maintain-framerate",
    });
  });

  it("publishes 30 and 60 fps shares keeping their frame rate", async () => {
    for (const fps of [30, 60]) {
      loadPref.mockImplementation((key: string) =>
        key === "screenShareQuality" ? "high" : key === "screenShareFps" ? fps : "",
      );
      const rig = fakeRoom();
      const audio = fakeAudioTrack();
      createLocalScreenTracks.mockResolvedValue([fakeVideoTrack(), audio]);

      // oxlint-disable-next-line no-await-in-loop -- one frame rate at a time
      await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

      expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({
        degradationPreference: "maintain-framerate",
      });
      const audioOpts = rig.publishTrack.mock.calls.find((c) => c[0] === audio)?.[1];
      expect(audioOpts).not.toHaveProperty("degradationPreference");
    }
  });

  it("keeps the source share as a single full-resolution layer", async () => {
    loadPref.mockImplementation((key: string) => (key === "screenShareQuality" ? "source" : ""));
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    createLocalScreenTracks.mockResolvedValue([video]);

    await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    const videoOpts = rig.publishTrack.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(videoOpts).toMatchObject({ simulcast: false });
    expect(videoOpts).not.toHaveProperty("screenShareSimulcastLayers");
  });

  it("takes the camera quality from streamQuality, not the screen share pref", async () => {
    loadPref.mockImplementation((key: string) =>
      key === "streamQuality" ? "medium" : key === "screenShareQuality" ? "high" : "",
    );
    const rig = fakeRoom();
    createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());

    await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));

    expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({
      videoEncoding: { maxBitrate: 1_700_000 },
    });
  });

  it("adds a 720p simulcast layer to a 1080p camera, so a 1-3 Mbps viewer gets 720p not 360p", async () => {
    loadPref.mockImplementation((key: string) => (key === "streamQuality" ? "high" : ""));
    const rig = fakeRoom();
    createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());

    await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));

    const opts = rig.publishTrack.mock.calls[0]?.[1] as {
      videoSimulcastLayers: { width: number; height: number }[];
    };
    expect(opts.videoSimulcastLayers.map((l) => [l.width, l.height])).toEqual([
      [640, 360],
      [1280, 720],
    ]);
  });

  it("leaves a 720p camera on the SDK's default layers", async () => {
    loadPref.mockImplementation((key: string) => (key === "streamQuality" ? "medium" : ""));
    const rig = fakeRoom();
    createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());

    await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));

    expect(rig.publishTrack.mock.calls[0]?.[1]).not.toHaveProperty("videoSimulcastLayers");
  });

  it("defaults the camera to 720p when no quality is saved", async () => {
    loadPref.mockImplementation((_key: string, fallback: unknown) => fallback);
    const rig = fakeRoom();
    createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());

    await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));

    expect(createLocalVideoTrack.mock.calls[0]?.[0]).toMatchObject({
      resolution: { width: 1280, height: 720 },
    });
  });

  it("tears down when the OS stop-sharing button ends the track", async () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    createLocalScreenTracks.mockResolvedValue([video]);
    const deps = fakeDeps(rig.room);
    const state = { manualScreenTracks: [] as LocalTrack[] };

    await enableScreenshare(state, deps);
    deps.wsSend.mockClear();

    // Simulate the browser/OS ending the capture without going through the app.
    (video.mediaStreamTrack as unknown as { dispatch: (t: string) => void }).dispatch("ended");
    await vi.waitFor(() => {
      expect(deps.wsSend).toHaveBeenCalledWith({
        type: "voice_screenshare",
        payload: { enabled: false },
      });
    });
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("refuses when there is no voice session", async () => {
    const deps = fakeDeps(null);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expectConsole("warn", /\[screenShare\] Cannot enable screenshare: no active voice session/);
    expect(deps.onError).toHaveBeenCalledWith("Join a voice channel first");
    expect(createLocalScreenTracks).not.toHaveBeenCalled();
  });

  it("releases created tracks when publishing fails", async () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    createLocalScreenTracks.mockResolvedValue([video]);
    rig.publishTrack.mockRejectedValue(new Error("publish failed"));
    const deps = fakeDeps(rig.room);
    const state = { manualScreenTracks: [] as LocalTrack[] };

    await enableScreenshare(state, deps);

    expectConsole("error", /\[screenShare\] Failed to enable screenshare/);
    // Otherwise the OS keeps showing "screen is being shared" forever.
    expect(video.stop).toHaveBeenCalled();
    expect(state.manualScreenTracks).toEqual([]);
    expect(voiceStore.getState().localScreenshare).toBe(false);
    expect(deps.onError).toHaveBeenCalledWith("Failed to start screen sharing");
  });

  it("reports a denied picker separately", async () => {
    const rig = fakeRoom();
    createLocalScreenTracks.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expectConsole("error", /\[screenShare\] Failed to enable screenshare/);
    expect(deps.onError).toHaveBeenCalledWith("Screen sharing permission denied");
  });

  it("stays silent when the user cancels the picker (polish #10)", async () => {
    // A cancel is not a denial. Chromium (WebView2) rejects a dismissed
    // picker with this NotAllowedError, and the Linux native path raises the
    // same; announcing "permission denied" for closing the dialog is wrong.
    const rig = fakeRoom();
    createLocalScreenTracks.mockRejectedValue(
      new DOMException("Permission denied by user", "NotAllowedError"),
    );
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expectConsole("error", /\[screenShare\] Failed to enable screenshare/);
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("answers a desktop portal that never started with a soft notice", async () => {
    const rig = fakeRoom();
    createLocalScreenTracks.mockRejectedValue(
      new DOMException("screen capture portal did not start", "NotAllowedError"),
    );
    const deps = fakeDeps(rig.room);
    const toasts = { show: vi.fn() };
    initToast(toasts as unknown as ToastContainer);

    try {
      await enableScreenshare({ manualScreenTracks: [] }, deps);
    } finally {
      teardownToast();
    }

    expectConsole("error", /\[screenShare\] Failed to enable screenshare/);
    // A notice, not the error channel the refusals and failures use.
    expect(deps.onError).not.toHaveBeenCalled();
    expect(toasts.show).toHaveBeenCalledWith(
      "Screen share didn't start. If you didn't cancel it, check your desktop's screen-sharing permission.",
      "info",
      undefined,
    );
  });

  it("still reports a refusal the OS made rather than the user", async () => {
    const rig = fakeRoom();
    createLocalScreenTracks.mockRejectedValue(
      new DOMException("Permission denied by system", "NotAllowedError"),
    );
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expectConsole("error", /\[screenShare\] Failed to enable screenshare/);
    expect(deps.onError).toHaveBeenCalledWith("Screen sharing permission denied");
  });

  it("reports an aborted capture as a failure, not a cancel", async () => {
    // Chromium raises AbortError for a capture that could not start (a start
    // timeout, an invalid state), never for the user closing the picker.
    const rig = fakeRoom();
    createLocalScreenTracks.mockRejectedValue(
      new DOMException("Timeout starting video source", "AbortError"),
    );
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expectConsole("error", /\[screenShare\] Failed to enable screenshare/);
    expect(deps.onError).toHaveBeenCalledWith("Failed to start screen sharing");
  });

  it("tolerates a capture with no video track", async () => {
    const rig = fakeRoom();
    createLocalScreenTracks.mockResolvedValue([fakeAudioTrack()]);
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("unpublishes a track that already published before a later one in the batch fails", async () => {
    // All quality presets request audio alongside video — a second publish
    // call (audio) can reject after the first (video) already succeeded.
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();
    createLocalScreenTracks.mockResolvedValue([video, audio]);
    rig.publishTrack.mockImplementation((track: unknown) =>
      track === audio ? Promise.reject(new Error("publish failed")) : Promise.resolve(undefined),
    );
    const deps = fakeDeps(rig.room);
    const state = { manualScreenTracks: [] as LocalTrack[] };

    await enableScreenshare(state, deps);

    expectConsole("error", /\[screenShare\] Failed to enable screenshare/);
    // track.stop() is programmatic and never fires the DOM "ended" event, so
    // LiveKit's ended-driven auto-unpublish never runs — without an explicit
    // unpublish the video track stays live in the room while nothing in this
    // client can find its publication to clean it up later.
    expect(rig.unpublishTrack).toHaveBeenCalledWith(video.mediaStreamTrack);
    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
    expect(state.manualScreenTracks).toEqual([]);
  });

  it("discards the tracks and does not publish when disableScreenshare runs during capture", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const video = fakeVideoTrack();
    let resolveTracks!: (t: LocalTrack[]) => void;
    createLocalScreenTracks.mockReturnValue(
      new Promise((resolve) => {
        resolveTracks = resolve;
      }),
    );
    const state = { manualScreenTracks: [] as LocalTrack[] };

    const enabling = enableScreenshare(state, deps);
    // A concurrent disable runs to completion while the OS picker is still up.
    await disableScreenshare(state, deps);
    resolveTracks([video]);
    await enabling;

    expect(rig.publishTrack).not.toHaveBeenCalled();
    expect(video.stop).toHaveBeenCalled();
    expect(state.manualScreenTracks).toEqual([]);
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("does not announce the share when disableScreenshare runs during the publish loop", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();
    createLocalScreenTracks.mockResolvedValue([video, audio]);
    let resolveFirstPublish!: () => void;
    rig.publishTrack
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveFirstPublish = resolve;
        }),
      )
      .mockResolvedValue(undefined);
    const state = { manualScreenTracks: [] as LocalTrack[] };

    const enabling = enableScreenshare(state, deps);
    await vi.waitFor(() => {
      expect(rig.publishTrack).toHaveBeenCalledTimes(1);
    });
    // A concurrent disable runs to completion while the first publish is
    // still in flight — it announces voice_screenshare(false), stops both
    // tracks and empties state.manualScreenTracks.
    await disableScreenshare(state, deps);
    resolveFirstPublish();
    await enabling;

    // The superseded enable must not publish the remaining track — after the
    // disable emptied the state, only this attempt can still reach it — and
    // must not announce voice_screenshare(true) after the disable's false.
    expect(rig.publishTrack).toHaveBeenCalledTimes(1);
    expect(deps.wsSend).not.toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: true },
    });
    expect(rig.unpublishTrack).toHaveBeenCalledWith(video.mediaStreamTrack);
    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
    expect(state.manualScreenTracks).toEqual([]);
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("does not tear down a newer share when a superseded enable's capture rejects", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const videoB = fakeVideoTrack();
    let rejectA!: (err: unknown) => void;
    const promiseA = new Promise<LocalTrack[]>((_, reject) => {
      rejectA = reject;
    });
    createLocalScreenTracks.mockReturnValueOnce(promiseA).mockResolvedValueOnce([videoB]);
    const state = { manualScreenTracks: [] as LocalTrack[] };

    // Attempt A starts (generation 0) and is stuck awaiting the OS picker.
    const enablingA = enableScreenshare(state, deps);
    await vi.waitFor(() => {
      expect(createLocalScreenTracks).toHaveBeenCalledTimes(1);
    });

    // The user cycles the share off and back on while A is still pending:
    // disable bumps the generation, then a fresh enable (B) captures the new
    // generation, resolves immediately, and goes fully live.
    await disableScreenshare(state, deps);
    await enableScreenshare(state, deps);
    expect(state.manualScreenTracks).toEqual([videoB]);
    expect(voiceStore.getState().localScreenshare).toBe(true);

    // Now A's stale createLocalScreenTracks call finally rejects. A's catch
    // block must recognise it was superseded and leave B's live tracks and
    // state alone.
    rejectA(new Error("capture failed"));
    await enablingA;

    expectConsole("warn", /\[screenShare\] Superseded screenshare enable failed/);
    expect(videoB.stop).not.toHaveBeenCalled();
    expect(state.manualScreenTracks).toEqual([videoB]);
    expect(voiceStore.getState().localScreenshare).toBe(true);
  });
});

// ── disableScreenshare ─────────────────────────────────────────────────────

describe("disableScreenshare", () => {
  it("stops tracks, disables sharing and announces it", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const video = fakeVideoTrack();

    await disableScreenshare({ manualScreenTracks: [video] as LocalTrack[] }, deps);

    expect(video.stop).toHaveBeenCalled();
    expect(rig.setScreenShareEnabled).toHaveBeenCalledWith(false);
    expect(deps.wsSend).toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: false },
    });
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("still clears local state when the room call throws", async () => {
    const rig = fakeRoom();
    rig.setScreenShareEnabled.mockRejectedValue(new Error("disconnected"));
    voiceStore.setState((prev) => ({ ...prev, localScreenshare: true }));

    await disableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    expectConsole("warn", /\[screenShare\] Failed to disable screenshare track \(non-fatal\)/);
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("works with no room", async () => {
    await disableScreenshare({ manualScreenTracks: [] }, fakeDeps(null));

    expect(voiceStore.getState().localScreenshare).toBe(false);
  });
});

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

describe("enableScreenshare quality step", () => {
  afterEach(() => setScreenSourcePicker(null));

  it("captures and publishes at the quality and fps picked before the OS picker", async () => {
    const picker = vi.fn().mockResolvedValue({ source: "os", quality: "high", fps: 60 });
    setScreenSourcePicker(picker);
    const rig = fakeRoom();
    createLocalScreenTracks.mockResolvedValue([fakeVideoTrack()]);
    const state = { manualScreenTracks: [] as LocalTrack[] } as Parameters<
      typeof enableScreenshare
    >[0];

    await enableScreenshare(state, fakeDeps(rig.room));

    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ osPicker: true, defaultQuality: "medium", defaultFps: 30 }),
    );
    expect(createLocalScreenTracks).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: expect.objectContaining({ width: 1920, height: 1080, frameRate: 60 }),
      }),
    );
    expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({
      screenShareEncoding: { maxBitrate: 9_000_000, maxFramerate: 60 },
    });
    expect(state.quality).toBe("high");
    expect(state.fps).toBe(60);
  });

  it("opens the OS picker only after the quality step", async () => {
    let goLive!: (pick: unknown) => void;
    setScreenSourcePicker(() => new Promise((resolve) => (goLive = resolve as typeof goLive)));
    const rig = fakeRoom();
    createLocalScreenTracks.mockResolvedValue([fakeVideoTrack()]);

    const enabling = enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));
    await vi.waitFor(() => expect(goLive).toBeDefined());
    expect(createLocalScreenTracks).not.toHaveBeenCalled();
    goLive({ source: "os", quality: "medium", fps: 30 });
    await enabling;

    expect(createLocalScreenTracks).toHaveBeenCalledTimes(1);
  });

  it("captures nothing and announces nothing when the quality step is closed", async () => {
    setScreenSourcePicker(() => Promise.resolve(null));
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expect(createLocalScreenTracks).not.toHaveBeenCalled();
    expect(deps.wsSend).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("does not capture when the share is stopped while the quality step is open", async () => {
    let goLive!: (pick: unknown) => void;
    setScreenSourcePicker(() => new Promise((resolve) => (goLive = resolve as typeof goLive)));
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const state = { manualScreenTracks: [] as LocalTrack[] };

    const enabling = enableScreenshare(state, deps);
    await vi.waitFor(() => expect(goLive).toBeDefined());
    await disableScreenshare(state, deps);
    goLive({ source: "os", quality: "high", fps: 60 });
    await enabling;

    expect(createLocalScreenTracks).not.toHaveBeenCalled();
    expect(deps.wsSend).not.toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: true },
    });
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("leaves Linux to its own picker: no quality step before the native capture", async () => {
    const picker = vi.fn();
    setScreenSourcePicker(picker);
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
    const rig = fakeRoom();
    const createScreenTracks = vi.fn().mockResolvedValue([fakeVideoTrack()]);
    (rig.room.localParticipant as unknown as { createScreenTracks: unknown }).createScreenTracks =
      createScreenTracks;

    try {
      await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }

    expect(picker).not.toHaveBeenCalled();
    expect(createScreenTracks).toHaveBeenCalledTimes(1);
    expect(createLocalScreenTracks).not.toHaveBeenCalled();
  });

  it("shares at the saved defaults when the dialog cannot load", async () => {
    setScreenSourcePicker(() => Promise.reject(new Error("chunk failed")));
    const rig = fakeRoom();
    createLocalScreenTracks.mockResolvedValue([fakeVideoTrack()]);

    await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    expectConsole("warn", /Screen share quality step unavailable/);
    expect(createLocalScreenTracks).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: expect.objectContaining({ width: 1280, height: 720, frameRate: 30 }),
      }),
    );
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

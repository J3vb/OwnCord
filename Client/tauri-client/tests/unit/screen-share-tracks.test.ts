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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Track } from "livekit-client";
import type { LocalTrack, LocalVideoTrack, Room } from "livekit-client";
import type { WsClient } from "@lib/ws";

const createLocalVideoTrack = vi.fn();
const createLocalScreenTracks = vi.fn();
const loadPref = vi.fn();

vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return {
    ...actual,
    createLocalVideoTrack: (...args: unknown[]) => createLocalVideoTrack(...args) as unknown,
    createLocalScreenTracks: (...args: unknown[]) => createLocalScreenTracks(...args) as unknown,
  };
});

vi.mock("@components/settings/helpers", () => ({
  loadPref: (...args: unknown[]) => loadPref(...args) as unknown,
  savePref: vi.fn(),
}));

const {
  disableCamera,
  disableScreenshare,
  enableCamera,
  enableScreenshare,
  getLocalCameraStream,
  getLocalScreenshareStream,
  getRemoteVideoStream,
  stopManualCameraTrack,
  stopManualScreenTracks,
} = await import("@lib/screenShare");

type VideoTrackDeps = Parameters<typeof enableCamera>[1];

const { voiceStore } = await import("@stores/voice.store");

// ── fakes ──────────────────────────────────────────────────────────────────

function fakeMediaStreamTrack(): MediaStreamTrack {
  const listeners = new Map<string, EventListener>();
  return {
    addEventListener: (type: string, cb: EventListener) => listeners.set(type, cb),
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
  onError: ReturnType<typeof vi.fn>;
  reapplyAudioPipeline: ReturnType<typeof vi.fn>;
} {
  const wsSend = vi.fn();
  const ws = hasWs ? ({ send: wsSend } as unknown as WsClient) : null;
  return {
    getRoom: () => room,
    getWs: () => ws,
    onError: vi.fn(),
    reapplyAudioPipeline: vi.fn(),
    wsSend,
  };
}

beforeEach(() => {
  createLocalVideoTrack.mockReset();
  createLocalScreenTracks.mockReset();
  loadPref.mockReset().mockReturnValue("");
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

    expect(deps.onError).toHaveBeenCalledWith("Join a voice channel first");
    expect(createLocalVideoTrack).not.toHaveBeenCalled();
    expect(voiceStore.getState().localCamera).toBe(false);
  });

  it("refuses when the websocket is gone", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room, false);

    await enableCamera({ manualCameraTrack: null }, deps);

    expect(deps.onError).toHaveBeenCalledWith("Join a voice channel first");
  });

  it("releases the created track when publishing fails (BUG-100)", async () => {
    const rig = fakeRoom();
    const track = fakeVideoTrack();
    createLocalVideoTrack.mockResolvedValue(track);
    rig.publishTrack.mockRejectedValue(new Error("publish failed"));
    const deps = fakeDeps(rig.room);
    const state = { manualCameraTrack: null as LocalVideoTrack | null };

    await enableCamera(state, deps);

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

    expect(deps.onError).toHaveBeenCalledWith(message);
  });

  it("stops a previously published track before publishing a new one", async () => {
    const rig = fakeRoom();
    const old = fakeVideoTrack();
    createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());

    await enableCamera({ manualCameraTrack: old }, fakeDeps(rig.room));

    expect(old.stop).toHaveBeenCalled();
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
    expect(videoOpts).toHaveProperty("videoEncoding");
    expect(audioOpts).not.toHaveProperty("videoEncoding");
  });

  it("tears down when the OS stop-sharing button ends the track (BUG-101)", async () => {
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

    expect(deps.onError).toHaveBeenCalledWith("Join a voice channel first");
    expect(createLocalScreenTracks).not.toHaveBeenCalled();
  });

  it("releases created tracks when publishing fails (BUG-100)", async () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    createLocalScreenTracks.mockResolvedValue([video]);
    rig.publishTrack.mockRejectedValue(new Error("publish failed"));
    const deps = fakeDeps(rig.room);
    const state = { manualScreenTracks: [] as LocalTrack[] };

    await enableScreenshare(state, deps);

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

    expect(deps.onError).toHaveBeenCalledWith("Screen sharing permission denied");
  });

  it("tolerates a capture with no video track", async () => {
    const rig = fakeRoom();
    createLocalScreenTracks.mockResolvedValue([fakeAudioTrack()]);
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expect(deps.onError).not.toHaveBeenCalled();
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

    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("works with no room", async () => {
    await disableScreenshare({ manualScreenTracks: [] }, fakeDeps(null));

    expect(voiceStore.getState().localScreenshare).toBe(false);
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
});

describe("getRemoteVideoStream", () => {
  function roomWithRemote(identity: string, source: Track.Source, track: unknown): Room {
    return {
      localParticipant: { getTrackPublication: () => undefined },
      remoteParticipants: new Map([
        [
          identity,
          {
            identity,
            getTrackPublication: (s: Track.Source) => (s === source ? { track } : undefined),
          },
        ],
      ]),
    } as unknown as Room;
  }

  it("returns null without a room", () => {
    expect(getRemoteVideoStream(null, 7, "camera")).toBeNull();
  });

  it("matches an identity carrying a join-token suffix", () => {
    // getParticipantByIdentity would miss this, which is why the module scans.
    const room = roomWithRemote("user-42:abc123", Track.Source.Camera, { mediaStreamTrack: {} });

    expect(getRemoteVideoStream(room, 42, "camera")).not.toBeNull();
  });

  it("matches a bare identity", () => {
    const room = roomWithRemote("user-42", Track.Source.Camera, { mediaStreamTrack: {} });

    expect(getRemoteVideoStream(room, 42, "camera")).not.toBeNull();
  });

  it("selects the screenshare source when asked", () => {
    const room = roomWithRemote("user-42:tok", Track.Source.ScreenShare, { mediaStreamTrack: {} });

    expect(getRemoteVideoStream(room, 42, "screenshare")).not.toBeNull();
    expect(getRemoteVideoStream(room, 42, "camera")).toBeNull();
  });

  it("returns null for a user who is not in the room", () => {
    const room = roomWithRemote("user-42:tok", Track.Source.Camera, { mediaStreamTrack: {} });

    expect(getRemoteVideoStream(room, 99, "camera")).toBeNull();
  });

  it("does not confuse user 4 with user 42", () => {
    const room = roomWithRemote("user-42:tok", Track.Source.Camera, { mediaStreamTrack: {} });

    expect(getRemoteVideoStream(room, 4, "camera")).toBeNull();
  });

  it("ignores participants with an unparseable identity", () => {
    const room = roomWithRemote("anonymous", Track.Source.Camera, { mediaStreamTrack: {} });

    expect(getRemoteVideoStream(room, 42, "camera")).toBeNull();
  });
});

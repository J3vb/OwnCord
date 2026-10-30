import { beforeEach, vi, type Mock } from "vitest";
import { Track } from "livekit-client";
import type { LocalTrack, LocalVideoTrack, Room } from "livekit-client";
import type { WsClient } from "@lib/ws";
import {
  createLocalVideoTrack,
  createLocalScreenTracks,
  loadPref,
  offer120,
  setH264GpuProfiles,
  gpuProfiles,
  nativeCameraSupport,
} from "./screenShareTracksMocks";

export const {
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
} = await import("@lib/voice/screenShare");

export type VideoTrackDeps = Parameters<typeof enableCamera>[1];

export type CameraTrackState = Parameters<typeof stopManualCameraTrack>[0];

export type ScreenTrackState = Parameters<typeof stopManualScreenTracks>[0];

export const { voiceStore } = await import("@stores/voice.store");

export const { setScreenSourcePicker } =
  await import("../../src/features/voice/native/screenPickerSlot");

// ── fakes ──────────────────────────────────────────────────────────────────

export function fakeMediaStreamTrack(): MediaStreamTrack {
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

export function fakeVideoTrack(): LocalVideoTrack & { stop: ReturnType<typeof vi.fn> } {
  return {
    kind: Track.Kind.Video,
    mediaStreamTrack: fakeMediaStreamTrack(),
    stop: vi.fn(),
  } as unknown as LocalVideoTrack & { stop: ReturnType<typeof vi.fn> };
}

export function fakeAudioTrack(): LocalTrack & { stop: ReturnType<typeof vi.fn> } {
  return {
    kind: Track.Kind.Audio,
    mediaStreamTrack: fakeMediaStreamTrack(),
    stop: vi.fn(),
  } as unknown as LocalTrack & { stop: ReturnType<typeof vi.fn> };
}

export interface RoomRig {
  room: Room;
  publishTrack: ReturnType<typeof vi.fn>;
  unpublishTrack: ReturnType<typeof vi.fn>;
  setCameraEnabled: ReturnType<typeof vi.fn>;
  setScreenShareEnabled: ReturnType<typeof vi.fn>;
}

export function fakeRoom(): RoomRig {
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
export function fakeNativeRoom(): RoomRig & { createCameraTracks: ReturnType<typeof vi.fn> } {
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
export function fakeDeps(
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

/** Registers the shared beforeEach for every screenShareTracks test file. */
export function useScreenShareTracksHarness(): void {
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
}

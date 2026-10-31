import { beforeEach, expect, vi, type Mock } from "vitest";
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

export function cameraState(): { manualCameraTrack: LocalVideoTrack | null } {
  return { manualCameraTrack: null as LocalVideoTrack | null };
}

/** Makes the native camera support check wait; returns the function that answers it. */
export function holdNativeCameraSupport(): (s: { available: boolean; missing: string[] }) => void {
  let resolveSupport!: (s: { available: boolean; missing: string[] }) => void;
  nativeCameraSupport.mockReturnValue(
    new Promise((resolve) => {
      resolveSupport = resolve;
    }),
  );
  return (s) => resolveSupport(s);
}

/** Starts enableCamera with a publish that stays in flight until `resolvePublish()`. */
export async function enableCameraHoldingPublish(rig: RoomRig) {
  const deps = fakeDeps(rig.room);
  const track = fakeVideoTrack();
  createLocalVideoTrack.mockResolvedValue(track);
  let resolvePublish!: () => void;
  rig.publishTrack.mockReturnValue(
    new Promise<void>((resolve) => {
      resolvePublish = resolve;
    }),
  );
  const state = cameraState();
  const enabling = enableCamera(state, deps);
  await vi.waitFor(() => {
    expect(rig.publishTrack).toHaveBeenCalled();
  });
  return { deps, track, state, enabling, resolvePublish: () => resolvePublish() };
}

/** Fires "ended" on the track and expects the camera to be announced off and unpublished. */
export async function expectUnplugTurnsCameraOff(
  rig: RoomRig,
  deps: ReturnType<typeof fakeDeps>,
  state: { manualCameraTrack: LocalVideoTrack | null },
  video: LocalVideoTrack,
): Promise<void> {
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
}

export function expectAnnounced(
  deps: { wsSend: ReturnType<typeof vi.fn> },
  type: "voice_camera" | "voice_screenshare",
  enabled: boolean,
): void {
  expect(deps.wsSend).toHaveBeenCalledWith({ type, payload: { enabled } });
}

export function expectNotAnnounced(
  deps: { wsSend: ReturnType<typeof vi.fn> },
  type: "voice_camera" | "voice_screenshare",
  enabled: boolean,
): void {
  expect(deps.wsSend).not.toHaveBeenCalledWith({ type, payload: { enabled } });
}

/** Shares the screen with a video and an audio track on a fresh room. */
export async function publishScreenWithAudio() {
  const rig = fakeRoom();
  const video = fakeVideoTrack();
  const audio = fakeAudioTrack();
  createLocalScreenTracks.mockResolvedValue([video, audio]);
  await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));
  return { rig, video, audio };
}

/** The publish options the room was given for `track`. */
export function publishedOptions(rig: RoomRig, track: unknown): unknown {
  return rig.publishTrack.mock.calls.find((c) => c[0] === track)?.[1];
}

/** Enables the camera on a fresh room with a fake device track. */
export async function publishCamera(): Promise<RoomRig> {
  const rig = fakeRoom();
  createLocalVideoTrack.mockResolvedValue(fakeVideoTrack());
  await enableCamera({ manualCameraTrack: null }, fakeDeps(rig.room));
  return rig;
}

/** Shares the screen on a fresh room with the given captured tracks. */
export async function publishScreen(tracks: LocalTrack[]): Promise<RoomRig> {
  const rig = fakeRoom();
  createLocalScreenTracks.mockResolvedValue(tracks);
  await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));
  return rig;
}

export function firstPublishOptions(rig: RoomRig): Record<string, unknown> {
  return rig.publishTrack.mock.calls[0]?.[1] as Record<string, unknown>;
}

/** Starts enableCamera on a native room and returns once its support check is in flight. */
export async function enableCameraAwaitingSupport() {
  const rig = fakeNativeRoom();
  const deps = fakeDeps(rig.room);
  const resolveSupport = holdNativeCameraSupport();
  const state = cameraState();
  const enabling = enableCamera(state, deps);
  await vi.waitFor(() => {
    expect(nativeCameraSupport).toHaveBeenCalled();
  });
  return { rig, deps, resolveSupport, state, enabling };
}

/** Reconciles with nothing live while the server still holds both flags. */
export function reconcileStaleFlags(deps: ReturnType<typeof fakeDeps>): void {
  reconcileVideoFlags({ manualCameraTrack: null }, { manualScreenTracks: [] }, deps, {
    camera: true,
    screenshare: true,
  });
}

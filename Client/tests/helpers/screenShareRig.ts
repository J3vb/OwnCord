import { vi, type Mock } from "vitest";
import type { Room } from "livekit-client";
import type { WsClient } from "@lib/ws";
import type { enableScreenshare } from "@lib/voice/screenShare";

export type ScreenShareDeps = Parameters<typeof enableScreenshare>[1] & {
  onError: Mock<(message: string) => void>;
};

/** A room whose local participant publishes into spies, a socket spy and the share deps over both. */
export function screenShareRig(wsSend: Mock = vi.fn(() => "id")) {
  const publishTrack = vi.fn().mockResolvedValue(undefined);
  const unpublishTrack = vi.fn().mockResolvedValue(undefined);
  const room = {
    localParticipant: {
      publishTrack,
      unpublishTrack,
      setScreenShareEnabled: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Room;
  const ws = { send: wsSend } as unknown as WsClient;
  const deps: ScreenShareDeps = {
    getRoom: () => room,
    getWs: () => ws,
    onError: vi.fn<(message: string) => void>(),
    reapplyAudioPipeline: vi.fn(),
  };
  return { room, publishTrack, unpublishTrack, wsSend, deps };
}

/**
 * Factory body for `vi.mock("livekit-client", (importOriginal) => ...)`: the real
 * module with `createLocalScreenTracks` routed to `createTracks` and, with
 * `fakeAudio`, a `LocalAudioTrack` that wraps a plain media track.
 */
export async function livekitScreenMock(
  importOriginal: <T>() => Promise<T>,
  createTracks: (...args: unknown[]) => unknown,
  fakeAudio: boolean,
) {
  const actual = await importOriginal<typeof import("livekit-client")>();
  class FakeLocalAudioTrack {
    readonly kind = actual.Track.Kind.Audio;
    constructor(readonly mediaStreamTrack: MediaStreamTrack) {}
    stop(): void {
      this.mediaStreamTrack.stop();
    }
  }
  return {
    ...actual,
    ...(fakeAudio ? { LocalAudioTrack: FakeLocalAudioTrack } : {}),
    createLocalScreenTracks: (...args: unknown[]) => createTracks(...args),
  };
}

/** Factory body for `@lib/prefs/preferences` where every pref reads as its fallback. */
export function fallbackPrefsMock(savePref: Mock = vi.fn()) {
  return {
    loadPref: (_key: string, fallback: unknown) => fallback,
    savePref: (...args: unknown[]) => savePref(...args) as unknown,
  };
}

type Spy = (...args: unknown[]) => unknown;

/** Factory body for `@tauri-apps/api/core` with `invoke` routed to a spy read at call time. */
export function tauriInvokeMock(invoke: Spy) {
  return { invoke: (...args: unknown[]) => invoke(...args) };
}

/** Factory body for the app-audio socket step with `openAppAudio` routed to a spy. */
export function appAudioTrackMock(openAppAudio: Spy) {
  return { openAppAudio: (...args: unknown[]) => openAppAudio(...args) };
}

import { beforeEach, vi } from "vitest";
import { Encryption_Type, Track } from "livekit-client";
import type {
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
} from "livekit-client";
import { createRoomEventHandlers } from "@lib/voice/roomEventHandlers";
import type { RoomEventDeps } from "@lib/voice/roomEventHandlers";
import { voiceStore } from "@stores/voice.store";
import type { AudioElements } from "@lib/voice/audioElements";

// ── fakes ──────────────────────────────────────────────────────────────────

export function fakeAudioElements(): AudioElements & {
  handleTrackSubscribedAudio: ReturnType<typeof vi.fn>;
  handleTrackUnsubscribedAudio: ReturnType<typeof vi.fn>;
  cleanupAllAudioElements: ReturnType<typeof vi.fn>;
} {
  return {
    handleTrackSubscribedAudio: vi.fn(),
    handleTrackUnsubscribedAudio: vi.fn(),
    cleanupAllAudioElements: vi.fn(),
    getEffectiveVolume: vi.fn().mockReturnValue(1),
  } as unknown as AudioElements & {
    handleTrackSubscribedAudio: ReturnType<typeof vi.fn>;
    handleTrackUnsubscribedAudio: ReturnType<typeof vi.fn>;
    cleanupAllAudioElements: ReturnType<typeof vi.fn>;
  };
}

export interface Harness {
  deps: RoomEventDeps;
  handlers: ReturnType<typeof createRoomEventHandlers>;
  audioElements: ReturnType<typeof fakeAudioElements>;
  room: {
    canPlaybackAudio: boolean;
    startAudio: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    localParticipant: { identity: string; sid: string };
    remoteParticipants: Map<string, RemoteParticipant>;
    activeSpeakers: Participant[];
  };
  spies: {
    applyMicMuteState: ReturnType<typeof vi.fn>;
    setupAudioPipeline: ReturnType<typeof vi.fn>;
    attemptAutoReconnect: ReturnType<typeof vi.fn>;
    teardownForReconnect: ReturnType<typeof vi.fn>;
    leaveVoice: ReturnType<typeof vi.fn>;
    setRoom: ReturnType<typeof vi.fn>;
    setReconnectAc: ReturnType<typeof vi.fn>;
    syncModuleRooms: ReturnType<typeof vi.fn>;
    onRemoteVideo: ReturnType<typeof vi.fn>;
    onRemoteVideoRemoved: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    isWatched: ReturnType<typeof vi.fn>;
  };
}

export function build(over: Partial<RoomEventDeps> = {}): Harness {
  const audioElements = fakeAudioElements();
  const room = {
    canPlaybackAudio: true,
    startAudio: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    localParticipant: { identity: "user-1:tok", sid: "PA_me" },
    remoteParticipants: new Map<string, RemoteParticipant>(),
    activeSpeakers: [] as Participant[],
  };
  const spies = {
    applyMicMuteState: vi.fn().mockResolvedValue(undefined),
    setupAudioPipeline: vi.fn(),
    attemptAutoReconnect: vi.fn().mockResolvedValue(undefined),
    teardownForReconnect: vi.fn(),
    leaveVoice: vi.fn(),
    setRoom: vi.fn(),
    setReconnectAc: vi.fn(),
    syncModuleRooms: vi.fn(),
    onRemoteVideo: vi.fn(),
    onRemoteVideoRemoved: vi.fn(),
    onError: vi.fn(),
    isWatched: vi.fn((_userId: number, _isScreenshare: boolean) => false),
  };

  const deps: RoomEventDeps = {
    getRoom: () => room as unknown as Room,
    setRoom: spies.setRoom,
    getCurrentChannelId: () => 12,
    getAudioElements: () => audioElements,
    getOnRemoteVideoCallback: () => spies.onRemoteVideo,
    getOnRemoteVideoRemovedCallback: () => spies.onRemoteVideoRemoved,
    isWatched: spies.isWatched,
    getOnErrorCallback: () => spies.onError,
    isConnecting: () => false,
    isReconnecting: () => false,
    getLatestToken: () => "tok",
    getLastUrl: () => "wss://lk.example",
    getLastDirectUrl: () => undefined,
    setReconnectAc: spies.setReconnectAc,
    syncModuleRooms: spies.syncModuleRooms,
    teardownForReconnect: spies.teardownForReconnect,
    leaveVoice: spies.leaveVoice,
    applyMicMuteState: spies.applyMicMuteState,
    setupAudioPipeline: spies.setupAudioPipeline,
    isNativeRoom: () => false,
    attemptAutoReconnect: spies.attemptAutoReconnect,
    ...over,
  };

  return { deps, handlers: createRoomEventHandlers(deps), audioElements, room, spies };
}

export function audioTrack(): RemoteTrack {
  return {
    kind: Track.Kind.Audio,
    sid: "AT_1",
    detach: vi.fn(),
    mediaStreamTrack: {} as MediaStreamTrack,
  } as unknown as RemoteTrack;
}

export function videoTrack(): RemoteTrack & { detach: ReturnType<typeof vi.fn> } {
  return {
    kind: Track.Kind.Video,
    sid: "VT_1",
    detach: vi.fn(),
    mediaStreamTrack: { id: "mst" } as MediaStreamTrack,
  } as unknown as RemoteTrack & { detach: ReturnType<typeof vi.fn> };
}

export function pub(source: Track.Source): RemoteTrackPublication {
  return { source } as unknown as RemoteTrackPublication;
}

export function participant(identity: string): RemoteParticipant {
  return { identity } as unknown as RemoteParticipant;
}

// ── opt-in watching: what is subscribed ────────────────────────────────────

/** A remote publication whose subscription the handlers set. */
export function remotePub(
  source: Track.Source,
): RemoteTrackPublication & { setSubscribed: ReturnType<typeof vi.fn> } {
  const kind =
    source === Track.Source.Camera || source === Track.Source.ScreenShare
      ? Track.Kind.Video
      : Track.Kind.Audio;
  return {
    source,
    kind,
    trackSid: `TR_${source}`,
    setSubscribed: vi.fn(),
  } as unknown as RemoteTrackPublication & { setSubscribed: ReturnType<typeof vi.fn> };
}

// ── end-to-end encryption of remote media ─────────────────────────────────

export function withEncryption<T extends RemoteTrackPublication>(
  publication: T,
  encryption: Encryption_Type,
): T {
  return Object.assign(publication, { trackInfo: { encryption } });
}

// ── track routing edge cases ───────────────────────────────────────────────

export function unknownTrack(): RemoteTrack & { detach: ReturnType<typeof vi.fn> } {
  return {
    kind: Track.Kind.Unknown,
    sid: "UT_1",
    detach: vi.fn(),
    mediaStreamTrack: { id: "mst" } as MediaStreamTrack,
  } as unknown as RemoteTrack & { detach: ReturnType<typeof vi.fn> };
}

/** Registers the shared beforeEach for every roomEventHandlers test file. */
export function useRoomEventHandlersHarness(): void {
  beforeEach(() => {
    voiceStore.setState((prev) => ({
      ...prev,
      localMuted: false,
      localDeafened: false,
      encryptionDegraded: false,
    }));
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

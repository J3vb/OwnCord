// The room as the voice modules use it. livekit-client's `Room` (web, macOS,
// Windows) and the Linux `NativeRoom` both satisfy it structurally, so the
// shared modules hold a `VoiceRoom` and neither needs a cast. Anything only the
// browser path touches stays on the full `Room` where it is built.
import type {
  ConnectionState,
  LocalTrack,
  RoomConnectOptions,
  RoomEventCallbacks,
  Track,
  TrackPublishOptions,
  VideoQuality,
} from "livekit-client";

export type VoiceRoomState = `${ConnectionState}`;

/** A local track as the publications hand it back. */
export interface VoiceLocalTrack {
  readonly mediaStreamTrack: MediaStreamTrack;
}

/** A track the Linux host captures: the slice of `LocalTrack` the share path reads. */
export interface VoiceCapturedTrack {
  readonly kind: string;
  readonly mediaStreamTrack: MediaStreamTrack;
  stop(): void;
}

export interface VoiceLocalPublication {
  readonly trackSid: string;
  readonly source: string;
  readonly kind: string;
  readonly isMuted: boolean;
  readonly track?: VoiceLocalTrack;
}

export interface VoiceLocalParticipant {
  readonly identity: string;
  readonly permissions?: { canPublish: boolean; canPublishSources: number[] };
  readonly trackPublications: ReadonlyMap<string, VoiceLocalPublication>;
  getTrackPublication(source: Track.Source): VoiceLocalPublication | undefined;
  setMicrophoneEnabled(
    enabled: boolean,
    captureOptions?: unknown,
    publishOptions?: { audioPreset?: { maxBitrate: number } },
  ): Promise<unknown>;
  setCameraEnabled(enabled: boolean): Promise<unknown>;
  setScreenShareEnabled(enabled: boolean): Promise<unknown>;
  publishTrack(track: LocalTrack, options: TrackPublishOptions): Promise<unknown>;
  unpublishTrack(track: LocalTrack | MediaStreamTrack, stopOnUnpublish?: boolean): Promise<unknown>;
  createScreenTracks(): Promise<Array<LocalTrack | VoiceCapturedTrack>>;
}

/** What a receiver-stats lookup reads off a subscribed remote video track. */
export interface VoiceRemoteTrack {
  readonly sid?: string;
  readonly currentBitrate?: number;
  getReceiverStats?(): Promise<
    | {
        frameWidth?: number;
        frameHeight?: number;
        framesDecoded?: number;
        timestamp: number;
        mimeType?: string;
        packetsLost?: number;
        packetsReceived?: number;
        framesDropped?: number;
        framesReceived?: number;
        decoderImplementation?: string;
        jitterBufferDelay?: number;
      }
    | undefined
  >;
}

export interface VoiceRemotePublication {
  readonly trackSid: string;
  readonly source: string;
  readonly kind: string;
  readonly isSubscribed: boolean;
  readonly isEnabled: boolean;
  readonly isMuted: boolean;
  readonly track?: VoiceRemoteTrack;
  readonly trackInfo?: { readonly encryption?: number };
  setSubscribed(subscribed: boolean): void;
  setEnabled(enabled: boolean): void;
  setVideoQuality(quality: VideoQuality): void;
  setVideoDimensions(dimensions: { width: number; height: number }): void;
}

export interface VoiceRemoteParticipant {
  readonly identity: string;
  /** The SFU's id for the session; the native room has none. */
  readonly sid?: string;
  readonly trackPublications: ReadonlyMap<string, VoiceRemotePublication>;
  readonly audioTrackPublications: ReadonlyMap<string, VoiceRemotePublication>;
  getTrackPublication(source: string): VoiceRemotePublication | undefined;
  getVolume(): number | undefined;
  setVolume(volume: number): void;
}

/** A transport's stats report: entries by id. */
export type VoiceStatsReport = ReadonlyMap<string, Record<string, unknown>>;

/** A peer-connection transport's stats and state readers. */
export interface VoiceStatsTransport {
  getStats(): Promise<VoiceStatsReport | undefined> | undefined;
  getICEConnectionState(): string;
  getConnectionState(): string;
  getSignallingState(): string;
}

export interface VoiceRoom {
  readonly name: string;
  readonly state: VoiceRoomState;
  readonly canPlaybackAudio: boolean;
  activeSpeakers?: Array<{ readonly identity: string }>;
  readonly localParticipant: VoiceLocalParticipant;
  readonly remoteParticipants: ReadonlyMap<string, VoiceRemoteParticipant>;
  readonly engine: {
    readonly pcManager?: {
      readonly publisher?: VoiceStatsTransport;
      readonly subscriber?: VoiceStatsTransport;
    };
    readonly client: { readonly ws?: { readonly readyState: number } };
  };
  on<E extends keyof RoomEventCallbacks>(event: E, listener: RoomEventCallbacks[E]): this;
  off<E extends keyof RoomEventCallbacks>(event: E, listener: RoomEventCallbacks[E]): this;
  once?<E extends keyof RoomEventCallbacks>(event: E, listener: RoomEventCallbacks[E]): this;
  connect(url: string, token: string, opts?: RoomConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  startAudio(): Promise<void>;
  switchActiveDevice(kind: MediaDeviceKind, deviceId: string, exact?: boolean): Promise<boolean>;
  getActiveDevice?(kind: MediaDeviceKind): string | undefined;
}

// Dependency and handler shapes of the room event handlers. Split from
// roomEventHandlers.ts, which re-exports them.

import type {
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  Participant,
  LocalTrackPublication,
  TrackPublication,
  DisconnectReason,
} from "livekit-client";
import type { AudioElements } from "@lib/voice/audioElements";
import type {
  VoiceRemoteParticipant,
  VoiceRemotePublication,
  VoiceRoom,
} from "@lib/voice/voiceRoom";

// --- Callback types ---

/** A null stream: published but not watched, a tile with a Watch button. */
export type RemoteVideoCallback = (
  userId: number,
  stream: MediaStream | null,
  isScreenshare: boolean,
) => void;
export type RemoteVideoRemovedCallback = (userId: number, isScreenshare: boolean) => void;

// --- Dependencies passed from LiveKitSession ---

export interface RoomEventDeps {
  getRoom: () => VoiceRoom | null;
  setRoom: (room: VoiceRoom | null) => void;
  getCurrentChannelId: () => number | null;
  getAudioElements: () => AudioElements;
  getOnRemoteVideoCallback: () => RemoteVideoCallback | null;
  getOnRemoteVideoRemovedCallback: () => RemoteVideoRemovedCallback | null;
  /** The viewer chose to watch this user's camera or screen share. */
  isWatched: (userId: number, isScreenshare: boolean) => boolean;
  getOnErrorCallback: () => ((message: string) => void) | null;
  isConnecting: () => boolean;
  isReconnecting: () => boolean;
  getLatestToken: () => string | null;
  getLastUrl: () => string | null;
  getLastDirectUrl: () => string | undefined;
  setReconnectAc: (ac: AbortController | null) => void;
  syncModuleRooms: () => void;
  teardownForReconnect: () => void;
  leaveVoice: (sendWs: boolean) => void;
  applyMicMuteState: (muted: boolean) => Promise<void>;
  /** Attach the mic processor to a published microphone that has none. */
  setupAudioPipeline: () => void;
  /** The room is the native backend's, whose decrypt reports are not
   *  rate-limited (see DECRYPT_QUIET_MS). */
  isNativeRoom: () => boolean;
  attemptAutoReconnect: (
    token: string,
    url: string,
    channelId: number,
    directUrl: string | undefined,
    signal: AbortSignal,
  ) => Promise<void>;
}

// --- Factory: creates bound event handler arrow functions ---

export interface RoomEventHandlers {
  readonly handleLocalTrackPublished: (publication: LocalTrackPublication) => void;
  readonly handleTrackSubscribed: (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => void;
  readonly handleTrackUnsubscribed: (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => void;
  readonly handleTrackPublished: (
    publication: VoiceRemotePublication,
    participant: VoiceRemoteParticipant,
  ) => void;
  readonly handleTrackUnpublished: (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => void;
  /** The room joined: the participants already in it publish no TrackPublished. */
  readonly handleConnected: (room: VoiceRoom) => void;
  readonly handleActiveSpeakersChanged: (speakers: Participant[]) => void;
  readonly handleParticipantDisconnected: (participant: RemoteParticipant) => void;
  readonly handleTrackMuted: (publication: TrackPublication, participant: Participant) => void;
  readonly handleAudioPlaybackChanged: () => void;
  readonly handleDisconnected: (reason?: DisconnectReason) => void;
  readonly handleSdkReconnecting: () => void;
  readonly handleSdkReconnected: () => void;
  readonly handleEncryptionError: (error: Error, participant?: Participant) => void;
  readonly removeAutoplayUnlock: () => void;
  /** A room key was installed into the E2EE worker: the next remote decrypt
   *  failure starts a fresh grace window. */
  readonly noteRoomKeyInstalled: () => void;
  /** Forget the session's encryption-recovery state (leave). */
  readonly resetEncryptionRecovery: () => void;
}

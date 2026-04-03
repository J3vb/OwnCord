// LiveKit room event handler factories — extracted from livekitSession.ts
import {
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type Participant,
  type LocalTrackPublication,
  DisconnectReason,
} from "livekit-client";
import { voiceStore, setSpeakers, leaveVoiceChannel } from "@stores/voice.store";
import { createLogger } from "@lib/logger";
import { parseUserId } from "@lib/livekitSession";
import type { AudioElements } from "@lib/audioElements";

const log = createLogger("roomEventHandlers");

// --- Callback types ---

type RemoteVideoCallback = (userId: number, stream: MediaStream, isScreenshare: boolean) => void;
type RemoteVideoRemovedCallback = (userId: number, isScreenshare: boolean) => void;

// --- Dependencies passed from LiveKitSession ---

export interface RoomEventDeps {
  getRoom: () => import("livekit-client").Room | null;
  setRoom: (room: import("livekit-client").Room | null) => void;
  getCurrentChannelId: () => number | null;
  getAudioElements: () => AudioElements;
  getOnRemoteVideoCallback: () => RemoteVideoCallback | null;
  getOnRemoteVideoRemovedCallback: () => RemoteVideoRemovedCallback | null;
  getOnErrorCallback: () => ((message: string) => void) | null;
  isConnecting: () => boolean;
  getLatestToken: () => string | null;
  getLastUrl: () => string | null;
  getLastDirectUrl: () => string | undefined;
  setReconnectAc: (ac: AbortController | null) => void;
  syncModuleRooms: () => void;
  teardownForReconnect: () => void;
  leaveVoice: (sendWs: boolean) => void;
  applyMicMuteState: (muted: boolean) => Promise<void>;
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
  readonly handleActiveSpeakersChanged: (speakers: Participant[]) => void;
  readonly handleAudioPlaybackChanged: () => void;
  readonly handleDisconnected: (reason?: DisconnectReason) => void;
  readonly removeAutoplayUnlock: () => void;
}

export function createRoomEventHandlers(deps: RoomEventDeps): RoomEventHandlers {
  let autoplayUnlockHandler: (() => void) | null = null;

  function removeAutoplayUnlock(): void {
    if (autoplayUnlockHandler !== null) {
      document.removeEventListener("click", autoplayUnlockHandler);
      autoplayUnlockHandler = null;
    }
  }

  const handleLocalTrackPublished = (publication: LocalTrackPublication): void => {
    if (publication.source === Track.Source.Microphone) {
      const { localMuted, localDeafened } = voiceStore.getState();
      if (localMuted || localDeafened) {
        deps.applyMicMuteState(true).catch((e) => log.warn("applyMicMuteState failed", e));
        log.debug("LocalTrackPublished: re-applied mute to mic track");
      }
    }
  };

  const handleTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void => {
    const userId = parseUserId(participant.identity);
    if (track.kind === Track.Kind.Audio) {
      deps.getAudioElements().handleTrackSubscribedAudio(track, publication, participant);
    } else if (track.kind === Track.Kind.Video) {
      const cb = deps.getOnRemoteVideoCallback();
      if (userId > 0 && cb !== null) {
        const stream = new MediaStream([track.mediaStreamTrack]);
        const isScreenshare = publication.source === Track.Source.ScreenShare;
        cb(userId, stream, isScreenshare);
      }
      log.debug("Remote video track subscribed", { userId, trackSid: track.sid });
    }
  };

  const handleTrackUnsubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void => {
    const userId = parseUserId(participant.identity);
    if (track.kind === Track.Kind.Audio) {
      deps.getAudioElements().handleTrackUnsubscribedAudio(track, publication, participant);
    } else if (track.kind === Track.Kind.Video) {
      track.detach();
      const isScreenshare = publication.source === Track.Source.ScreenShare;
      if (userId > 0) deps.getOnRemoteVideoRemovedCallback()?.(userId, isScreenshare);
      log.debug("Remote video track unsubscribed", { userId, trackSid: track.sid });
    }
  };

  const handleActiveSpeakersChanged = (speakers: Participant[]): void => {
    const channelId = deps.getCurrentChannelId();
    if (channelId === null) return;
    const speakerIds: number[] = [];
    for (const speaker of speakers) {
      const userId = parseUserId(speaker.identity);
      if (userId > 0) speakerIds.push(userId);
    }
    speakerIds.sort((x, y) => x - y);
    setSpeakers({ channel_id: channelId, speakers: speakerIds });
  };

  const handleAudioPlaybackChanged = (): void => {
    const room = deps.getRoom();
    if (room === null) return;
    if (room.canPlaybackAudio) {
      log.info("Audio playback is now allowed");
      removeAutoplayUnlock();
      return;
    }
    log.warn("Audio playback blocked by browser — registering click-to-unlock");
    removeAutoplayUnlock();
    autoplayUnlockHandler = () => {
      const r = deps.getRoom();
      if (r !== null) {
        void r.startAudio().then(() => {
          log.info("Audio playback unlocked via user gesture");
        });
      }
      removeAutoplayUnlock();
    };
    document.addEventListener("click", autoplayUnlockHandler, { once: true });
  };

  const handleDisconnected = (reason?: DisconnectReason): void => {
    log.info("LiveKit room disconnected", { reason });
    if (deps.isConnecting()) {
      log.info("Disconnect during initial connect — deferring to retry loop");
      return;
    }
    const isUnexpected = reason !== DisconnectReason.CLIENT_INITIATED;
    if (
      isUnexpected &&
      deps.getLatestToken() !== null &&
      deps.getCurrentChannelId() !== null &&
      deps.getLastUrl() !== null
    ) {
      const token = deps.getLatestToken()!;
      const url = deps.getLastUrl()!;
      const channelId = deps.getCurrentChannelId()!;
      const directUrl = deps.getLastDirectUrl();
      // Clean up current room without sending WS leave (we're reconnecting, not leaving).
      deps.teardownForReconnect();
      removeAutoplayUnlock();
      deps.getAudioElements().cleanupAllAudioElements();
      const room = deps.getRoom();
      if (room !== null) {
        deps.setRoom(null);
        deps.syncModuleRooms();
        room.removeAllListeners();
        room.disconnect().catch((err) => log.warn("Failed to disconnect stale room", err));
      }
      const ac = new AbortController();
      deps.setReconnectAc(ac);
      void deps.attemptAutoReconnect(token, url, channelId, directUrl, ac.signal);
      return;
    }
    deps.leaveVoice(false);
    leaveVoiceChannel();
    if (isUnexpected) deps.getOnErrorCallback()?.("Voice connection lost — disconnected");
  };

  return {
    handleLocalTrackPublished,
    handleTrackSubscribed,
    handleTrackUnsubscribed,
    handleActiveSpeakersChanged,
    handleAudioPlaybackChanged,
    handleDisconnected,
    removeAutoplayUnlock,
  };
}

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
import {
  voiceStore,
  setSpeakers,
  leaveVoiceChannel,
  setEncryptionDegraded,
  setVoiceStatus,
} from "@stores/voice.store";
import { createLogger } from "@lib/logger";
import { parseUserId } from "../features/voice/sessionState";
import { detachRoom } from "../features/voice/releaseRoom";
import {
  markFirstRemoteTrackSubscribed,
  markLocalTrackPublished,
  recordDecryptError,
} from "@lib/voiceJoinTrace";
import type { AudioElements } from "@lib/audioElements";
import { voiceText } from "../i18n/voice";

const log = createLogger("roomEventHandlers");

/** OC-0452: how long a remote sender's decrypt failures may last before they
 *  count as a real E2EE failure. A streak starts fresh only after a room key
 *  install: a quiet gap alone is no evidence the peer's frames decrypt again,
 *  while every rotation race comes with its own install. */
const DECRYPT_GRACE_MS = 3000;
/** How long without a remote decrypt failure before a native room's decrypt
 *  degradation counts as recovered. It sits above the native room's 1 s
 *  re-report cadence while a peer keeps failing. */
const NATIVE_DECRYPT_QUIET_MS = 2500;

/** How long the SDK may spend resuming a cut signal connection before the
 *  widget abandons the room (see armStallTimer). */
const SIGNAL_RESUME_BUDGET_MS = 10_000;

/** Polish #21: how long without a remote decrypt failure before a decrypt
 *  degradation counts as recovered on the browser path (the native room
 *  re-reports every second while a peer fails, so its shorter quiet window
 *  is enough). livekit-client's ErrorRateLimiter lets the worker report a
 *  failing peer at most 5 times per 60 s window, so a failure that persists
 *  goes quiet for most of each minute; only a gap longer than that window
 *  means the frames decrypt again. */
const DECRYPT_QUIET_MS = 65_000;

/** RT-9: the status a room that has just finished joining reports. The key
 *  can arrive over WS after the SFU dropped and livekit-client is already
 *  retrying on its own; that room reads "reconnecting" until
 *  RoomEvent.Reconnected clears it (handleSdkReconnected). */
export function setJoinedVoiceStatus(room: import("livekit-client").Room): void {
  setVoiceStatus(
    room.state === "reconnecting" || room.state === "signalReconnecting"
      ? "reconnecting"
      : "connected",
  );
}

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
  readonly handleActiveSpeakersChanged: (speakers: Participant[]) => void;
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

export function createRoomEventHandlers(deps: RoomEventDeps): RoomEventHandlers {
  let autoplayUnlockHandler: (() => void) | null = null;
  // Polish #21: a transient >3s key-delivery stall set the Secured badge to
  // "Unsecured" and nothing ever cleared it until the next join/leave. A
  // quiet gap past the room's quiet window means the peer's frames decrypt
  // again — clear only what THIS path degraded, leaving a persistent
  // worker-death/MissingKey degradation visible (OC-0002).
  // "other" latches: once anything else degrades the call, a quiet gap
  // must not clear it.
  let degradedBy: "decrypt" | "other" | null = null;
  let decryptQuietTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let stallRoom: import("livekit-client").Room | null = null;
  /** Room key installs so far. A decrypt streak continues only while this is
   *  unchanged, so event order never rests on clock resolution. */
  let keyInstalls = 0;

  function clearDecryptQuietTimer(): void {
    if (decryptQuietTimer !== null) {
      clearTimeout(decryptQuietTimer);
      decryptQuietTimer = null;
    }
  }

  /** Arm the recovery: no further remote decrypt failure for the quiet
   *  window means delivery resumed. */
  function armDecryptRecovery(): void {
    clearDecryptQuietTimer();
    decryptQuietTimer = setTimeout(
      () => {
        decryptQuietTimer = null;
        if (degradedBy === "decrypt") {
          degradedBy = null;
          setEncryptionDegraded(false);
        }
      },
      deps.isNativeRoom() ? NATIVE_DECRYPT_QUIET_MS : DECRYPT_QUIET_MS,
    );
  }

  function noteRoomKeyInstalled(): void {
    keyInstalls++;
  }

  function resetEncryptionRecovery(): void {
    clearDecryptQuietTimer();
    degradedBy = null;
  }

  function removeAutoplayUnlock(): void {
    if (autoplayUnlockHandler !== null) {
      document.removeEventListener("click", autoplayUnlockHandler);
      autoplayUnlockHandler = null;
    }
  }

  const handleLocalTrackPublished = (publication: LocalTrackPublication): void => {
    // SRE-M2: join-relative ms for the first local track publication.
    markLocalTrackPublished();
    if (publication.source === Track.Source.Microphone) {
      // The processor is attached before the first publish and rides every
      // republish; this only covers a microphone that somehow has none.
      deps.setupAudioPipeline();
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
    // SRE-M2: join-relative ms for the first remote track subscription.
    markFirstRemoteTrackSubscribed();
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

  /** Drop the session room without leaving the call and run the app's own
   *  reconnect loop with the stored token. False when there is nothing to
   *  reconnect with (no token, channel or URL). */
  function abandonRoomAndReconnect(): boolean {
    const token = deps.getLatestToken();
    const url = deps.getLastUrl();
    const channelId = deps.getCurrentChannelId();
    if (token === null || url === null || channelId === null) return false;
    const directUrl = deps.getLastDirectUrl();
    // Clean up current room without sending WS leave (we're reconnecting, not leaving).
    deps.teardownForReconnect();
    removeAutoplayUnlock();
    deps.getAudioElements().cleanupAllAudioElements();
    const room = deps.getRoom();
    if (room !== null) {
      deps.setRoom(null);
      deps.syncModuleRooms();
      detachRoom(room);
      room.disconnect().catch((err) => log.warn("Failed to disconnect stale room", err));
    }
    const ac = new AbortController();
    deps.setReconnectAc(ac);
    void deps.attemptAutoReconnect(token, url, channelId, directUrl, ac.signal);
    return true;
  }

  const handleDisconnected = (reason?: DisconnectReason): void => {
    log.info("LiveKit room disconnected", { reason });
    clearStallTimer();
    if (deps.isConnecting() || deps.isReconnecting()) {
      // The bundled livekit-client fires this event synchronously on every
      // failed reconnect attempt inside the retry loop's own room.connect()
      // call, before that call rejects — the active loop already owns retry
      // and cleanup, so a second entry here must not start a second,
      // uncancellable attemptAutoReconnect loop (mirrors the initial-connect guard above).
      log.info("Disconnect during connect/reconnect — deferring to retry loop");
      return;
    }
    const isUnexpected = reason !== DisconnectReason.CLIENT_INITIATED;
    if (isUnexpected && abandonRoomAndReconnect()) return;
    deps.leaveVoice(false);
    leaveVoiceChannel();
    if (isUnexpected) deps.getOnErrorCallback()?.(voiceText("event.voiceDisconnected"));
  };

  /** The SDK resumes a cut signal socket up to 10 times, each allowed 15 s,
   *  before it emits Disconnected, so a cut nobody answers freezes every stream
   *  for minutes. Once the budget passes without Reconnected or Disconnected
   *  the room is abandoned for the app's own loop, which also rejoins when the
   *  server has released the membership. The first event arms it; the
   *  Reconnecting that follows SignalReconnecting does not extend it. */
  function clearStallTimer(): void {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
      stallRoom = null;
    }
  }

  function armStallTimer(room: import("livekit-client").Room): void {
    if (stallTimer !== null && stallRoom === room) return;
    clearStallTimer();
    stallRoom = room;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      stallRoom = null;
      // Only the room that stalled: the user may have left or a newer attempt
      // replaced it while the SDK was retrying.
      if (deps.getRoom() !== room) return;
      log.warn("LiveKit resume stalled — abandoning room for the reconnect loop", {
        budgetMs: SIGNAL_RESUME_BUDGET_MS,
      });
      abandonRoomAndReconnect();
    }, SIGNAL_RESUME_BUDGET_MS);
  }

  /** RT-9: livekit-client (and the native room) retry a dropped signal socket
   *  on their own — RoomEvent.SignalReconnecting / Reconnecting — before they
   *  give up with Disconnected, and an SFU restart spends most of its window
   *  there. Only the connected session room moves the badge, and only between
   *  "connected" and "reconnecting", so a join still securing its key and the
   *  retry loop's own attempt rooms are left alone. */
  const handleSdkReconnecting = (): void => {
    const room = deps.getRoom();
    const status = voiceStore.getState().voiceStatus;
    if (room === null || (status !== "connected" && status !== "reconnecting")) return;
    if (status === "connected") setVoiceStatus("reconnecting");
    armStallTimer(room);
  };
  const handleSdkReconnected = (): void => {
    clearStallTimer();
    if (deps.getRoom() !== null && voiceStore.getState().voiceStatus === "reconnecting")
      setVoiceStatus("connected");
  };

  /** OC-0002: livekit-client's E2eeManager emits RoomEvent.EncryptionError
   *  when the per-room E2EE worker dies (onWorkerError — CSP blocking a
   *  lazily-loaded chunk, WASM load failure, WebView2 quirk) or when an
   *  encrypted track arrives on a room without encryption enabled. Either
   *  way the room key exchange can have already succeeded and voiceStatus
   *  can already read "connected" — this is the SDK's only signal that the
   *  encoder itself is not actually protecting frames, so it must reach the
   *  store the Secured badge reads rather than staying invisible.
   *
   *  OC-0452: the one exception is a remote sender's `InvalidKey` — the
   *  worker raises it only from decryptFrame, when AES-GCM fails with a key
   *  present. Every rotation installs the new key at index 0 before the peer
   *  has it, so a short streak of these is expected; the frames are dropped,
   *  never played in clear. A streak that outlasts the grace window (the
   *  worker re-reports once a second) is a real failure and still degrades.
   *  Only a key install since the streak's last failure starts a new one.
   */
  const decryptStreaks = new WeakMap<Participant, { start: number; keyInstalls: number }>();
  const handleEncryptionError = (error: Error, participant?: Participant): void => {
    // SRE-M2: every receive-side decrypt failure (any error attributed to a
    // remote sender, native or web) counts toward the diagnostics total — a
    // tolerated rotation race is still a dropped frame and the count is what
    // tells a report whether the grace window is being hit constantly.
    if (participant && !participant.isLocal) recordDecryptError();
    if (participant && !participant.isLocal && error.message.startsWith("InvalidKey:")) {
      const now = Date.now();
      const prev = decryptStreaks.get(participant);
      const start = prev && prev.keyInstalls === keyInstalls ? prev.start : now;
      decryptStreaks.set(participant, { start, keyInstalls });
      if (now - start < DECRYPT_GRACE_MS) {
        log.warn("LiveKit E2EE receive-side decrypt failure — tolerating key rotation race", {
          error,
          participant: participant.identity,
        });
        // Still failing: a degradation this path set is not recovered yet.
        if (degradedBy === "decrypt") armDecryptRecovery();
        return;
      }
      // A remote sender's failure past the grace window: its frames stopped
      // decrypting. This is the class that recovers on its own once key
      // delivery resumes, so arm the quiet-gap recovery.
      if (degradedBy !== "other") {
        degradedBy = "decrypt";
        armDecryptRecovery();
      }
    } else {
      degradedBy = "other";
      clearDecryptQuietTimer();
    }
    log.error("LiveKit E2EE encryption error — call may not be secured", {
      error,
      participant: participant?.identity,
    });
    setEncryptionDegraded(true);
  };

  return {
    handleLocalTrackPublished,
    handleTrackSubscribed,
    handleTrackUnsubscribed,
    handleActiveSpeakersChanged,
    handleAudioPlaybackChanged,
    handleDisconnected,
    handleSdkReconnecting,
    handleSdkReconnected,
    handleEncryptionError,
    removeAutoplayUnlock,
    noteRoomKeyInstalled,
    resetEncryptionRecovery,
  };
}

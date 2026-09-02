// AudioElements — manages remote audio elements (mic + screenshare)
//
// Handles HTMLAudioElement lifecycle for remote participants' audio tracks,
// per-user volume, screenshare audio volume/mute, and output device routing.

import {
  Track,
  type Room,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";
import { loadPref, savePref, STORAGE_PREFIX } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import { parseUserId } from "@lib/livekitSession";
import { voiceStore } from "@stores/voice.store";

const log = createLogger("audioElements");

/**
 * Server host the per-user volume prefs below belong to. Mirrors
 * channel-mutes.ts's currentHost — the client is multi-server (one webview
 * origin means one localStorage) and userId is only unique per server, so
 * without a host component a volume set for user 7 on one server would
 * silence user 7 on every other server too. `setAudioVolumeHost` is always
 * called with a real host before any volume is read (see MainPage.ts), so
 * the `null` startup default is not what protects a pre-scoping install's
 * saved volumes — `getSavedUserVolume` does that below by reading through to
 * the original unscoped key on a miss at the scoped one.
 */
let currentHost: string | null = null;

/** Point per-user volume reads/writes at a specific server. Call on connect
 *  and on server switch — mirroring channel-mutes.ts's setChannelMutesHost. */
export function setAudioVolumeHost(host: string | null): void {
  currentHost = host;
}

function userVolumeKey(userId: number): string {
  return currentHost === null ? `userVolume_${userId}` : `userVolume_${userId}:${currentHost}`;
}

// setUserVolume always clamps to 0-200, so -1 is safe as a "nothing saved" sentinel.
const VOLUME_NOT_SET = -1;

/** Get saved per-user volume (0-200 range, default 100). Applied via LiveKit's
 *  GainNode-backed setVolume(). On a miss at the host-scoped key, reads
 *  through to the pre-scoping unscoped key once, persists the result under
 *  the scoped key and consumes the legacy key, so the migration applies to
 *  the FIRST host connected to post-upgrade and no other. User ids are
 *  per-server autoincrement integers: leaving the legacy key in place would
 *  let every later brand-new host miss its own scoped key, read through to
 *  the same legacy value and silence the unrelated user N there too
 *  (OC-0313) — the shape channel-mutes.ts fixed for OC-0288. */
function getSavedUserVolume(userId: number): number {
  const scopedKey = userVolumeKey(userId);
  if (currentHost === null) return loadPref<number>(scopedKey, 100);

  const scoped = loadPref<number>(scopedKey, VOLUME_NOT_SET);
  if (scoped !== VOLUME_NOT_SET) return scoped;

  const legacyKey = `userVolume_${userId}`;
  const legacy = loadPref<number>(legacyKey, VOLUME_NOT_SET);
  if (legacy !== VOLUME_NOT_SET) {
    savePref(scopedKey, legacy);
    localStorage.removeItem(STORAGE_PREFIX + legacyKey);
    return legacy;
  }
  return loadPref<number>(scopedKey, 100);
}

export class AudioElements {
  private room: Room | null = null;

  /** Remote microphone audio elements keyed by track SID for cleanup on disconnect. */
  private remoteMicAudioElements = new Map<string, HTMLAudioElement>();
  /** Screenshare audio elements keyed by userId — separate from mic audio pipeline. */
  private screenshareAudioElements = new Map<number, Set<HTMLAudioElement>>();
  /** Persisted mute state for screenshare audio so replacement tracks inherit UI state. */
  private screenshareAudioMutedByUser = new Map<number, boolean>();
  /** Per-user screenshare volume (0-1, default 1) — kept independent of the
   *  element map so a volume chosen before the track attaches still applies. */
  private screenshareVolumeByUser = new Map<number, number>();

  /** Master output volume multiplier (0-2.0). Per-user volumes are scaled by this. */
  private outputVolumeMultiplier: number;

  constructor() {
    this.outputVolumeMultiplier = loadPref<number>("outputVolume", 100) / 100;
  }

  setRoom(room: Room | null): void {
    this.room = room;
  }

  /** Get the current output volume multiplier. */
  getOutputVolumeMultiplier(): number {
    return this.outputVolumeMultiplier;
  }

  /** Compute the effective volume for a participant: per-user volume * master output. */
  getEffectiveVolume(userId: number): number {
    const userVol = userId > 0 ? getSavedUserVolume(userId) : 100;
    return (userVol / 100) * this.outputVolumeMultiplier;
  }

  /** Effective element volume for a user's screenshare audio: per-user volume
   *  scaled by the master output multiplier, clamped to the 0-1 range that
   *  HTMLAudioElement.volume supports. */
  private getEffectiveScreenshareVolume(userId: number): number {
    const userVol = this.screenshareVolumeByUser.get(userId) ?? 1;
    return Math.max(0, Math.min(1, userVol * this.outputVolumeMultiplier));
  }

  // --- Track subscription handlers ---

  handleTrackSubscribedAudio(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    // Guard: do not attach remote voice audio while locally deafened.
    // applyRemoteAudioSubscriptionState() only covers participants present at
    // the time of deafen — this guard catches participants who join afterward.
    // Screen-share/stream audio is exempt: muting or deafening yourself gates
    // voices, not the content someone is streaming — that stays under its own
    // per-tile mute/volume controls.
    if (
      voiceStore.getState().localDeafened &&
      publication.source !== Track.Source.ScreenShareAudio
    ) {
      publication.setSubscribed(false);
      return;
    }

    const userId = parseUserId(participant.identity);
    if (publication.source === Track.Source.ScreenShareAudio) {
      // Screenshare audio: manage via HTMLAudioElement volume (not participant.setVolume)
      // Look up the tracking set before detaching so a fast re-subscribe
      // (new TrackSubscribed before the old TrackUnsubscribed lands) drops
      // the stale element from the set instead of leaking it forever — same
      // hygiene as handleTrackUnsubscribedAudio below.
      let audioEls = this.screenshareAudioElements.get(userId);
      for (const el of track.detach()) {
        el.remove();
        audioEls?.delete(el);
      }
      const audioEl = track.attach();
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      audioEl.volume = this.getEffectiveScreenshareVolume(userId);
      audioEl.muted = this.screenshareAudioMutedByUser.get(userId) ?? false;
      if (audioEls === undefined) {
        audioEls = new Set();
        this.screenshareAudioElements.set(userId, audioEls);
      }
      audioEls.add(audioEl);
      const savedOutput = loadPref<string>("audioOutputDevice", "");
      if (savedOutput !== "" && typeof audioEl.setSinkId === "function") {
        audioEl.setSinkId(savedOutput).catch((err) => {
          log.warn("Failed to set output device on screenshare audio", err);
        });
      }
      log.debug("Screenshare audio track subscribed and attached", { userId, trackSid: track.sid });
    } else {
      // Microphone audio: use LiveKit's GainNode-backed setVolume
      // Detach any previous <audio> elements to prevent duplicate playback
      // on fast reconnects (new subscription fires before old unsubscription)
      for (const el of track.detach()) el.remove();
      const audioEl = track.attach();
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      // Track mic audio elements for cleanup on abnormal disconnect
      if (track.sid !== undefined) {
        this.remoteMicAudioElements.set(track.sid, audioEl);
      }
      // Apply saved per-user volume via LiveKit's setVolume (supports 0-2.0 range)
      participant.setVolume(this.getEffectiveVolume(userId));
      const savedOutput = loadPref<string>("audioOutputDevice", "");
      if (savedOutput !== "" && typeof audioEl.setSinkId === "function") {
        audioEl.setSinkId(savedOutput).catch((err) => {
          log.warn("Failed to set output device on remote audio", err);
        });
      }
      log.debug("Remote audio track subscribed and attached", { userId, trackSid: track.sid });
    }
  }

  handleTrackUnsubscribedAudio(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    const userId = parseUserId(participant.identity);
    if (publication.source === Track.Source.ScreenShareAudio) {
      const detachedEls = track.detach() as HTMLAudioElement[];
      for (const el of detachedEls) el.remove();
      const audioEls = this.screenshareAudioElements.get(userId);
      if (audioEls !== undefined) {
        for (const el of detachedEls) audioEls.delete(el);
        if (audioEls.size === 0) this.screenshareAudioElements.delete(userId);
      }
      log.debug("Screenshare audio track unsubscribed and detached", {
        userId,
        trackSid: track.sid,
      });
    } else {
      for (const el of track.detach()) el.remove();
      if (track.sid !== undefined) this.remoteMicAudioElements.delete(track.sid);
      log.debug("Remote audio track unsubscribed and detached", { userId, trackSid: track.sid });
    }
  }

  // --- Remote audio subscription state (deafen) ---

  applyRemoteAudioSubscriptionState(deafened: boolean): void {
    if (this.room === null) return;
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        // Deafen gates voices only. Screen-share/stream audio keeps playing
        // when the user mutes/deafens themselves — it has its own per-tile
        // mute and volume controls.
        if (publication.source === Track.Source.ScreenShareAudio) continue;
        publication.setSubscribed(!deafened);
      }
    }
  }

  // --- Volume control ---

  /** Apply effective volume to all remote participants. */
  applyAllVolumes(): void {
    if (this.room === null) return;
    for (const participant of this.room.remoteParticipants.values()) {
      const userId = parseUserId(participant.identity);
      participant.setVolume(this.getEffectiveVolume(userId));
    }
  }

  setUserVolume(userId: number, volume: number): void {
    const clamped = Math.max(0, Math.min(200, volume));
    savePref(userVolumeKey(userId), clamped);
    if (this.room !== null) {
      for (const participant of this.room.remoteParticipants.values()) {
        if (parseUserId(participant.identity) === userId) {
          participant.setVolume((clamped / 100) * this.outputVolumeMultiplier);
        }
      }
    }
  }

  getUserVolume(userId: number): number {
    return getSavedUserVolume(userId);
  }

  setOutputVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(200, volume));
    savePref("outputVolume", clamped);
    this.outputVolumeMultiplier = clamped / 100;
    this.applyAllVolumes();
    // Re-apply per-user screenshare volumes scaled by the new master value
    // (BUG: previously overwrote them with just the master multiplier).
    for (const [userId, audioEls] of this.screenshareAudioElements) {
      const effective = this.getEffectiveScreenshareVolume(userId);
      for (const audioEl of audioEls) {
        audioEl.volume = effective;
      }
    }
  }

  // --- Screenshare audio ---

  setScreenshareAudioVolume(userId: number, volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    // Always store, even before the audio track attaches — the stored value
    // is applied in handleTrackSubscribedAudio when the element appears.
    this.screenshareVolumeByUser.set(userId, clamped);
    const audioEls = this.screenshareAudioElements.get(userId);
    if (audioEls === undefined) return;
    const effective = this.getEffectiveScreenshareVolume(userId);
    for (const el of audioEls) el.volume = effective;
  }

  /** Stored per-user screenshare volume (0-1, default 1) for slider init. */
  getScreenshareAudioVolume(userId: number): number {
    return this.screenshareVolumeByUser.get(userId) ?? 1;
  }

  muteScreenshareAudio(userId: number, muted: boolean): void {
    this.screenshareAudioMutedByUser.set(userId, muted);
    const audioEls = this.screenshareAudioElements.get(userId);
    if (audioEls === undefined) return;
    for (const el of audioEls) el.muted = muted;
  }

  getScreenshareAudioMuted(userId: number): boolean {
    const storedMuted = this.screenshareAudioMutedByUser.get(userId);
    if (storedMuted !== undefined) return storedMuted;
    const audioEls = this.screenshareAudioElements.get(userId);
    if (audioEls === undefined) return false;
    for (const el of audioEls) return el.muted;
    return false;
  }

  // --- Cleanup ---

  /** Remove all remote audio elements from the DOM and clear tracking maps.
   *  Preserves screenshare mute state so reconnecting tracks inherit user intent. */
  cleanupAllAudioElements(): void {
    // BUG-107: Fully release audio elements — pause, clear srcObject, then remove.
    for (const el of this.remoteMicAudioElements.values()) {
      el.pause();
      el.srcObject = null;
      el.remove();
    }
    this.remoteMicAudioElements.clear();
    for (const audioEls of this.screenshareAudioElements.values()) {
      for (const el of audioEls) {
        el.pause();
        el.srcObject = null;
        el.remove();
      }
    }
    this.screenshareAudioElements.clear();
  }

  /** Full cleanup including screenshare mute/volume state — used on intentional leave. */
  cleanupAllAudioElementsFull(): void {
    this.cleanupAllAudioElements();
    this.screenshareAudioMutedByUser.clear();
    this.screenshareVolumeByUser.clear();
  }
}

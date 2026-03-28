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
import { loadPref, savePref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import { parseUserId } from "@lib/livekitSession";

const log = createLogger("audioElements");

/** Get saved per-user volume (0-200 range, default 100). Applied via LiveKit's GainNode-backed setVolume(). */
function getSavedUserVolume(userId: number): number {
  return loadPref<number>(`userVolume_${userId}`, 100);
}

export class AudioElements {
  private room: Room | null = null;

  /** Remote microphone audio elements keyed by track SID for cleanup on disconnect. */
  private remoteMicAudioElements = new Map<string, HTMLAudioElement>();
  /** Screenshare audio elements keyed by userId — separate from mic audio pipeline. */
  private screenshareAudioElements = new Map<number, Set<HTMLAudioElement>>();
  /** Persisted mute state for screenshare audio so replacement tracks inherit UI state. */
  private screenshareAudioMutedByUser = new Map<number, boolean>();

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

  private getScreenshareOutputVolume(): number {
    return Math.max(0, Math.min(1, this.outputVolumeMultiplier));
  }

  // --- Track subscription handlers ---

  handleTrackSubscribedAudio(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    const userId = parseUserId(participant.identity);
    if (publication.source === Track.Source.ScreenShareAudio) {
      // Screenshare audio: manage via HTMLAudioElement volume (not participant.setVolume)
      for (const el of track.detach()) el.remove();
      const audioEl = track.attach();
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      audioEl.volume = this.getScreenshareOutputVolume();
      audioEl.muted = this.screenshareAudioMutedByUser.get(userId) ?? false;
      let audioEls = this.screenshareAudioElements.get(userId);
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
      log.debug("Screenshare audio track unsubscribed and detached", { userId, trackSid: track.sid });
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
    savePref(`userVolume_${userId}`, clamped);
    if (this.room !== null) {
      for (const participant of this.room.remoteParticipants.values()) {
        if (parseUserId(participant.identity) === userId) {
          participant.setVolume((clamped / 100) * this.outputVolumeMultiplier);
        }
      }
    }
  }

  getUserVolume(userId: number): number { return getSavedUserVolume(userId); }

  setOutputVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(200, volume));
    savePref("outputVolume", clamped);
    this.outputVolumeMultiplier = clamped / 100;
    this.applyAllVolumes();
    const screenshareVolume = this.getScreenshareOutputVolume();
    for (const audioEls of this.screenshareAudioElements.values()) {
      for (const audioEl of audioEls) {
        audioEl.volume = screenshareVolume;
      }
    }
  }

  // --- Screenshare audio ---

  setScreenshareAudioVolume(userId: number, volume: number): void {
    const audioEls = this.screenshareAudioElements.get(userId);
    if (audioEls === undefined) return;
    const clamped = Math.max(0, Math.min(1, volume));
    for (const el of audioEls) el.volume = clamped;
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

  /** Remove all remote audio elements from the DOM and clear tracking maps. */
  cleanupAllAudioElements(): void {
    for (const el of this.remoteMicAudioElements.values()) el.remove();
    this.remoteMicAudioElements.clear();
    for (const audioEls of this.screenshareAudioElements.values()) {
      for (const el of audioEls) el.remove();
    }
    this.screenshareAudioElements.clear();
    this.screenshareAudioMutedByUser.clear();
  }
}

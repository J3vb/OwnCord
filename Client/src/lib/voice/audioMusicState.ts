// Music share audio state and volume/mute rules of AudioElements: the
// per-user elements, the remembered Music volume and Mute music, and the gain
// a user's music plays at once deafen is folded in. Split from
// audioElements.ts, which extends this class.

import type { RemoteTrack } from "livekit-client";
import { loadPref, savePref } from "@lib/prefs/preferences";
import { createLogger } from "@lib/logger";
import { clampPercent, userMusicMuteKey, userMusicVolumeKey } from "./audioVolumePrefs";
import { ScreenshareAudioState } from "./audioScreenshareState";
import {
  applySavedOutput,
  attachScreenshareAudio,
  detachScreenshareAudio,
} from "./audioTrackElements";
import { isMusicPublication, type NamedPublication } from "./musicTrack";

const log = createLogger("audioElements");

/** Music volume runs 0-100 % like stream volume: a track element cannot play
 *  louder than unity. */
function clampMusicPercent(percent: number): number {
  return Math.min(100, clampPercent(percent));
}

export abstract class MusicAudioState extends ScreenshareAudioState {
  /** Music audio elements keyed by userId, apart from voice and stream audio. */
  protected musicAudioElements = new Map<number, Set<HTMLAudioElement>>();

  /** Told after a music volume, mute, deafen or the output volume changes, for
   *  a room that plays music itself (the Linux native room). */
  protected musicGainListener: (() => void) | null = null;

  /** Whether a stream or music publication is silent for `userId`. */
  protected isStreamSilenced(publication: NamedPublication, userId: number): boolean {
    return isMusicPublication(publication)
      ? this.isMusicSilenced(userId)
      : this.isScreenshareSilenced(userId);
  }

  protected attachMusic(track: RemoteTrack, userId: number): void {
    const audioEl = attachScreenshareAudio(
      track,
      this.musicAudioElements,
      userId,
      this.getEffectiveMusicVolume(userId),
      this.isMusicSilenced(userId),
    );
    applySavedOutput(audioEl, "screenshare");
    log.debug("Music audio track subscribed and attached", { userId, trackSid: track.sid });
  }

  protected detachMusic(track: RemoteTrack, userId: number): void {
    detachScreenshareAudio(track, this.musicAudioElements, userId);
    log.debug("Music audio track unsubscribed and detached", { userId, trackSid: track.sid });
  }

  /** Remove every music element, on a leave or a replaced room. */
  protected releaseMusicElements(): void {
    for (const audioEls of this.musicAudioElements.values()) {
      for (const el of audioEls) {
        el.pause();
        el.srcObject = null;
        el.remove();
      }
    }
    this.musicAudioElements.clear();
  }

  setMusicGainListener(listener: (() => void) | null): void {
    this.musicGainListener = listener;
  }

  /** Remembered Music volume for a user, 0-100 (default 100). */
  getMusicVolume(userId: number): number {
    return clampMusicPercent(loadPref<number>(userMusicVolumeKey(userId), 100));
  }

  /** Remembered Mute music for a user. Deafen is not part of it. */
  getMusicMuted(userId: number): boolean {
    return loadPref<boolean>(userMusicMuteKey(userId), false) === true;
  }

  /** Music is silent while Mute music is on or while deafened. */
  protected isMusicSilenced(userId: number): boolean {
    return this.isLocalDeafened() || this.getMusicMuted(userId);
  }

  /** The element volume for a user's music: their level scaled by the master
   *  output volume, 0-1. */
  protected getEffectiveMusicVolume(userId: number): number {
    const level = this.getMusicVolume(userId) / 100;
    return Math.max(0, Math.min(1, level * this.outputVolumeMultiplier));
  }

  /** The gain a user's music plays at: 0 while Mute music is on or deafened,
   *  so a native mixer needs no other state. */
  getMusicGain(userId: number): number {
    return this.isMusicSilenced(userId) ? 0 : this.getEffectiveMusicVolume(userId);
  }

  setMusicVolume(userId: number, percent: number): void {
    savePref(userMusicVolumeKey(userId), clampMusicPercent(percent));
    this.applyMusicElements(userId);
    this.musicGainListener?.();
  }

  setMusicMuted(userId: number, muted: boolean): void {
    savePref(userMusicMuteKey(userId), muted);
    this.applyMusicElements(userId);
    this.musicGainListener?.();
    this.syncScreenshareDelivery(userId);
  }

  /** Deafen silences music by muting its elements, so undeafen restores each
   *  user's own Mute music. */
  protected applyMusicDeafen(): void {
    for (const userId of this.musicAudioElements.keys()) this.applyMusicElements(userId);
    this.musicGainListener?.();
  }

  /** Re-apply every user's music volume after the master output volume moved. */
  protected applyMusicVolumes(): void {
    for (const userId of this.musicAudioElements.keys()) this.applyMusicElements(userId);
    this.musicGainListener?.();
  }

  private applyMusicElements(userId: number): void {
    const elements = this.musicAudioElements.get(userId);
    if (elements === undefined) return;
    const volume = this.getEffectiveMusicVolume(userId);
    const muted = this.isMusicSilenced(userId);
    for (const el of elements) {
      el.volume = volume;
      el.muted = muted;
    }
  }
}

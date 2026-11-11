// Screenshare audio state and volume/mute rules of AudioElements: the
// per-user maps, the master output multiplier and the methods that only read
// or write them. Split from audioElements.ts, which extends this class.

export abstract class ScreenshareAudioState {
  /** Whether the user is deafened (read from the voice store by the subclass,
   *  which keeps this module off the store graph). */
  protected abstract isLocalDeafened(): boolean;

  /** Screenshare audio elements keyed by userId — separate from mic audio pipeline. */
  protected screenshareAudioElements = new Map<number, Set<HTMLAudioElement>>();
  /** Persisted mute state for screenshare audio so replacement tracks inherit UI state. */
  protected screenshareAudioMutedByUser = new Map<number, boolean>();
  /** Per-user screenshare volume (0-1, default 1) — kept independent of the
   *  element map so a volume chosen before the track attaches still applies. */
  protected screenshareVolumeByUser = new Map<number, number>();

  /** Told after a screen-share volume, mute or the output volume changes, for
   *  a room that plays screen-share audio itself rather than through the
   *  elements here (the Linux native room). */
  protected screenshareGainListener: (() => void) | null = null;

  /** Master output volume multiplier (0-1.0). Per-user volumes are scaled by this. */
  protected outputVolumeMultiplier = 1;

  /** Effective element volume for a user's screenshare audio: per-user volume
   *  scaled by the master output multiplier, clamped to the 0-1 range that
   *  HTMLAudioElement.volume supports. */
  protected getEffectiveScreenshareVolume(userId: number): number {
    const userVol = this.screenshareVolumeByUser.get(userId) ?? 1;
    return Math.max(0, Math.min(1, userVol * this.outputVolumeMultiplier));
  }

  /** The gain a user's screen-share audio plays at: its effective volume, or
   *  0 while muted. */
  getScreenshareGain(userId: number): number {
    return this.isScreenshareSilenced(userId) ? 0 : this.getEffectiveScreenshareVolume(userId);
  }

  /** Stream audio is silent while its own tile mute is on or while deafened.
   *  Deafen leaves the tile mute untouched, so undeafen restores it as it was. */
  protected isScreenshareSilenced(userId: number): boolean {
    return this.isLocalDeafened() || this.getScreenshareAudioMuted(userId);
  }

  setScreenshareGainListener(listener: (() => void) | null): void {
    this.screenshareGainListener = listener;
  }

  setScreenshareAudioVolume(userId: number, volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    // Always store, even before the audio track attaches — the stored value
    // is applied in handleTrackSubscribedAudio when the element appears.
    this.screenshareVolumeByUser.set(userId, clamped);
    this.screenshareGainListener?.();
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
    this.screenshareGainListener?.();
    const audioEls = this.screenshareAudioElements.get(userId);
    if (audioEls === undefined) return;
    for (const el of audioEls) el.muted = muted || this.isLocalDeafened();
  }

  /** The tile's own stream mute. Not the element's muted flag: deafen mutes
   *  the element too, and must not read back as the user's choice. */
  getScreenshareAudioMuted(userId: number): boolean {
    return this.screenshareAudioMutedByUser.get(userId) ?? false;
  }
}

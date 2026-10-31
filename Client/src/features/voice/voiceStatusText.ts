/**
 * Pure voice-status helpers shared by always-loaded code (MainPage,
 * DmCallPanel) and the lazily loaded VoiceWidget. Kept apart so a
 * caller does not pull the widget into the main-page chunk.
 */

import { isSelfMuted, type VoiceState, type VoiceStatus } from "@stores/voice.store";
import { voiceText as t } from "../../i18n/voice";
import { isAndroidApp } from "./native/platform";

/** Header status text per voice-session lifecycle state
 *  (docs/architecture/ux/voice-and-e2ee.md §2). */
export function headerStatusText(status: VoiceStatus): string {
  // i18n-exempt: catalog key assembled from the VoiceStatus wire value
  return t(`status.${status}`);
}

/** The join has not reached the room yet: camera and share have nothing to attach to. */
export function isConnecting(status: VoiceStatus): boolean {
  return status === "joining" || status === "securing";
}

/** Format milliseconds elapsed into HH:MM:SS or MM:SS. */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${String(h).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** What a mic button shows for the voice state, shared by every one of them. */
export interface MicControlState {
  readonly userMuted: boolean;
  readonly listenOnly: boolean;
  readonly pttGated: boolean;
  /** The mic reads as off: muted, listen-only or locked in the AFK channel. */
  readonly micOff: boolean;
  /** aria-pressed: the mute the user asked for, or the AFK lock. */
  readonly pressed: boolean;
  /** A moderator's mute, listen-only and the AFK lock are not ours to lift. */
  readonly disabled: boolean;
  readonly title: string;
}

/** A moderator's mute is not ours to lift (the server refuses it), so the
 *  button is disabled and says why. In a call joined listen-only there is no
 *  mic to mute, and an idle push-to-talk key reads as its own state, not a mute. */
export function micControlState(voice: VoiceState): MicControlState {
  const inCall = voice.currentChannelId !== null;
  const userMuted = isSelfMuted(voice);
  const serverMuted = voice.localServerMuted === true;
  // The AFK channel is listen-only for everyone: the mic reads muted and is locked.
  const afkLocked = inCall && voice.inAfkChannel === true;
  const listenOnly = inCall && voice.listenOnly && !serverMuted && !afkLocked;
  const pttGated = inCall && voice.pttGated === true && !userMuted && !listenOnly && !afkLocked;
  const title = serverMuted
    ? t("widget.mutedByModerator")
    : afkLocked
      ? t("widget.control.afkLocked")
      : listenOnly
        ? t("widget.control.listenOnly")
        : pttGated
          ? t(isAndroidApp() ? "widget.control.pttGated.android" : "widget.control.pttGated")
          : t(userMuted ? "widget.control.unmute" : "widget.control.mute");
  return {
    userMuted,
    listenOnly,
    pttGated,
    micOff: userMuted || listenOnly || afkLocked,
    pressed: userMuted || afkLocked,
    disabled: serverMuted || listenOnly || afkLocked,
    title,
  };
}

/** Everything `micControlState` reads, as one comparable key. */
export function micControlKey(s: VoiceState): string {
  return [
    s.currentChannelId !== null,
    s.localMuted,
    s.localServerMuted === true,
    s.listenOnly,
    s.pttGated === true,
    s.inAfkChannel === true,
  ].join("|");
}

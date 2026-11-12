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

/** A phone call holds the call you are in (the Android app): the mic is closed
 *  and the sound silenced until the phone call ends. */
export function isPhoneCallHold(voice: VoiceState): boolean {
  return voice.currentChannelId !== null && voice.phoneCallHold === true;
}

/** A call's status line, which is short: paused while a phone call holds it,
 *  else the state of its session. */
export function callStatusText(voice: VoiceState): string {
  return isPhoneCallHold(voice) ? t("call.paused") : headerStatusText(voice.voiceStatus);
}

/** What a mic button shows for the voice state, shared by every one of them. */
export interface MicControlState {
  readonly userMuted: boolean;
  readonly listenOnly: boolean;
  readonly pttGated: boolean;
  /** A phone call holds the call: the mic is closed until it ends. */
  readonly phoneHold: boolean;
  /** The mic reads as off: muted, listen-only, locked in the AFK channel or
   *  held by a phone call. */
  readonly micOff: boolean;
  /** aria-pressed: the mute the user asked for, the AFK lock or the hold. */
  readonly pressed: boolean;
  /** A moderator's mute, listen-only, the AFK lock and a phone call's hold
   *  are not ours to lift. */
  readonly disabled: boolean;
  readonly title: string;
}

/** The mic button's label: the first state that applies, a phone call's hold
 *  before a moderator's mute before the AFK lock before listen-only before an
 *  idle push-to-talk key. */
function micTitle(
  phoneHold: boolean,
  serverMuted: boolean,
  afkLocked: boolean,
  listenOnly: boolean,
  pttGated: boolean,
  userMuted: boolean,
): string {
  if (phoneHold) return t("widget.control.phoneCallHold");
  if (serverMuted) return t("widget.mutedByModerator");
  if (afkLocked) return t("widget.control.afkLocked");
  if (listenOnly) return t("widget.control.listenOnly");
  if (pttGated) {
    return t(isAndroidApp() ? "widget.control.pttGated.android" : "widget.control.pttGated");
  }
  return t(userMuted ? "widget.control.unmute" : "widget.control.mute");
}

/** A moderator's mute is not ours to lift (the server refuses it), so the
 *  button is disabled and says why. In a call joined listen-only there is no
 *  mic to mute, and an idle push-to-talk key reads as its own state, not a mute. */
export function micControlState(voice: VoiceState): MicControlState {
  const inCall = voice.currentChannelId !== null;
  const userMuted = isSelfMuted(voice);
  const serverMuted = voice.localServerMuted === true;
  const phoneHold = isPhoneCallHold(voice);
  // The AFK channel is listen-only for everyone: the mic reads muted and is locked.
  const afkLocked = inCall && voice.inAfkChannel === true;
  const listenOnly = inCall && voice.listenOnly && !serverMuted && !afkLocked;
  // Closed whatever the user's own mute says, and not theirs to open.
  const locked = listenOnly || afkLocked || phoneHold;
  const pttGated = inCall && voice.pttGated === true && !userMuted && !locked;
  return {
    userMuted,
    listenOnly,
    pttGated,
    phoneHold,
    micOff: userMuted || locked,
    pressed: userMuted || afkLocked || phoneHold,
    disabled: serverMuted || locked,
    title: micTitle(phoneHold, serverMuted, afkLocked, listenOnly, pttGated, userMuted),
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
    s.phoneCallHold === true,
  ].join("|");
}

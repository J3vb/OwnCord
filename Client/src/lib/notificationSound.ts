/**
 * Notification and ring chimes (Web Audio, no assets). Split out of
 * `notifications.ts` so `pages/MainPage.ts` can ring an incoming call without
 * pulling the whole message-notification pipeline (the level gate, the
 * markdown body, the dispatcher) into its chunk.
 */

import { loadPref } from "./preferences";
import { loadUserStatus } from "./userStatus";
import { createLogger } from "./logger";

const log = createLogger("notifications");

let notifAudioCtx: AudioContext | null = null;

/** Close and release the notification AudioContext. Call on logout/cleanup. */
export function cleanupNotificationAudio(): void {
  stopRingChime();
  if (notifAudioCtx !== null) {
    notifAudioCtx.close().catch((err) => {
      log.warn("Failed to close notification AudioContext", err);
    });
    notifAudioCtx = null;
  }
}

// The ring chime repeats until the call is answered, declined or times out —
// unlike a message chime, which fires once. It is its own rising pattern, not
// the message blip, so a call is told apart from a message by ear (DP-24).
let ringInterval: ReturnType<typeof setInterval> | null = null;

/** Start the repeating incoming-call chime. Idempotent. */
export function startRingChime(): void {
  if (ringInterval !== null) return;
  // DND silences a call chime for the same reason it silences a message one:
  // the settings panel promises no notification sounds, and a ringing phone is
  // the loudest possible violation of that. The banner still appears.
  if (loadUserStatus() === "dnd") return;
  // D2(b): the call sound has its own toggle, so muting message sounds does
  // not silence a ringing phone.
  if (!loadPref<boolean>("callSounds", true)) return;
  playRingtone();
  ringInterval = setInterval(() => playRingtone(), 2000);
}

/** Stop the repeating incoming-call chime. Idempotent. */
export function stopRingChime(): void {
  if (ringInterval === null) return;
  clearInterval(ringInterval);
  ringInterval = null;
}

/** The shared notification AudioContext, created on first use. */
function audioContext(): AudioContext {
  notifAudioCtx ??= new AudioContext();
  return notifAudioCtx;
}

/** One burst of the ringtone: two rising notes, where a message falls. */
function playRingtone(): void {
  try {
    const ctx = audioContext();
    for (const [hz, at] of [
      [660, 0],
      [880, 0.18],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      const start = ctx.currentTime + at;
      osc.frequency.setValueAtTime(hz, start);
      gain.gain.setValueAtTime(0.25, start);
      gain.gain.exponentialRampToValueAtTime(0.01, start + 0.16);
      osc.start(start);
      osc.stop(start + 0.16);
    }
  } catch (err) {
    log.debug("Ringtone not available", err);
  }
}

/** Play a brief notification chime. */
export function playNotificationSound(): void {
  try {
    const ctx = audioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.setValueAtTime(600, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
  } catch (err) {
    log.debug("Notification sound not available", err);
  }
}

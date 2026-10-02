/**
 * Notification and ring chimes (Web Audio, no assets). Split out of
 * `notifications.ts` so `pages/MainPage.ts` can ring an incoming call without
 * pulling the whole message-notification pipeline (the level gate, the
 * markdown body, the dispatcher) into its chunk.
 */

import { loadPref } from "./preferences";
import { USER_STATUS_PREF_KEY, loadUserStatus } from "./userStatus";
import { createLogger } from "./logger";
import { Disposable } from "./disposable";

const log = createLogger("notifications");

let notifAudioCtx: AudioContext | null = null;

/** Close and release the notification AudioContext. Call on logout/cleanup. */
export function cleanupNotificationAudio(): void {
  stopRingback();
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
/** The oscillators of the chime burst currently sounding, so stopping the
 *  chime cuts the in-flight notes instead of leaving them under the ringback. */
let ringtoneOscs: OscillatorNode[] = [];

/** Start the repeating incoming-call chime. Idempotent. */
export function startRingChime(): void {
  if (ringInterval !== null) return;
  // A client is either calling or being called; an incoming ring pre-empts the
  // outgoing ringback (DP-25 acceptance). The outgoing call keeps wanting its
  // ringback, so it resumes when this chime ends.
  silenceRingback();
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
  stopRingtoneBurst();
  if (ringInterval === null) return;
  clearInterval(ringInterval);
  ringInterval = null;
  // The incoming ring ended: an outgoing ring that was pre-empted resumes.
  syncRingback();
}

/** Cut the chime burst that is sounding right now, if any. */
function stopRingtoneBurst(): void {
  for (const osc of ringtoneOscs) osc.stop();
  ringtoneOscs = [];
}

// The outgoing call's ringback: a soft low tone the caller hears while the
// callees ring, its own pattern so it is told apart from the callee's incoming
// chime by ear (DP-25). The two never run at once on one client: you are
// either answering a call or placing one. An incoming ring pre-empts the
// ringback, but the outgoing call is still ringing, so the ringback resumes
// when that chime ends (unless the outgoing ring ended meanwhile).
let ringbackInterval: ReturnType<typeof setInterval> | null = null;
/** The oscillator of the ringback burst currently sounding, so silencing the
 *  ringback cuts the in-flight tone instead of leaving it under the chime. */
let ringbackOsc: OscillatorNode | null = null;
/** The outgoing call still wants a ringback. Kept across a pre-emption so the
 *  sound can resume when the incoming chime ends. */
let ringbackWanted = false;
/** Owns the DND / call-sound listeners that re-evaluate the ringback while the
 *  outgoing call wants it. Null while nothing is ringing. */
let ringbackWatch: Disposable | null = null;

/** Stop the ringback sound without forgetting that the outgoing call still
 *  wants it (used while an incoming ring pre-empts it). */
function silenceRingback(): void {
  if (ringbackOsc !== null) {
    ringbackOsc.stop();
    ringbackOsc = null;
  }
  if (ringbackInterval === null) return;
  clearInterval(ringbackInterval);
  ringbackInterval = null;
}

/** Watch the live inputs to the ringback gate (DND and the call-sound toggle)
 *  so a mid-ring change takes effect instead of leaving the ring silent. */
function watchRingbackInputs(): void {
  if (ringbackWatch !== null) return;
  const owner = new Disposable();
  ringbackWatch = owner;
  window.addEventListener(
    "owncord:pref-change",
    (e: Event) => {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key;
      if (key === USER_STATUS_PREF_KEY || key === "callSounds") syncRingback();
    },
    { signal: owner.signal },
  );
}

function unwatchRingbackInputs(): void {
  ringbackWatch?.destroy();
  ringbackWatch = null;
}

/** (Re)evaluate whether the ringback should be sounding right now. */
function syncRingback(): void {
  const shouldPlay =
    ringbackWanted &&
    ringInterval === null &&
    loadUserStatus() !== "dnd" &&
    loadPref<boolean>("callSounds", true);
  if (!shouldPlay) {
    silenceRingback();
    return;
  }
  if (ringbackInterval !== null) return;
  playRingback();
  ringbackInterval = setInterval(() => playRingback(), 3000);
}

/** Start the repeating outgoing-call ringback. Idempotent. */
export function startRingback(): void {
  ringbackWanted = true;
  watchRingbackInputs();
  syncRingback();
}

/** Stop the repeating outgoing-call ringback and forget that it wanted to
 *  play, so an incoming ring that ends later does not bring it back.
 *  Idempotent. */
export function stopRingback(): void {
  ringbackWanted = false;
  unwatchRingbackInputs();
  silenceRingback();
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
    const oscs: OscillatorNode[] = [];
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
      oscs.push(osc);
    }
    ringtoneOscs = oscs;
  } catch (err) {
    log.debug("Ringtone not available", err);
  }
}

/** One burst of the ringback: a single soft, low tone, slower than the
 *  incoming ringtone and quieter, so the caller and the callee hear different
 *  things (DP-25). */
function playRingback(): void {
  try {
    const ctx = audioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const start = ctx.currentTime;
    osc.frequency.setValueAtTime(440, start);
    gain.gain.setValueAtTime(0.12, start);
    gain.gain.exponentialRampToValueAtTime(0.01, start + 0.5);
    osc.start(start);
    osc.stop(start + 0.5);
    ringbackOsc = osc;
  } catch (err) {
    log.debug("Ringback not available", err);
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

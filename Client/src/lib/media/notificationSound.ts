/**
 * Notification, call and voice UI chimes (Web Audio, no assets). Split out of
 * `notifications.ts` so `pages/MainPage.ts` can ring an incoming call without
 * pulling the whole message-notification pipeline (the level gate, the
 * markdown body, the dispatcher) into its chunk.
 *
 * Every sound is a tone spec from `soundTables.ts`, in the style the user
 * picked, drawn by one of two renderers. `playWeb` is the Web Audio one: all
 * sounds share one `AudioContext`, whose output follows the saved
 * `audioOutputDevice` through `setSinkId` where the host supports it (Chromium
 * and WebView2 do). WebKitGTK, the Linux webview, lacks `setSinkId`, so on the
 * Linux desktop `playSpec`
 * sends the spec to the native host instead (`native_voice_play_sound`), which
 * synthesizes it and plays it on the saved output device, in or out of a call;
 * any host failure falls back to `playWeb`. Every gate (deafen,
 * DND, the switches) and the ring timers stay here, ahead of `playSpec`; the
 * Settings previews (`soundPreview.ts`) call `playSpec` directly, ungated.
 */

import { loadPref, onPrefChange } from "../prefs/preferences";
import { loadAppSoundsGain, loadSoundStyle, soundSwitchOn } from "../prefs/soundPrefs";
import { USER_STATUS_PREF_KEY, loadUserStatus } from "../presence/userStatus";
import { isVoiceDeafened } from "../voice/voiceDeafened";
import { createLogger } from "../logger";
import { Disposable } from "../disposable";
import { desktop } from "../../platform/desktop";
import type { NativeToneNote } from "../../platform/contracts/nativeVoice";
import { isLinuxDesktop } from "../../features/voice/native/platform";
import { REPEAT_MS, soundSpec, type ToneSpec, type VoiceSound } from "./soundTables";

export type { VoiceSound } from "./soundTables";

const log = createLogger("notifications");

let notifAudioCtx: AudioContext | null = null;
/** The master gain every sound routes through: the "App sounds
 *  volume" slider scales it, 100% being a gain of 1, i.e. the notes of
 *  `soundTables.ts` exactly as they are. Lives and dies with `notifAudioCtx`. */
let masterGain: GainNode | null = null;
/** The output id currently applied to `notifAudioCtx`, so a play does not
 *  re-issue `setSinkId` for an unchanged device. Empty string means the system
 *  default. Reset with the context, and cleared again if an apply fails so the
 *  next play retries rather than staying on the default for the session. */
let appliedSink = "";
/** The tone that says your outgoing call ended unanswered, if it is sounding. */
let callEndedBurst: Playing | null = null;

/** Cut the call-ended tone if it is still sounding. */
function stopCallEnded(): void {
  callEndedBurst?.stop();
  callEndedBurst = null;
}

/** Close and release the notification AudioContext. Call on logout/cleanup. */
export function cleanupNotificationAudio(): void {
  stopRingback();
  stopRingChime();
  stopCallEnded();
  appliedSink = "";
  masterGain = null;
  if (notifAudioCtx !== null) {
    notifAudioCtx.close().catch((err) => {
      log.warn("Failed to close notification AudioContext", err);
    });
    notifAudioCtx = null;
  }
}

// The ring chime repeats until the call is answered, declined or times out —
// unlike a message chime, which fires once. It is its own pattern, not the
// message sound, so a call is told apart from a message by ear.
let ringInterval: ReturnType<typeof setInterval> | null = null;
/** The chime burst currently sounding, so stopping the chime cuts the
 *  in-flight notes instead of leaving them under the ringback. */
let ringtoneBurst: Playing | null = null;
/** A ring is in flight and wants its sound. */
let chimeWanted = false;
/** On a host that rings for a call by itself (`Notifier.ringsCalls`: the
 *  Android app, with the phone's ringtone), whether it does for the ring in
 *  flight. Null until whoever asks the host has said (`setHostRinging`); the
 *  chime waits for that word, so the two never sound together and a ring the
 *  host did not take still rings here. */
let hostRings: boolean | null = null;

/** Whether a ringing call makes a sound right now. */
export function ringSoundOn(): boolean {
  // DND silences a call chime for the same reason it silences a message one:
  // the settings panel promises no notification sounds, and a ringing phone is
  // the loudest possible violation of that. The banner still appears.
  // D2(b): the call sound has its own toggle, so muting message sounds does
  // not silence a ringing phone; the ring has its own switch too.
  return (
    loadUserStatus() !== "dnd" && loadPref<boolean>("callSounds", true) && soundSwitchOn("ring")
  );
}

/** The ring in flight sounds here, not on the host. */
function chimeIsOurs(): boolean {
  return desktop.notifier.ringsCalls === true ? hostRings === false : true;
}

/** Start the repeating incoming-call chime. Idempotent. */
export function startRingChime(): void {
  chimeWanted = true;
  if (chimeIsOurs()) soundRingChime();
}

function soundRingChime(): void {
  if (ringInterval !== null) return;
  // A ring that will not sound pre-empts nothing: the outgoing ringback goes on.
  if (!ringSoundOn()) return;
  // A client is either calling or being called; an incoming ring pre-empts the
  // outgoing ringback. The outgoing call keeps wanting its
  // ringback, so it resumes when this chime ends.
  silenceRingback();
  stopCallEnded();
  playRingtone();
  // The ring switch is re-read before each burst, so turning it off while the
  // phone rings stops the chime (and lets a pre-empted ringback resume). The
  // period is the style's when the ring starts; each burst reads its notes.
  ringInterval = setInterval(() => {
    if (soundSwitchOn("ring")) playRingtone();
    else silenceRingChime();
  }, REPEAT_MS[loadSoundStyle()].ring);
}

/** Stop the repeating incoming-call chime. Idempotent. */
export function stopRingChime(): void {
  chimeWanted = false;
  hostRings = null;
  silenceRingChime();
}

/** Cut the chime's sound; the ring in flight, if any, keeps wanting one. */
function silenceRingChime(): void {
  stopRingtoneBurst();
  if (ringInterval !== null) {
    clearInterval(ringInterval);
    ringInterval = null;
  }
  // An outgoing ring this chime pre-empted resumes, unless the host now rings
  // in its place.
  syncRingback();
}

/**
 * The word of whoever asked the host about the ring in flight: the host rings
 * for it (true), it does not and the chime rings here after all (false), or
 * that ring is over (null).
 */
export function setHostRinging(rings: boolean | null): void {
  hostRings = rings;
  if (chimeWanted && chimeIsOurs()) soundRingChime();
  else silenceRingChime();
}

/** Cut the chime burst that is sounding right now, if any. */
function stopRingtoneBurst(): void {
  ringtoneBurst?.stop();
  ringtoneBurst = null;
}

// The outgoing call's ringback: a soft low tone the caller hears while the
// callees ring, its own pattern so it is told apart from the callee's incoming
// chime by ear. The two never run at once on one client: you are
// either answering a call or placing one. An incoming ring pre-empts the
// ringback, but the outgoing call is still ringing, so the ringback resumes
// when that chime ends (unless the outgoing ring ended meanwhile).
let ringbackInterval: ReturnType<typeof setInterval> | null = null;
/** The ringback burst currently sounding, so silencing the ringback cuts the
 *  in-flight tone instead of leaving it under the chime. */
let ringbackBurst: Playing | null = null;
/** The outgoing call still wants a ringback. Kept across a pre-emption so the
 *  sound can resume when the incoming chime ends. */
let ringbackWanted = false;
/** Owns the DND / call-sound listeners that re-evaluate the ringback while the
 *  outgoing call wants it. Null while nothing is ringing. */
let ringbackWatch: Disposable | null = null;

/** Stop the ringback sound without forgetting that the outgoing call still
 *  wants it (used while an incoming ring pre-empts it). */
function silenceRingback(): void {
  if (ringbackBurst !== null) {
    ringbackBurst.stop();
    ringbackBurst = null;
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
  onPrefChange([USER_STATUS_PREF_KEY, "callSounds", "soundRingback"], syncRingback, owner.signal);
}

function unwatchRingbackInputs(): void {
  ringbackWatch?.destroy();
  ringbackWatch = null;
}

/** An incoming ring is sounding, here or on the host. */
function incomingRingSounds(): boolean {
  return ringInterval !== null || (chimeWanted && hostRings === true && ringSoundOn());
}

/** The caller's tones may sound: no incoming ring over them, not Do Not
 *  Disturb, and both the call sound switch and the ringback's own on. */
function callerTonesOn(): boolean {
  return (
    !incomingRingSounds() &&
    loadUserStatus() !== "dnd" &&
    loadPref<boolean>("callSounds", true) &&
    soundSwitchOn("ringback")
  );
}

/** (Re)evaluate whether the ringback should be sounding right now. */
function syncRingback(): void {
  const shouldPlay = ringbackWanted && callerTonesOn();
  if (!shouldPlay) {
    silenceRingback();
    return;
  }
  if (ringbackInterval !== null) return;
  stopCallEnded();
  playRingback();
  ringbackInterval = setInterval(() => playRingback(), REPEAT_MS[loadSoundStyle()].ringback);
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

/** Your outgoing call was declined, went unanswered or could not ring: play
 *  the call-ended tone once, under the ringback's gates. Call it after the
 *  ringback stopped, so its last burst is already cut. */
export function playCallEnded(): void {
  if (!callerTonesOn() || deafened()) return;
  stopCallEnded();
  // i18n-exempt: log text, never displayed
  callEndedBurst = playSpec(soundSpec(loadSoundStyle(), "callEnded"), "Call ended sound");
}

/** Every sound this module makes is silenced while the local user is deafened
 *  inside a voice session — except the ringtone, which D2 keeps for calls.
 *  Leaving voice releases the gate even though the stored deafen persists.
 *  Reads the leaf the lazy voice store mirrors (see lib/voice/voiceDeafened.ts), so
 *  this stays out of the startup closure. */
function deafened(): boolean {
  return isVoiceDeafened();
}

/** The shared notification AudioContext, created on first use. */
function audioContext(): AudioContext {
  notifAudioCtx ??= new AudioContext();
  syncSink();
  return notifAudioCtx;
}

/** The node every sound connects to: the master gain, set to the saved volume.
 *  Re-read on each play (a cheap synchronous pref read, like the sink) so a
 *  slider move applies to the next sound without a window-lifetime listener. */
function output(ctx: AudioContext): AudioNode {
  if (masterGain === null) {
    masterGain = ctx.createGain();
    masterGain.connect(ctx.destination);
  }
  masterGain.gain.value = loadAppSoundsGain();
  return masterGain;
}

/** Point the context at the saved output device. Re-read each time rather
 *  than listening for `owncord:pref-change`: the pref is a cheap synchronous
 *  localStorage read, and this keeps the module free of a window-lifetime
 *  listener. `setSinkId` is only re-issued when the device actually changed
 *  (or the host lacks it: WebKitGTK keeps the default). */
function syncSink(): void {
  const ctx = notifAudioCtx as (AudioContext & { setSinkId(id: string): Promise<void> }) | null;
  if (ctx === null || typeof ctx.setSinkId !== "function") return;
  const deviceId = loadPref<string>("audioOutputDevice", "");
  if (deviceId === appliedSink) return;
  appliedSink = deviceId;
  ctx.setSinkId(deviceId).catch((err: unknown) => {
    // A rejected apply leaves the context on its previous output; drop the
    // cache entry so the next play re-issues it (transient OS/sink errors,
    // or the first chime racing login, otherwise stick on the default).
    if (appliedSink === deviceId) appliedSink = "";
    log.warn("Failed to set output device on notification audio", err);
  });
}

/** A sound being played: stopping it cuts the notes still sounding. */
export interface Playing {
  stop(): void;
}

/** Step (or, with `glide`, slide) the oscillator through the note's points. */
function scheduleFreqs(freq: AudioParam, n: NativeToneNote, start: number): void {
  n.freqs.forEach(([offset, hz], i) => {
    if (i > 0 && n.glide === true) freq.exponentialRampToValueAtTime(hz, start + offset);
    else freq.setValueAtTime(hz, start + offset);
  });
}

/** Shape the note's gain: the attack, the fade to `endGain`, the release.
 *  Returns when the note falls silent. */
function scheduleGain(gain: AudioParam, n: NativeToneNote, start: number): number {
  const attack = n.attack ?? 0;
  const release = n.release ?? 0;
  if (attack > 0) {
    gain.setValueAtTime(0, start);
    gain.linearRampToValueAtTime(n.gain, start + attack);
  } else {
    gain.setValueAtTime(n.gain, start);
  }
  gain.exponentialRampToValueAtTime(n.endGain, start + n.duration);
  if (release <= 0) return start + n.duration;
  gain.linearRampToValueAtTime(0, start + n.duration + release);
  return start + n.duration + release;
}

/** Render `spec` through Web Audio on the shared context: one oscillator and
 *  one gain node per note. A host without Web Audio logs `what` and plays nothing. */
function playWeb(spec: ToneSpec, what: string): Playing {
  const oscs: OscillatorNode[] = [];
  try {
    const ctx = audioContext();
    const out = output(ctx);
    for (const n of spec) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(out);
      const start = ctx.currentTime + n.at;
      scheduleFreqs(osc.frequency, n, start);
      const end = scheduleGain(gain.gain, n, start);
      osc.start(start);
      osc.stop(end);
      oscs.push(osc);
    }
  } catch (err) {
    log.debug(`${what} not available`, err);
  }
  return {
    stop() {
      for (const osc of oscs) osc.stop();
    },
  };
}

/** Render `spec` through the native host on the saved output device (Linux).
 *  The host answers within an IPC round trip, so the returned handle may be
 *  stopped before the id arrives: the sound is then cut the moment it lands,
 *  and a failure to start does not fall back to Web Audio for a sound nobody
 *  wants any more. Otherwise a host failure plays the spec through Web Audio
 *  on the default output. */
function playNative(spec: ToneSpec, what: string): Playing {
  let stopped = false;
  let id: number | null = null;
  let web: Playing | null = null;
  void desktop.nativeVoice
    .playSound(spec, loadPref<string>("audioOutputDevice", ""), loadAppSoundsGain())
    .catch((): null => null)
    .then((got) => {
      if (got === null) {
        if (stopped) return;
        log.debug(`${what} not available natively, using Web Audio`);
        web = playWeb(spec, what);
      } else if (stopped) {
        void desktop.nativeVoice.stopSound(got);
      } else {
        id = got;
      }
    });
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (id !== null) void desktop.nativeVoice.stopSound(id);
      web?.stop();
    },
  };
}

/** Play `spec` on the Linux desktop through the native host, anywhere else
 *  through Web Audio (whose `setSinkId` carries the saved output). Ungated:
 *  only this module's gated players and the Settings previews call it. */
export function playSpec(spec: ToneSpec, what: string): Playing {
  return isLinuxDesktop() ? playNative(spec, what) : playWeb(spec, what);
}

/** One burst of the ringtone, in the style saved now. */
function playRingtone(): void {
  // i18n-exempt: log text, never displayed
  ringtoneBurst = playSpec(soundSpec(loadSoundStyle(), "ring"), "Ringtone");
}

/** One burst of the ringback. Silent while deafened: the interval keeps
 *  polling, so undeafening mid-ring resumes the sound. */
function playRingback(): void {
  if (deafened()) return;
  // i18n-exempt: log text, never displayed
  ringbackBurst = playSpec(soundSpec(loadSoundStyle(), "ringback"), "Ringback");
}

/** Play a brief notification chime, a mention's or a plain message's.
 *  Silent while deafened. */
export function playNotificationSound(mentioned = false): void {
  if (deafened()) return;
  // i18n-exempt: log text, never displayed
  playSpec(soundSpec(loadSoundStyle(), mentioned ? "mention" : "message"), "Notification sound");
}

/** Play one voice UI sound. */
export function playVoiceSound(kind: VoiceSound): void {
  // i18n-exempt: log text, never displayed
  playSpec(soundSpec(loadSoundStyle(), kind), "Voice sound");
}

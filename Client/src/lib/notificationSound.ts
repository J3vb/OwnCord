/**
 * Notification, call and voice UI chimes (Web Audio, no assets). Split out of
 * `notifications.ts` so `pages/MainPage.ts` can ring an incoming call without
 * pulling the whole message-notification pipeline (the level gate, the
 * markdown body, the dispatcher) into its chunk.
 *
 * Every sound is a row of one tone-spec table (`TONES`), drawn by one of two
 * renderers. `playWeb` is the Web Audio one: all sounds share one
 * `AudioContext`, whose output follows the saved `audioOutputDevice` through
 * `setSinkId` where the host supports it (Chromium and WebView2 do). WebKitGTK,
 * the Linux webview, lacks `setSinkId`, so on the Linux desktop `playSpec`
 * sends the spec to the native host instead (`native_voice_play_sound`), which
 * synthesizes it and plays it on the saved output device, in or out of a call;
 * any host failure falls back to `playWeb`. Every gate (deafen,
 * DND, the switches) and the ring timers stay here, ahead of `playSpec`.
 */

import { loadPref, onPrefChange } from "./prefs/preferences";
import { loadAppSoundsGain, soundSwitchOn } from "./prefs/soundPrefs";
import { USER_STATUS_PREF_KEY, loadUserStatus } from "./userStatus";
import { isVoiceDeafened } from "./voiceDeafened";
import { createLogger } from "./logger";
import { Disposable } from "./disposable";
import { desktop } from "../platform/desktop";
import type { NativeToneNote } from "../platform/contracts/nativeVoice";
import { isLinuxDesktop } from "../features/voice/native/platform";

const log = createLogger("notifications");

let notifAudioCtx: AudioContext | null = null;
/** The master gain every sound routes through: the "App sounds
 *  volume" slider scales it, 100% being a gain of 1, i.e. the notes below
 *  exactly as they are. Lives and dies with `notifAudioCtx`. */
let masterGain: GainNode | null = null;
/** The output id currently applied to `notifAudioCtx`, so a play does not
 *  re-issue `setSinkId` for an unchanged device. Empty string means the system
 *  default. Reset with the context, and cleared again if an apply fails so the
 *  next play retries rather than staying on the default for the session. */
let appliedSink = "";

/** Close and release the notification AudioContext. Call on logout/cleanup. */
export function cleanupNotificationAudio(): void {
  stopRingback();
  stopRingChime();
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
// unlike a message chime, which fires once. It is its own rising pattern, not
// the message blip, so a call is told apart from a message by ear.
let ringInterval: ReturnType<typeof setInterval> | null = null;
/** The chime burst currently sounding, so stopping the chime cuts the
 *  in-flight notes instead of leaving them under the ringback. */
let ringtoneBurst: Playing | null = null;

/** Start the repeating incoming-call chime. Idempotent. */
export function startRingChime(): void {
  if (ringInterval !== null) return;
  // DND silences a call chime for the same reason it silences a message one:
  // the settings panel promises no notification sounds, and a ringing phone is
  // the loudest possible violation of that. The banner still appears.
  // D2(b): the call sound has its own toggle, so muting message sounds does
  // not silence a ringing phone; the ring has its own switch too.
  // A ring that will not sound pre-empts nothing: the outgoing ringback goes on.
  if (loadUserStatus() === "dnd") return;
  if (!loadPref<boolean>("callSounds", true)) return;
  if (!soundSwitchOn("ring")) return;
  // A client is either calling or being called; an incoming ring pre-empts the
  // outgoing ringback. The outgoing call keeps wanting its
  // ringback, so it resumes when this chime ends.
  silenceRingback();
  playRingtone();
  // The ring switch is re-read before each burst, so turning it off while the
  // phone rings stops the chime (and lets a pre-empted ringback resume).
  ringInterval = setInterval(() => {
    if (soundSwitchOn("ring")) playRingtone();
    else stopRingChime();
  }, 2000);
}

/** Stop the repeating incoming-call chime. Idempotent. */
export function stopRingChime(): void {
  stopRingtoneBurst();
  if (ringInterval !== null) {
    clearInterval(ringInterval);
    ringInterval = null;
  }
  // The incoming ring ended: an outgoing ring that was pre-empted resumes.
  syncRingback();
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

/** (Re)evaluate whether the ringback should be sounding right now. */
function syncRingback(): void {
  const shouldPlay =
    ringbackWanted &&
    ringInterval === null &&
    loadUserStatus() !== "dnd" &&
    loadPref<boolean>("callSounds", true) &&
    soundSwitchOn("ringback");
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

/** Every sound this module makes is silenced while the local user is deafened
 *  inside a voice session — except the ringtone, which D2 keeps for calls.
 *  Leaving voice releases the gate even though the stored deafen persists.
 *  Reads the leaf the lazy voice store mirrors (see lib/voiceDeafened.ts), so
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
interface Playing {
  stop(): void;
}

/** A sound as data: the one table both renderers draw from, so the
 *  Web Audio and native notes cannot drift. */
type ToneSpec = readonly NativeToneNote[];

const note = (at: number, duration: number, gain: number, hz: number): NativeToneNote => ({
  at,
  duration,
  gain,
  endGain: 0.01,
  freqs: [[0, hz]],
});

/** The message chime: one tone that falls from 800 Hz to 600 Hz. */
const NOTIFICATION_TONE: ToneSpec = [
  {
    at: 0,
    duration: 0.2,
    gain: 0.3,
    endGain: 0.01,
    freqs: [
      [0, 800],
      [0.1, 600],
    ],
  },
];

/** One burst of the ringtone: two rising notes, where a message falls. */
const RINGTONE_TONE: ToneSpec = [note(0, 0.16, 0.25, 660), note(0.18, 0.16, 0.25, 880)];

/** One burst of the ringback: a single soft, low tone, slower than the
 *  incoming ringtone and quieter, so the caller and the callee hear different
 *  things. */
const RINGBACK_TONE: ToneSpec = [note(0, 0.5, 0.12, 440)];

/** Render `spec` through Web Audio on the shared context, node for node as the
 *  sounds always were. A host without Web Audio logs `what` and plays nothing. */
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
      for (const [offset, hz] of n.freqs) osc.frequency.setValueAtTime(hz, start + offset);
      gain.gain.setValueAtTime(n.gain, start);
      gain.gain.exponentialRampToValueAtTime(n.endGain, start + n.duration);
      osc.start(start);
      osc.stop(start + n.duration);
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
 *  through Web Audio (whose `setSinkId` carries the saved output). */
function playSpec(spec: ToneSpec, what: string): Playing {
  return isLinuxDesktop() ? playNative(spec, what) : playWeb(spec, what);
}

/** One burst of the ringtone. */
function playRingtone(): void {
  // i18n-exempt: log text, never displayed
  ringtoneBurst = playSpec(RINGTONE_TONE, "Ringtone");
}

/** One burst of the ringback. Silent while deafened: the interval keeps
 *  polling, so undeafening mid-ring resumes the sound. */
function playRingback(): void {
  if (deafened()) return;
  // i18n-exempt: log text, never displayed
  ringbackBurst = playSpec(RINGBACK_TONE, "Ringback");
}

/** Play a brief notification chime. Silent while deafened. */
export function playNotificationSound(): void {
  if (deafened()) return;
  // i18n-exempt: log text, never displayed
  playSpec(NOTIFICATION_TONE, "Notification sound");
}

/** The short voice UI sounds: join/leave, a moderator's move,
 *  mute/unmute, deafen/undeafen, a stream starting and ending. */
export type VoiceSound =
  | "join"
  | "leave"
  | "moved"
  | "mute"
  | "unmute"
  | "deafen"
  | "undeafen"
  | "streamStart"
  | "streamEnd"
  | "viewerJoin"
  | "viewerLeave";

// A note (or pair) per edge, all under a fifth of a second. Distinct enough to
// tell apart by ear without being a message or a call.
const VOICE_SOUND_NOTES: Readonly<Record<VoiceSound, readonly (readonly [number, number])[]>> = {
  join: [
    [523, 0],
    [784, 0.09],
  ],
  leave: [
    [784, 0],
    [523, 0.09],
  ],
  // Two quick equal notes: you landed somewhere you did not pick.
  moved: [
    [659, 0],
    [659, 0.09],
  ],
  mute: [[392, 0]],
  unmute: [[587, 0]],
  deafen: [[330, 0]],
  undeafen: [[494, 0]],
  // Three notes, so a stream is told apart from a join or a leave.
  streamStart: [
    [440, 0],
    [587, 0.08],
    [880, 0.16],
  ],
  streamEnd: [
    [880, 0],
    [587, 0.08],
    [440, 0.16],
  ],
  // The streamer's cue that someone started or stopped watching: two soft
  // notes, the pair reversed for leaving (voiceTone plays them quieter).
  viewerJoin: [
    [659, 0],
    [880, 0.07],
  ],
  viewerLeave: [
    [880, 0],
    [659, 0.07],
  ],
};

/** Per-sound gain; the viewer cues sit well under the others (0.2). */
const VOICE_SOUND_GAIN: Readonly<Partial<Record<VoiceSound, number>>> = {
  viewerJoin: 0.1,
  viewerLeave: 0.1,
};

/** Each voice sound as a tone spec: a short note per `[hz, at]` pair. */
function voiceTone(kind: VoiceSound): ToneSpec {
  return VOICE_SOUND_NOTES[kind].map(([hz, at]) =>
    note(at, 0.12, VOICE_SOUND_GAIN[kind] ?? 0.2, hz),
  );
}

/** Play one voice UI sound. */
export function playVoiceSound(kind: VoiceSound): void {
  // i18n-exempt: log text, never displayed
  playSpec(voiceTone(kind), "Voice sound");
}

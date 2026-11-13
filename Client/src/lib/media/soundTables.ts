/**
 * Every app sound as data: one tone spec per sound and style, which both
 * renderers in `notificationSound.ts` draw. "modern" builds each musical note
 * from a voice (a few sine partials with a short attack and release);
 * "classic" keeps the plain sine tones OwnCord played before, note for note.
 * Pure data and builders: no imports beyond types, no side effects.
 */

import type { NativeToneNote } from "../../platform/contracts/nativeVoice";
import type { SoundStyle } from "../prefs/soundPrefs";

/** A sound as data. */
export type ToneSpec = readonly NativeToneNote[];

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

/** Every sound with a spec in both styles. */
export type AppSound = "message" | "mention" | "ring" | "ringback" | VoiceSound;

/** A voice: attack, release, the end gain as a share of the start gain, and
 *  its partials as `[frequency ratio, level, share of the note's length]`. */
interface Voice {
  readonly attack: number;
  readonly release: number;
  readonly tail: number;
  readonly partials: readonly (readonly [number, number, number])[];
}

const voice = (
  attack: number,
  release: number,
  tail: number,
  partials: Voice["partials"],
): Voice => ({ attack, release, tail, partials });

const GLASS = voice(0.002, 0.01, 0.001, [
  [1, 1, 1],
  [2, 0.42, 0.7],
  [3, 0.2, 0.5],
  [4, 0.09, 0.35],
]);
const MALLET = voice(0.003, 0.008, 0.001, [
  [1, 1, 1],
  [2, 0.3, 0.6],
  [3, 0.08, 0.4],
  [4, 0.16, 0.32],
]);
const SOFT = voice(0.018, 0.05, 0.75, [
  [1, 1, 1],
  [2, 0.14, 1],
]);

const C4 = 261.63;
const E4 = 329.63;
const A4 = 440;
const C5 = 523.25;
const D5 = 587.33;
const E5 = 659.25;
const G5 = 783.99;
const A5 = 880;
const C6 = 1046.5;
const D6 = 1174.66;
const E6 = 1318.51;

/** One musical note `[hz, at, duration]`. */
type Pitch = readonly [number, number, number];

/** A phrase of notes played by `v` at gain `g`: one tone note per partial. */
function phrase(v: Voice, g: number, notes: readonly Pitch[]): ToneSpec {
  return notes.flatMap(([hz, at, dur]) =>
    v.partials.map(([ratio, level, len]) => ({
      at,
      duration: dur * len,
      gain: g * level,
      endGain: g * level * v.tail,
      attack: v.attack,
      release: v.release,
      freqs: [[0, hz * ratio]] as const,
    })),
  );
}

/** A pitch that glides up from `from` to `to` Hz in 70 ms and pops. */
function bubble(duration: number, gain: number, from: number, to: number): NativeToneNote {
  return {
    at: 0,
    duration,
    gain,
    endGain: gain * 0.001,
    attack: 0.004,
    release: 0.008,
    glide: true,
    freqs: [
      [0, from],
      [0.07, to],
    ],
  };
}

const MODERN: Readonly<Record<AppSound, () => ToneSpec>> = {
  message: () => [bubble(0.16, 0.42, 420, 860), bubble(0.1, 0.42 * 0.22, 840, 1720)],
  mention: () =>
    phrase(GLASS, 0.236, [
      [G5, 0, 0.3],
      [D6, 0.11, 0.6],
    ]),
  ring: () =>
    phrase(MALLET, 0.247, [
      [G5, 0, 0.3],
      [C6, 0.14, 0.3],
      [E6, 0.28, 0.34],
      [C6, 0.42, 0.3],
      [G5, 0.56, 0.3],
      [C6, 0.7, 0.3],
      [E6, 0.84, 0.75],
    ]),
  ringback: () =>
    phrase(SOFT, 0.086, [
      [A4, 0, 0.36],
      [A4, 0.5, 0.36],
    ]),
  join: () =>
    phrase(MALLET, 0.205, [
      [C5, 0, 0.24],
      [G5, 0.1, 0.36],
    ]),
  leave: () =>
    phrase(MALLET, 0.203, [
      [G5, 0, 0.24],
      [C5, 0.1, 0.36],
    ]),
  moved: () =>
    phrase(MALLET, 0.232, [
      [E5, 0, 0.2],
      [E5, 0.11, 0.3],
    ]),
  mute: () =>
    phrase(MALLET, 0.21, [
      [E5, 0, 0.16],
      [C5, 0.075, 0.24],
    ]),
  unmute: () =>
    phrase(MALLET, 0.206, [
      [C5, 0, 0.16],
      [E5, 0.075, 0.24],
    ]),
  deafen: () =>
    phrase(MALLET, 0.326, [
      [E4, 0, 0.2],
      [C4, 0.085, 0.3],
    ]),
  undeafen: () =>
    phrase(MALLET, 0.317, [
      [C4, 0, 0.2],
      [E4, 0.085, 0.3],
    ]),
  streamStart: () =>
    phrase(MALLET, 0.185, [
      [A4, 0, 0.2],
      [D5, 0.085, 0.2],
      [A5, 0.17, 0.36],
    ]),
  streamEnd: () =>
    phrase(MALLET, 0.209, [
      [A5, 0, 0.2],
      [D5, 0.085, 0.2],
      [A4, 0.17, 0.36],
    ]),
  viewerJoin: () =>
    phrase(MALLET, 0.099, [
      [E5, 0, 0.16],
      [A5, 0.075, 0.26],
    ]),
  viewerLeave: () =>
    phrase(MALLET, 0.102, [
      [A5, 0, 0.16],
      [E5, 0.075, 0.26],
    ]),
};

/** A plain sine note with today's fixed tail. */
const plain = (at: number, duration: number, gain: number, hz: number): NativeToneNote => ({
  at,
  duration,
  gain,
  endGain: 0.01,
  freqs: [[0, hz]],
});

/** The classic voice sounds: a short note per `[hz, at]` pair. */
const CLASSIC_VOICE: Readonly<Record<VoiceSound, readonly (readonly [number, number])[]>> = {
  join: [
    [523, 0],
    [784, 0.09],
  ],
  leave: [
    [784, 0],
    [523, 0.09],
  ],
  moved: [
    [659, 0],
    [659, 0.09],
  ],
  mute: [[392, 0]],
  unmute: [[587, 0]],
  deafen: [[330, 0]],
  undeafen: [[494, 0]],
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
  viewerJoin: [
    [659, 0],
    [880, 0.07],
  ],
  viewerLeave: [
    [880, 0],
    [659, 0.07],
  ],
};

function classic(sound: AppSound): ToneSpec {
  switch (sound) {
    case "message":
    case "mention":
      // One tone that falls from 800 Hz to 600 Hz.
      return [
        {
          ...plain(0, 0.2, 0.3, 800),
          freqs: [
            [0, 800],
            [0.1, 600],
          ],
        },
      ];
    case "ring":
      return [plain(0, 0.16, 0.25, 660), plain(0.18, 0.16, 0.25, 880)];
    case "ringback":
      return [plain(0, 0.5, 0.12, 440)];
    default: {
      const gain = sound === "viewerJoin" || sound === "viewerLeave" ? 0.1 : 0.2;
      return CLASSIC_VOICE[sound].map(([hz, at]) => plain(at, 0.12, gain, hz));
    }
  }
}

/** The spec of `sound` in `style`. */
export function soundSpec(style: SoundStyle, sound: AppSound): ToneSpec {
  return style === "classic" ? classic(sound) : MODERN[sound]();
}

/** How often each style repeats the ring and the ringback, in milliseconds. */
export const REPEAT_MS: Readonly<Record<SoundStyle, { ring: number; ringback: number }>> = {
  modern: { ring: 2800, ringback: 3000 },
  classic: { ring: 2000, ringback: 3000 },
};

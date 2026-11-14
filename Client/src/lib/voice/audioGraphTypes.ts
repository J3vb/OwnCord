// Shapes the audio elements share with their gain graphs: split from
// audioElements.ts.

import type { VoiceRoom } from "./voiceRoom";

/** Where a remote voice track plays above 100%: its <audio> element stays
 *  attached (Chromium feeds a remote WebRTC track to Web Audio only while an
 *  element plays it) but muted, and the sound goes through this gain. At or
 *  below 100% the element plays it directly, as before. */
export interface MicGraph {
  readonly userId: number;
  readonly audioEl: HTMLAudioElement;
  readonly source: MediaStreamAudioSourceNode;
  readonly gain: GainNode;
}

/** AudioContext.setSinkId is not in TypeScript's DOM lib yet; WKWebView has
 *  none at all. */
export type SinkableContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };

/** The native room plays voice in its own mixer, which takes gains above 1. */
export function hasNativePlayout(room: VoiceRoom | null): boolean {
  return room !== null && "nativePlayout" in room;
}

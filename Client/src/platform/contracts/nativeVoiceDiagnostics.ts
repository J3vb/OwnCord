/**
 * Native voice mic test and stats types. Split from `nativeVoice.ts`, which
 * re-exports every name.
 */
import type { NativeVoiceAudioOptions } from "./nativeVoice";

/** What the settings tab's mic test starts with (Linux only). */
export interface NativeMicTestOptions {
  /** `listDevices` ids; empty selects the host default. */
  input: string;
  output: string;
  audio: NativeVoiceAudioOptions;
  /** The input volume, percent (0-200). */
  inputGain: number;
  /** The output volume, linear (0-1). */
  outputGain: number;
  /** The voice gate's threshold on the web path's scale; 0 is no gate. */
  threshold: number;
  /** The voice gate also asks RNNoise's verdict (whenever a gate runs). */
  speech?: boolean;
  /** Capture and report levels only: no output is opened or played. */
  monitor?: boolean;
}

/** A live change to a running mic test. */
export type NativeMicTestUpdate =
  | { kind: "processing"; audio: NativeVoiceAudioOptions }
  | { kind: "inputGain"; percent: number }
  | { kind: "voiceGate"; threshold: number; retune: boolean; speech?: boolean }
  | { kind: "outputGain"; gain: number }
  | { kind: "inputDevice"; deviceId: string }
  | { kind: "outputDevice"; deviceId: string };

export type NativeMicTestEvent =
  | { type: "inputLevel"; rms: number; open: boolean }
  /** The host stopped the test (a call joined). */
  | { type: "ended" };

export interface NativeMicTestEnvelope {
  /** The id `startMicTest` resolved with. */
  test: number;
  event: NativeMicTestEvent;
}

/** The host's refusal of a mic test start during a call. */
// i18n-exempt: the host's refusal code, matched by the tab, never shown
export const NATIVE_MIC_TEST_IN_CALL = "mic test unavailable during a call";

/** One W3C-shaped stats entry (`RTCStats` field names) of a transport, cut to
 *  what `connectionStats.ts` reads. Times are seconds, as in the W3C reports. */
export type NativeVoiceStatsEntry =
  | {
      type: "candidate-pair";
      id: string;
      currentRoundTripTime: number;
      bytesSent: number;
      bytesReceived: number;
    }
  | { type: "outbound-rtp"; id: string; kind: string; packetsSent: number; bytesSent: number }
  | {
      type: "inbound-rtp";
      id: string;
      kind: string;
      packetsReceived: number;
      bytesReceived: number;
      packetsLost: number;
      jitter: number;
    }
  | {
      type: "remote-inbound-rtp";
      id: string;
      kind: string;
      /** The id of the outbound entry this one reports on. */
      localId: string;
      packetsLost: number;
      jitter: number;
    };

/** A subscribed remote video track's receiver sample. */
export interface NativeVoiceReceiverSample {
  frameWidth: number;
  frameHeight: number;
  framesDecoded: number;
  bytesReceived: number;
  packetsLost: number;
  packetsReceived: number;
  mimeType?: string;
}

/** One encoder layer of a local video track. */
export interface NativeVoiceSenderLayer {
  framesPerSecond?: number;
  frameWidth: number;
  frameHeight: number;
  qualityLimitationReason: string;
  encoderImplementation?: string;
  active: boolean;
}

/** One stats sample of a native session. */
export interface NativeVoiceStats {
  /** Host wall clock (ms since the epoch) at collection. */
  atMs: number;
  publisher: NativeVoiceStatsEntry[];
  /** Empty in single-PC mode. */
  subscriber: NativeVoiceStatsEntry[];
  /** Subscribed remote video by publication sid. */
  remoteVideo: Record<string, NativeVoiceReceiverSample>;
  /** Local video by source. */
  localVideo: { camera?: NativeVoiceSenderLayer[]; screen_share?: NativeVoiceSenderLayer[] };
}

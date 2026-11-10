// Optional capabilities of a room that runs its own capture (the Linux native
// room), which AudioPipeline probes for. Split from audioPipeline.ts.

/** A room that gates its own capture for push-to-talk: the Linux NativeRoom,
 *  whose microphone is the Rust session's and never has a web processor. */
export interface PttGatedRoom {
  setPttGated(gated: boolean): void;
}

/** A room that runs the sensitivity gate on its own capture (NativeRoom),
 *  reporting its verdicts as the detector's `onGate` would; "auto" runs the
 *  noise-floor estimate there, seeded and reported as the detector's. */
export interface VoiceGatedRoom {
  setVoiceGate(
    gate: number | "auto",
    onSpeaking: (speaking: boolean | null) => void,
    auto?: { seed?: number; onThreshold?: (threshold: number) => void },
  ): void;
}

/** A room whose own capture takes the input volume and reports its level
 *  (NativeRoom): the meter's feed where no web processor runs. */
export interface InputGainRoom {
  setInputGain(percent: number): void;
  setInputLevelListener(listener: ((rms: number | null, open: boolean) => void) | null): void;
}

/** A room whose own capture takes the four processing toggles live
 *  (NativeRoom): there is no web mic track to restart or processor to
 *  reroute. */
export interface AudioProcessingRoom {
  setAudioProcessing(audio: {
    echoCancellation: boolean;
    noiseSuppression: boolean;
    autoGainControl: boolean;
    enhancedNoiseSuppression: boolean;
  }): void;
}

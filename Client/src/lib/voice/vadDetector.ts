// Sensitivity detector for the outbound mic: Silero or RNNoise's speech
// verdict through an audio worklet, falling back to a level poll, with an
// optional automatic noise-floor threshold. Split from audioPipeline.ts.

import { createLogger } from "@lib/logger";
import { publicAssetUrl } from "@lib/media/publicAssets";
import { workletStopped } from "@lib/voice/micProcessor";
import { NoiseFloorTracker } from "@lib/voice/noiseFloor";

const log = createLogger("audioPipeline");

/** Hysteresis: the gate closes only this far below the level it opens at
 *  (vad-worklet.js HYSTERESIS_DB). */
export const GATE_HYSTERESIS_DB = 6;
const GATE_CLOSE_RATIO = 10 ** (-GATE_HYSTERESIS_DB / 20);

export interface SpeechDetection {
  readonly numberOfInputs: 2 | 3;
  bind(node: AudioWorkletNode): (enabled: boolean) => void;
}

export interface VadDetector {
  /** Resolves once the worklet has stopped: only then may its context close. */
  stop(): Promise<void>;
  setSpeechDetection(enabled: boolean): void;
  /** Move the threshold without restarting, or hand it to the automatic
   *  noise-floor estimate ("auto"). */
  setThreshold(threshold: number | "auto"): void;
  /** The input gain ahead of the detector moved: relearn the floor. */
  resetFloor(): void;
}

export interface VadDetectorHandlers {
  /** The gate verdict: true = closed (silence). */
  onGate(gated: boolean): void;
  /** The loudest smoothed level since the last report, for a level meter. */
  onRms?(rms: number): void;
  /** Which path is running once it has started. */
  onStarted?(usingWorklet: boolean): void;
  /** The automatic threshold moved (only while running "auto"). */
  onThreshold?(threshold: number): void;
}

/** Run the mic detector on its analyser tap. It uses Silero when available,
 * then RNNoise's speech verdict, then level alone if audio worklets fail.
 * Automatic sensitivity tracks the noise floor of the reported levels. */
export function startVadDetector(
  ctx: AudioContext,
  analyser: AnalyserNode,
  gate: number | "auto",
  handlers: VadDetectorHandlers,
  seed?: number,
  speech?: SpeechDetection,
  speechEnabled = true,
): VadDetector {
  let tracker = gate === "auto" ? new NoiseFloorTracker(seed) : null;
  let threshold = tracker?.threshold ?? (gate as number);
  let gated = threshold > 0;
  handlers.onGate(gated);
  const reportGate = (closed: boolean): void => {
    if (closed === gated) return;
    gated = closed;
    handlers.onGate(closed);
  };
  let stopped = false;
  let workletNode: AudioWorkletNode | null = null;
  let setSpeechGate: ((on: boolean) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Every level report: the meter's, and the automatic estimate's input. */
  const onLevel = (rms: number): void => {
    handlers.onRms?.(rms);
    const moved = tracker?.push(rms, performance.now()) ?? null;
    if (moved === null) return;
    threshold = moved;
    // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
    workletNode?.port.postMessage({ type: "threshold", threshold });
    handlers.onThreshold?.(moved);
  };

  const startFallback = (): void => {
    // setTimeout instead of rAF: rAF pauses when the Tauri window is
    // backgrounded, which freezes the VAD gate. setTimeout continues firing
    // (throttled ~1Hz when hidden), still fast enough for VAD gate timing.
    const dataArray = new Float32Array(analyser.fftSize);
    let quietSince = 0; // Date.now() of the first poll below the close level, 0 = none
    let speechFrames = 0;
    const GATE_HOLD_MS = 500; // as vad-worklet.js holds; elapsed time, as timers throttle
    const GATE_OFF_FRAMES = 2;
    let startupFrames = 0;
    const STARTUP_GRACE = 30;
    let frameCounter = 0;
    const updateGate = (rms: number): void => {
      if (threshold === 0) {
        speechFrames = 0;
        quietSince = 0;
      } else if (gated) {
        // The attack counts up at the threshold and down below it, as the
        // worklet's does, so one dip inside an onset does not start it over.
        if (rms >= threshold) speechFrames++;
        else if (speechFrames > 0) speechFrames--;
        if (speechFrames >= GATE_OFF_FRAMES) {
          speechFrames = 0;
          quietSince = 0;
          reportGate(false);
        }
      } else if (rms < threshold * GATE_CLOSE_RATIO) {
        const now = Date.now();
        if (quietSince === 0) quietSince = now;
        if (now - quietSince >= GATE_HOLD_MS) {
          quietSince = 0;
          speechFrames = 0;
          reportGate(true);
        }
      } else {
        quietSince = 0;
      }
    };
    const poll = (): void => {
      if (stopped) return;
      analyser.getFloatTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] ?? 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      frameCounter++;
      // One poll's level, not the worklet's 50 ms peak: the automatic
      // margin absorbs the difference.
      // The start-up grace is the capture settling: the meter shows it, the
      // automatic floor does not learn from it (the worklet reports none).
      if (frameCounter >= 3) {
        frameCounter = 0;
        if (startupFrames < STARTUP_GRACE) handlers.onRms?.(rms);
        else onLevel(rms);
      }
      if (startupFrames < STARTUP_GRACE) {
        startupFrames++;
      }
      updateGate(rms);
      timer = setTimeout(poll, 16);
    };
    timer = setTimeout(poll, 16);
    handlers.onStarted?.(false);
    log.info("VAD setTimeout fallback started", { threshold });
  };

  ctx.audioWorklet
    .addModule(publicAssetUrl("vad-worklet.js"))
    .then(() => {
      if (stopped) return;
      try {
        workletNode = new AudioWorkletNode(ctx, "vad-processor", {
          numberOfInputs: speech?.numberOfInputs ?? 2,
        });
      } catch (err) {
        log.warn("Failed to create VAD AudioWorkletNode, falling back", err);
        startFallback();
        return;
      }
      // Analysis only: the worklet's output goes nowhere.
      analyser.connect(workletNode);
      const config = {
        type: "config",
        threshold,
        speechGate: speechEnabled && speech !== undefined,
      };
      // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
      workletNode.port.postMessage(config);
      if (speech !== undefined) {
        setSpeechGate = speech.bind(workletNode);
        setSpeechGate(speechEnabled);
      }
      // oxlint-disable-next-line prefer-add-event-listener -- MessagePort does not support addEventListener
      workletNode.port.onmessage = (event: MessageEvent) => {
        if (event.data.type === "gate") reportGate(event.data.gated as boolean);
        else if (event.data.type === "rms") onLevel(event.data.value as number);
      };
      handlers.onStarted?.(true);
      log.info("VAD AudioWorklet started", { threshold });
    })
    .catch((err) => {
      if (stopped) return;
      log.warn("AudioWorklet unavailable, falling back to setTimeout VAD", err);
      startFallback();
    });

  const stop = (): Promise<void> => {
    stopped = true;
    setSpeechGate?.(false);
    if (timer !== null) clearTimeout(timer);
    const node = workletNode;
    if (node === null) return Promise.resolve();
    workletNode = null;
    // Swap the handler first — the worklet's `process()` loop only observes
    // `stop` on its next audio-thread callback, so it can still post one more
    // {type:"gate"} message after this postMessage.
    const done = workletStopped(node);
    // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
    node.port.postMessage({ type: "stop" });
    node.disconnect();
    return done;
  };
  return {
    stop,
    setSpeechDetection(enabled): void {
      if (stopped) return;
      speechEnabled = enabled;
      setSpeechGate?.(enabled);
    },
    setThreshold(next: number | "auto"): void {
      if (next === "auto" && tracker !== null) return;
      if (next === threshold && tracker === null) return;
      const wasEnabled = threshold > 0;
      tracker = next === "auto" ? new NoiseFloorTracker(seed) : null;
      threshold = tracker?.threshold ?? (next as number);
      if (wasEnabled !== threshold > 0) reportGate(threshold > 0);
      // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
      workletNode?.port.postMessage({ type: "threshold", threshold });
    },
    resetFloor(): void {
      tracker?.reset(performance.now());
    },
  };
}

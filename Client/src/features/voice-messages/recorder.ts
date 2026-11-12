/**
 * The voice-message recorder. One recorder is one recording: start it,
 * then stop it for the clip or cancel it. It captures the microphone with
 * MediaRecorder in the first container the webview supports, or, where
 * MediaRecorder is missing or supports none, as PCM (an AudioWorklet, or a
 * ScriptProcessor where worklets are unavailable) encoded to a 16 kHz mono WAV.
 * An AnalyserNode is sampled every ~100 ms for the live bars; at stop the
 * samples are reduced to 64 bars.
 *
 * Every exit (stop, cancel, dispose, failure to start) stops every track of the
 * stream and closes the AudioContext, so the OS microphone indicator goes out.
 */

import { Disposable } from "@lib/disposable";
import { setOwnedTimeout } from "@lib/dom";
import { loadPref } from "@lib/prefs/preferences";
import { publicAssetUrl } from "@lib/media/publicAssets";
import { clipFilename, pickRecorderMime } from "./mime";
import {
  audioConstraints,
  errorName,
  linuxMicDeviceId,
  openErrorKind,
  resolveGetUserMedia,
} from "./recorderDevices";
import { encodeWaveform, reducePeaks, WAVEFORM_BARS } from "./waveform";
import { encodeWav } from "./wav";
import { isLinuxDesktop } from "../voice/native/platform";

/** A recording ends on its own here. */
export const MAX_DURATION_MS = 300_000;
/** A shorter recording is discarded. */
export const MIN_DURATION_MS = 1_000;
/** How often the level is sampled. */
export const LEVEL_INTERVAL_MS = 100;
/** How long stop() waits for the worklet to hand over its last partial block. */
export const FLUSH_TIMEOUT_MS = 300;
/** How long stop() waits for MediaRecorder's `stop` event before giving up. */
export const STOP_TIMEOUT_MS = 2000;

export interface VoiceClip {
  readonly blob: Blob;
  readonly mime: string;
  readonly filename: string;
  readonly durationMs: number;
  /** base64url, no padding. */
  readonly waveform: string;
  /** The same bars as bytes, for drawing. */
  readonly bars: Uint8Array;
}

export type VoiceRecordErrorKind =
  "denied" | "no-device" | "unsupported" | "suspended" | "failed" | "cancelled";

export class VoiceRecordError extends Error {
  readonly kind: VoiceRecordErrorKind;
  constructor(kind: VoiceRecordErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "VoiceRecordError";
    this.kind = kind;
  }
}

/** The browser objects the recorder uses; tests pass fakes. */
export interface RecorderEnv {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  MediaRecorder?: typeof MediaRecorder | undefined;
  AudioContext?: typeof AudioContext | undefined;
  now?: () => number;
  /** The picked microphone as a webview device id, "" for the default. */
  micDeviceId?: () => Promise<string>;
}

export interface VoiceRecorderOptions {
  /** A level sample: peak 0..1 and the elapsed time. */
  readonly onLevel?: (peak: number, elapsedMs: number) => void;
  /** The recording hit MAX_DURATION_MS and was stopped; `clip` is what it made. */
  readonly onLimit?: (clip: VoiceClip | null) => void;
  /** Stopping at the limit failed; the recording is gone. */
  readonly onLimitFailed?: () => void;
  /** The microphone went away mid-recording (unplugged); the recording was dropped. */
  readonly onDeviceLost?: () => void;
  readonly env?: RecorderEnv;
}

export interface VoiceRecorder {
  /** Open the microphone and begin. Rejects with a VoiceRecordError. */
  start(): Promise<void>;
  /** End the recording. Null when it was shorter than MIN_DURATION_MS or not recording. */
  stop(): Promise<VoiceClip | null>;
  /** Drop the recording and release the microphone. */
  cancel(): void;
  /** cancel(), and the recorder cannot be started again. */
  dispose(): void;
  readonly state: "idle" | "starting" | "recording" | "stopping" | "done";
}

/** The context and recorder constructors to use: the env's, else the browser's. */
function resolveCtors(env: RecorderEnv): {
  AudioCtor: typeof AudioContext | undefined;
  RecorderCtor: typeof MediaRecorder | undefined;
} {
  const AudioCtor =
    env.AudioContext ?? (typeof AudioContext === "undefined" ? undefined : AudioContext);
  let RecorderCtor: typeof MediaRecorder | undefined;
  if ("MediaRecorder" in env) RecorderCtor = env.MediaRecorder;
  else RecorderCtor = typeof MediaRecorder === "undefined" ? undefined : MediaRecorder;
  return { AudioCtor, RecorderCtor };
}

function asRecordError(err: unknown): VoiceRecordError {
  return err instanceof VoiceRecordError ? err : new VoiceRecordError("failed");
}

export function createVoiceRecorder(options: VoiceRecorderOptions = {}): VoiceRecorder {
  const env = options.env ?? {};
  const now = env.now ?? ((): number => performance.now());
  const owner = new Disposable();
  let state: VoiceRecorder["state"] = "idle";
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let recorder: MediaRecorder | null = null;
  let mime = "";
  let chunks: Blob[] = [];
  // PCM fallback.
  let pcm: Float32Array[] = [];
  let pcmNodes: AudioNode[] = [];
  let pcmRate = 16_000;
  let hasLevels = false;
  let flushPort: MessagePort | null = null;
  let onFlushed: (() => void) | null = null;
  const peaks: number[] = [];
  let startedAt = 0;
  let stopping: Promise<VoiceClip | null> | null = null;
  let rejectStop: ((err: Error) => void) | null = null;

  function elapsed(): number {
    return Math.min(MAX_DURATION_MS, Math.max(0, now() - startedAt));
  }

  /** Stop every track, close the context, detach everything. Safe to repeat. */
  function release(): void {
    if (recorder !== null) {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // Already stopped.
      }
      recorder = null;
    }
    for (const node of pcmNodes) {
      try {
        node.disconnect();
      } catch {
        // Not connected.
      }
    }
    pcmNodes = [];
    if (analyser !== null) {
      try {
        analyser.disconnect();
      } catch {
        // Not connected.
      }
      analyser = null;
    }
    if (stream !== null) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // A track that will not stop has nothing more to give.
        }
      }
      stream = null;
    }
    if (ctx !== null) {
      const closing = ctx;
      ctx = null;
      try {
        void closing.close().catch(() => {});
      } catch {
        // Already closed.
      }
    }
    owner.destroy();
  }

  function tick(): void {
    if (state !== "recording") return;
    let peak = 0;
    if (analyser !== null) {
      hasLevels = true;
      const buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf);
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      peak = Math.min(1, peak);
    }
    peaks.push(peak);
    options.onLevel?.(peak, elapsed());
    setOwnedTimeout(owner.signal, tick, LEVEL_INTERVAL_MS);
  }

  async function openStream(): Promise<MediaStream> {
    const getUserMedia = resolveGetUserMedia(env.getUserMedia);
    if (getUserMedia === undefined) throw new VoiceRecordError("unsupported");
    const lookup = env.micDeviceId ?? (isLinuxDesktop() ? linuxMicDeviceId : null);
    const deviceId =
      lookup === null ? loadPref<string>("audioInputDevice", "") : await lookup().catch(() => "");
    if (state !== "starting") throw new VoiceRecordError("cancelled");
    try {
      return await getUserMedia(audioConstraints(deviceId));
    } catch (err) {
      const kind = openErrorKind(errorName(err));
      if (kind !== "no-device" || deviceId === "") throw new VoiceRecordError(kind);
    }
    // The picked device is unplugged: the system default still works.
    try {
      return await getUserMedia(audioConstraints(""));
    } catch (retry) {
      throw new VoiceRecordError(openErrorKind(errorName(retry)));
    }
  }

  async function startPcm(audio: AudioContext, source: MediaStreamAudioSourceNode): Promise<void> {
    pcmRate = audio.sampleRate;
    const sink = audio.createGain();
    sink.gain.value = 0;
    sink.connect(audio.destination);
    pcmNodes.push(sink);
    let worklet: AudioWorkletNode | null = null;
    if (audio.audioWorklet !== undefined && typeof AudioWorkletNode !== "undefined") {
      try {
        await audio.audioWorklet.addModule(publicAssetUrl("pcm-capture-worklet.js"));
        worklet = new AudioWorkletNode(audio, "pcm-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
      } catch {
        worklet = null;
      }
    }
    if (worklet !== null) {
      worklet.port.addEventListener(
        "message",
        (e: MessageEvent<unknown>): void => {
          if (e.data instanceof Float32Array) pcm.push(e.data);
          else if ((e.data as { type?: unknown } | null)?.type === "flushed") onFlushed?.();
        },
        { signal: owner.signal },
      );
      worklet.port.start();
      flushPort = worklet.port;
      source.connect(worklet);
      worklet.connect(sink);
      pcmNodes.push(worklet);
      return;
    }
    if (typeof audio.createScriptProcessor !== "function") {
      throw new VoiceRecordError("unsupported");
    }
    const processor = audio.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e: AudioProcessingEvent): void => {
      pcm.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(sink);
    pcmNodes.push(processor);
  }

  async function start(): Promise<void> {
    if (state !== "idle") throw new VoiceRecordError("failed");
    state = "starting";
    let opened: MediaStream;
    try {
      opened = await openStream();
    } catch (err) {
      if (state === "starting") state = "done";
      throw err;
    }
    stream = opened;
    if (state !== "starting") {
      // Cancelled while the permission prompt was up: let go of the microphone.
      release();
      throw new VoiceRecordError("cancelled");
    }
    try {
      const { AudioCtor, RecorderCtor } = resolveCtors(env);
      mime = pickRecorderMime(RecorderCtor) ?? "";
      let source: MediaStreamAudioSourceNode | null = null;
      if (AudioCtor !== undefined) {
        try {
          ctx = new AudioCtor();
          await ctx.resume().catch(() => {});
          source = attachMeter(ctx, opened);
        } catch {
          // No level metering: MediaRecorder can still record (flat waveform);
          // the PCM fallback needs the context and fails below.
          source = null;
          analyser = null;
          closeBrokenContext();
        }
      }
      if (mime !== "" && RecorderCtor !== undefined) {
        startMediaRecorder(RecorderCtor, opened);
      } else {
        mime = "audio/wav";
        if (ctx === null || source === null) throw new VoiceRecordError("unsupported");
        // A suspended context delivers no samples: fail rather than upload silence.
        if (ctx.state !== "running") throw new VoiceRecordError("suspended");
        await startPcm(ctx, source);
      }
    } catch (err) {
      release();
      state = "done";
      throw asRecordError(err);
    }
    if ((state as VoiceRecorder["state"]) !== "starting") {
      release();
      throw new VoiceRecordError("cancelled");
    }
    watchTracks(opened);
    state = "recording";
    startedAt = now();
    setOwnedTimeout(owner.signal, tick, LEVEL_INTERVAL_MS);
    setOwnedTimeout(
      owner.signal,
      () => {
        if (state !== "recording") return;
        stop().then(
          (clip) => options.onLimit?.(clip),
          () => options.onLimitFailed?.(),
        );
      },
      MAX_DURATION_MS,
    );
  }

  /** Connect the level analyser to the stream; the source node feeds the PCM path too. */
  function attachMeter(audio: AudioContext, opened: MediaStream): MediaStreamAudioSourceNode {
    const source = audio.createMediaStreamSource(opened);
    analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    return source;
  }

  function closeBrokenContext(): void {
    const broken = ctx;
    ctx = null;
    try {
      void broken?.close().catch(() => {});
    } catch {
      // Already closed.
    }
  }

  function startMediaRecorder(RecorderCtor: typeof MediaRecorder, opened: MediaStream): void {
    const rec = new RecorderCtor(opened, { mimeType: mime });
    rec.addEventListener(
      "dataavailable",
      (e: BlobEvent): void => {
        if (e.data.size > 0) chunks.push(e.data);
      },
      { signal: owner.signal },
    );
    recorder = rec;
    rec.start(1000);
  }

  /** The microphone going away mid-recording drops the clip and tells the owner. */
  function watchTracks(opened: MediaStream): void {
    for (const track of opened.getTracks()) {
      track.addEventListener(
        "ended",
        () => {
          if (state !== "recording") return;
          cancel();
          options.onDeviceLost?.();
        },
        { signal: owner.signal },
      );
    }
  }

  function finish(durationMs: number, blob: Blob): VoiceClip | null {
    if (durationMs < MIN_DURATION_MS) return null;
    // Without level metering the waveform is flat and low rather than empty.
    const bars = hasLevels
      ? reducePeaks(peaks, WAVEFORM_BARS)
      : new Uint8Array(WAVEFORM_BARS).fill(32);
    return {
      blob,
      mime,
      filename: clipFilename(mime),
      durationMs: Math.min(MAX_DURATION_MS, Math.round(durationMs)),
      waveform: encodeWaveform(bars),
      bars,
    };
  }

  function stop(): Promise<VoiceClip | null> {
    if (stopping !== null) return stopping;
    if (state !== "recording") return Promise.resolve(null);
    state = "stopping";
    const durationMs = elapsed();
    stopping = new Promise<VoiceClip | null>((resolve, reject) => {
      rejectStop = reject;
      const done = (blob: Blob, measuredMs: number = durationMs): void => {
        const clip = finish(measuredMs, blob);
        release();
        state = "done";
        resolve(clip);
      };
      const rec = recorder;
      if (rec !== null) {
        rec.addEventListener(
          "error",
          (): void => {
            release();
            state = "done";
            reject(new VoiceRecordError("failed"));
          },
          { signal: owner.signal },
        );
        rec.addEventListener("stop", (): void => done(new Blob(chunks, { type: mime })), {
          signal: owner.signal,
        });
        setOwnedTimeout(
          owner.signal,
          () => {
            // No `stop` event: give up rather than hang the composer.
            release();
            state = "done";
            reject(new VoiceRecordError("failed"));
          },
          STOP_TIMEOUT_MS,
        );
        try {
          rec.stop();
        } catch {
          release();
          state = "done";
          reject(new VoiceRecordError("failed"));
        }
        return;
      }
      const finishPcm = (): void => {
        // The length is what was captured, not the wall clock.
        let samples = 0;
        for (const c of pcm) samples += c.length;
        done(
          new Blob([encodeWav(pcm, pcmRate) as BlobPart], { type: mime }),
          (samples / pcmRate) * 1000,
        );
      };
      if (flushPort === null) {
        finishPcm();
        return;
      }
      // The worklet holds up to one partial block: ask for it and wait, bounded,
      // so the tail of the clip is not dropped.
      let settled = false;
      const go = (): void => {
        if (settled) return;
        settled = true;
        finishPcm();
      };
      onFlushed = go;
      setOwnedTimeout(owner.signal, go, FLUSH_TIMEOUT_MS);
      // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
      flushPort.postMessage({ type: "flush" });
    });
    return stopping;
  }

  function cancel(): void {
    if (state === "done") return;
    const wasStopping = state === "stopping";
    state = "done";
    chunks = [];
    pcm = [];
    release();
    if (wasStopping) rejectStop?.(new VoiceRecordError("cancelled"));
  }

  return {
    start,
    stop,
    cancel,
    dispose: cancel,
    get state() {
      return state;
    },
  };
}

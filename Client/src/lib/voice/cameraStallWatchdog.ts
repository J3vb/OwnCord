// Notices when the local camera stops sending frames and when it starts again,
// from the sender stats the connection-stats poll already reads. Records raw
// facts only (camera.stalled / camera.resumed); deciding why is not its job.
//
// A layer the server paused because nobody watches (dynacast) is inactive and
// does not count, so a camera nobody is watching never looks stalled.
import { recordEvent } from "@lib/diagnostics/eventSink";

/** Same value as CAMERA_STALL_THRESHOLD_MS in the catalogue (a test keeps them
 *  equal); copied so this lazy chunk does not pull the whole catalogue in. */
export const STALL_THRESHOLD_MS = 2000;

export interface CameraLayerSample {
  readonly rid: string;
  readonly active: boolean;
  readonly framesSent: number;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly encoder?: string;
  readonly hardwareEncoder?: boolean;
  readonly qualityLimitation?: string;
}

export interface CameraSample {
  /** The camera is published, its track is live and the user has not muted it. */
  readonly live: boolean;
  readonly layers: readonly CameraLayerSample[];
}

type Limitation = "none" | "cpu" | "bandwidth" | "other" | "unknown";

function limitation(value: string | undefined): Limitation {
  return value === "none" || value === "cpu" || value === "bandwidth" || value === "other"
    ? value
    : "unknown";
}

/** encoderImplementation can read "ExternalEncoder (MediaFoundationVideoEncoder)". */
function encoderToken(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 48);
}

function facts(active: readonly CameraLayerSample[]) {
  const top = active.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a));
  return {
    frames_sent: active.reduce((sum, l) => sum + l.framesSent, 0),
    encoder: encoderToken(top.encoder),
    hardware_encoder: top.hardwareEncoder ?? null,
    quality_limitation: limitation(top.qualityLimitation),
    width: top.width ?? null,
    height: top.height ?? null,
    fps: top.fps ?? null,
    active_layers: active.length,
  };
}

export interface CameraStallWatchdog {
  sample(now: number, sample: CameraSample): void;
  reset(): void;
}

export function createCameraStallWatchdog(): CameraStallWatchdog {
  let frames = new Map<string, number>();
  let lastProgressAt = 0;
  let stalled = false;

  function reset(): void {
    frames = new Map();
    stalled = false;
  }

  function sample(now: number, input: CameraSample): void {
    const active = input.layers.filter((l) => l.active);
    if (!input.live || active.length === 0) {
      reset();
      return;
    }
    let progressed = false;
    const next = new Map<string, number>();
    for (const layer of active) {
      const before = frames.get(layer.rid);
      if (before === undefined || layer.framesSent > before) progressed = true;
      next.set(layer.rid, layer.framesSent);
    }
    const first = frames.size === 0;
    frames = next;
    if (progressed) {
      if (stalled) {
        recordEvent("camera.resumed", { ...facts(active), gap_ms: now - lastProgressAt });
        stalled = false;
      }
      lastProgressAt = now;
      return;
    }
    if (first) lastProgressAt = now;
    if (!stalled && now - lastProgressAt >= STALL_THRESHOLD_MS) {
      stalled = true;
      recordEvent("camera.stalled", facts(active));
    }
  }

  return { sample, reset };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** One camera sample from a sender stats report's outbound-rtp entries. */
export function cameraSampleFromStats(live: boolean, report: Iterable<unknown>): CameraSample {
  const layers: CameraLayerSample[] = [];
  for (const raw of report) {
    const entry = raw as Record<string, unknown>;
    if (entry.type !== "outbound-rtp" || entry.kind !== "video") continue;
    if (typeof entry.framesSent !== "number") continue;
    layers.push({
      rid:
        typeof entry.rid === "string"
          ? entry.rid
          : typeof entry.ssrc === "number"
            ? String(entry.ssrc)
            : String(layers.length),
      active: entry.active !== false,
      framesSent: entry.framesSent,
      width: num(entry.frameWidth),
      height: num(entry.frameHeight),
      fps: num(entry.framesPerSecond),
      encoder:
        typeof entry.encoderImplementation === "string" ? entry.encoderImplementation : undefined,
      hardwareEncoder:
        typeof entry.powerEfficientEncoder === "boolean" ? entry.powerEfficientEncoder : undefined,
      qualityLimitation:
        typeof entry.qualityLimitationReason === "string"
          ? entry.qualityLimitationReason
          : undefined,
    });
  }
  return { live, layers };
}

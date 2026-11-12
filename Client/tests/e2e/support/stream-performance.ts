// Real-media numbers read from the browser's own WebRTC stats, for the opt-in
// measurements (media-cost and stream-performance). Read-only: nothing here
// publishes, subscribes or changes a setting. Needs installMediaProbe.
import type { CDPSession, Page } from "@playwright/test";
import { counterDeltas, createSampler, type Sampler } from "../../../scripts/perf-stats.mjs";

export interface RtpEntry {
  readonly id: string;
  readonly dir: "out" | "in";
  readonly kind: string;
  /** "mic" or "screen" for outbound audio, from the track that feeds it (see watchDisplayCapture). */
  readonly source?: "mic" | "screen";
  readonly rid?: string;
  readonly bytes: number;
  readonly frames: number;
  /** Seconds spent encoding (out) or decoding (in). */
  readonly codecSecs: number;
  readonly packets: number;
  readonly packetsLost: number;
  readonly freezes: number;
  readonly freezeSecs: number;
  readonly framesDropped: number;
  readonly jitterSecs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly impl?: string;
  readonly limitedBy?: string;
}

export const RTP_COUNTERS = [
  "bytes",
  "frames",
  "codecSecs",
  "packets",
  "packetsLost",
  "freezes",
  "freezeSecs",
  "framesDropped",
] as const;

type CaptureWindow = typeof window & {
  __ocDisplayTracks?: { ids: Set<string>; labels: Set<string> };
};

/**
 * Remembers the tracks screen capture hands out from now on, so outbound
 * audio can be split into microphone and screen audio (the microphone is
 * sent through a Web Audio node, so its sent track is not the captured one).
 * Call before starting a share.
 */
export async function watchDisplayCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as CaptureWindow;
    if (w.__ocDisplayTracks) return;
    const seen = { ids: new Set<string>(), labels: new Set<string>() };
    w.__ocDisplayTracks = seen;
    const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (options) => {
      const stream = await original(options);
      for (const track of stream.getTracks()) {
        seen.ids.add(track.id);
        seen.labels.add(track.label);
      }
      return stream;
    };
  });
}

export async function readRtp(page: Page): Promise<RtpEntry[]> {
  return page.evaluate(async () => {
    const display = (window as CaptureWindow).__ocDisplayTracks;
    const entries: RtpEntry[] = [];
    const peers = window.__ocMedia.peers.filter((p) => p.connectionState !== "closed");
    const reports = await Promise.all(peers.map((p) => p.getStats()));
    for (const [index, report] of reports.entries()) {
      const peer = peers[index]!;
      const sources = new Map<string, string>();
      report.forEach((e: Record<string, unknown>) => {
        if (e.type === "media-source" && typeof e.trackIdentifier === "string")
          sources.set(String(e.id), e.trackIdentifier);
      });
      const labels = new Map(
        peer.getSenders().flatMap((s) => (s.track ? [[s.track.id, s.track.label] as const] : [])),
      );
      const fromScreen = (track: string) =>
        !!display && (display.ids.has(track) || display.labels.has(labels.get(track) ?? "\0"));
      report.forEach((e: Record<string, unknown>) => {
        const out = e.type === "outbound-rtp";
        if (!out && e.type !== "inbound-rtp") return;
        const num = (key: string) => (typeof e[key] === "number" ? (e[key] as number) : 0);
        const str = (key: string) => (typeof e[key] === "string" ? (e[key] as string) : undefined);
        const kind = str("kind") ?? "";
        const track = out ? sources.get(String(e.mediaSourceId)) : undefined;
        entries.push({
          id: String(e.id),
          dir: out ? "out" : "in",
          kind,
          source:
            out && kind === "audio" && track !== undefined
              ? fromScreen(track)
                ? "screen"
                : "mic"
              : undefined,
          rid: str("rid"),
          bytes: num(out ? "bytesSent" : "bytesReceived"),
          frames: num(out ? "framesEncoded" : "framesDecoded"),
          codecSecs: num(out ? "totalEncodeTime" : "totalDecodeTime"),
          packets: num(out ? "packetsSent" : "packetsReceived"),
          packetsLost: num("packetsLost"),
          freezes: num("freezeCount"),
          freezeSecs: num("totalFreezesDuration"),
          framesDropped: num("framesDropped"),
          jitterSecs: out ? undefined : num("jitter"),
          width: kind === "video" ? num("frameWidth") : undefined,
          height: kind === "video" ? num("frameHeight") : undefined,
          impl: str(out ? "encoderImplementation" : "decoderImplementation"),
          limitedBy: str("qualityLimitationReason"),
        });
      });
    }
    return entries;
  });
}

export interface PageSnapshot {
  readonly atMs: number;
  readonly rtp: readonly RtpEntry[];
  readonly taskSecs: number;
  readonly heapBytes: number;
}

export async function snapshot(page: Page, cdp: CDPSession): Promise<PageSnapshot> {
  const rtp = await readRtp(page);
  const { metrics } = await cdp.send("Performance.getMetrics");
  const metric = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
  return {
    atMs: Date.now(),
    rtp,
    taskSecs: metric("TaskDuration"),
    heapBytes: metric("JSHeapUsedSize"),
  };
}

export interface StreamRate {
  readonly dir: "out" | "in";
  readonly kind: string;
  readonly source?: string;
  readonly rid?: string;
  readonly size?: string;
  readonly impl?: string;
  readonly limitedBy?: string;
  readonly kbps: number;
  readonly fps?: number;
  readonly codecMsPerSec: number;
  readonly codecMsPerFrame?: number;
  readonly lossPct?: number;
  readonly jitterMs?: number;
  readonly freezes?: number;
  readonly freezeSecs?: number;
  readonly framesDropped?: number;
}

export interface WindowRates {
  /** Set when a counter reset inside the window; its rates are then not reported. */
  readonly reset: boolean;
  readonly reasons: readonly string[];
  readonly secs: number;
  readonly mainThreadPct: number;
  readonly heapMB: number;
  readonly streams: readonly StreamRate[];
}

const fixed = (n: number, digits = 1) => Number(n.toFixed(digits));

/**
 * Rates between two snapshots of one page. `micIn` holds the ids of inbound
 * audio that existed before any share started, so later inbound audio is
 * labelled screen audio (the browser cannot tell remote sources apart).
 */
export function windowRates(
  before: PageSnapshot,
  after: PageSnapshot,
  micIn?: ReadonlySet<string>,
): WindowRates {
  const secs = (after.atMs - before.atMs) / 1000;
  const { reset, reasons, deltas } = counterDeltas(before.rtp, after.rtp, RTP_COUNTERS);
  const streams = deltas.flatMap(({ entry: e, delta: d }) => {
    if (d.bytes! <= 0 && d.frames! <= 0) return [];
    const video = e.kind === "video";
    const inbound = e.dir === "in";
    const source =
      e.source ??
      (inbound && e.kind === "audio" && micIn ? (micIn.has(e.id) ? "mic" : "screen") : undefined);
    const rate: StreamRate = {
      dir: e.dir,
      kind: e.kind,
      source,
      rid: e.rid,
      size: video ? `${e.width}x${e.height}` : undefined,
      impl: e.impl,
      limitedBy: e.limitedBy,
      kbps: Math.round((d.bytes! * 8) / secs / 1000),
      fps: video ? fixed(d.frames! / secs) : undefined,
      codecMsPerSec: fixed((d.codecSecs! * 1000) / secs),
      codecMsPerFrame:
        video && d.frames! > 0 ? fixed((d.codecSecs! * 1000) / d.frames!, 2) : undefined,
      lossPct:
        inbound && d.packets! + d.packetsLost! > 0
          ? fixed((d.packetsLost! / (d.packets! + d.packetsLost!)) * 100, 2)
          : undefined,
      jitterMs: inbound && e.jitterSecs !== undefined ? fixed(e.jitterSecs * 1000) : undefined,
      freezes: inbound && video ? d.freezes : undefined,
      freezeSecs: inbound && video ? fixed(d.freezeSecs!, 2) : undefined,
      framesDropped: inbound && video ? d.framesDropped : undefined,
    };
    return [rate];
  });
  return {
    reset,
    reasons,
    secs: fixed(secs),
    mainThreadPct: fixed(((after.taskSecs - before.taskSecs) / secs) * 100, 2),
    heapMB: fixed(after.heapBytes / 1e6),
    streams,
  };
}

/** Inbound audio ids now, for windowRates' mic/screen split. */
export async function inboundAudioIds(page: Page): Promise<Set<string>> {
  const rtp = await readRtp(page);
  return new Set(rtp.filter((e) => e.dir === "in" && e.kind === "audio").map((e) => e.id));
}

/** A 1 Hz sampler of one page's inbound video frame counter, for the slowest second. */
export function frameSampler(page: Page): Sampler<{ atMs: number; frames: number }> {
  return createSampler({
    read: async () => {
      const rtp = await readRtp(page);
      const frames = rtp
        .filter((e) => e.dir === "in" && e.kind === "video")
        .reduce((sum, e) => sum + e.frames, 0);
      return { atMs: Date.now(), frames };
    },
  });
}

/** The lowest frames-per-second over consecutive samples; null with fewer than two. */
export function slowestSecondFps(
  samples: readonly { atMs: number; frames: number }[],
): number | null {
  let lowest: number | null = null;
  for (let i = 1; i < samples.length; i++) {
    const secs = (samples[i]!.atMs - samples[i - 1]!.atMs) / 1000;
    const frames = samples[i]!.frames - samples[i - 1]!.frames;
    // A counter that went back is a replaced receiver, not a slow second.
    if (secs <= 0 || frames < 0) continue;
    const fps = frames / secs;
    lowest = lowest === null ? fps : Math.min(lowest, fps);
  }
  return lowest === null ? null : fixed(lowest);
}

export interface WatchTiming {
  readonly decodedMs: number | null;
  readonly decodedAtSizeMs: number | null;
  readonly presentedMs: number | null;
  readonly presentedAtSizeMs: number | null;
  readonly width: number;
}

const SHARE_VIDEO = "[data-testid='video-grid'] .video-cell[data-stream-type='screenshare'] video";

type Decoded = Map<string, { frames: number; width: number }>;
type WatchWindow = typeof window & {
  __ocWatch?: { clickAt: Promise<number>; base: Map<string, number>; decoded(): Promise<Decoded> };
};

/**
 * Arms an in-page clock that starts at the next click anywhere on the page
 * and stops at the first decoded frame, the first decoded frame at least
 * `targetWidth` wide, and the same two for presented frames
 * (requestVideoFrameCallback). Click, then await `done`.
 */
export async function armWatchTiming(
  page: Page,
  targetWidth: number,
  timeoutMs = 20_000,
): Promise<{ done: Promise<WatchTiming> }> {
  await page.evaluate(async () => {
    // Decoded frame count and width per inbound video stream.
    const decoded = async (): Promise<Decoded> => {
      const frames: Decoded = new Map();
      const reports = await Promise.all(
        window.__ocMedia.peers
          .filter((p) => p.connectionState !== "closed")
          .map((p) => p.getStats()),
      );
      for (const report of reports)
        report.forEach((e: Record<string, unknown>) => {
          if (e.type === "inbound-rtp" && e.kind === "video")
            frames.set(String(e.id), {
              frames: Number(e.framesDecoded ?? 0),
              width: Number(e.frameWidth ?? 0),
            });
        });
      return frames;
    };
    const base = new Map([...(await decoded())].map(([id, s]) => [id, s.frames]));
    (window as WatchWindow).__ocWatch = {
      base,
      decoded,
      clickAt: new Promise((resolve) =>
        document.addEventListener("click", () => resolve(performance.now()), {
          capture: true,
          once: true,
        }),
      ),
    };
  });
  const done = page.evaluate(
    async ([selector, target, timeout]) => {
      const armed = (window as WatchWindow).__ocWatch!;
      const clickAt = await armed.clickAt;
      const since = (t: number | null) => (t === null ? null : Math.round(t - clickAt));
      let decodedAt: number | null = null;
      let decodedAtSize: number | null = null;
      let presentedAt: number | null = null;
      let presentedAtSize: number | null = null;
      let width = 0;
      let video: HTMLVideoElement | null = null;
      const onFrame: VideoFrameRequestCallback = (now, meta) => {
        presentedAt ??= now;
        if (meta.width >= target) presentedAtSize ??= now;
        else video?.requestVideoFrameCallback(onFrame);
      };
      while (performance.now() - clickAt < timeout) {
        if (!video?.isConnected) {
          video = document.querySelector<HTMLVideoElement>(selector);
          video?.requestVideoFrameCallback(onFrame);
        }
        for (const [id, now] of await armed.decoded()) {
          if (now.frames <= (armed.base.get(id) ?? 0)) continue;
          decodedAt ??= performance.now();
          width = Math.max(width, now.width);
          if (now.width >= target) decodedAtSize ??= performance.now();
        }
        if (decodedAtSize !== null && presentedAtSize !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return {
        decodedMs: since(decodedAt),
        decodedAtSizeMs: since(decodedAtSize),
        presentedMs: since(presentedAt),
        presentedAtSizeMs: since(presentedAtSize),
        width,
      };
    },
    [SHARE_VIDEO, targetWidth, timeoutMs] as const,
  );
  return { done };
}

/** What is still alive on a page after it left the call. */
export async function leftovers(page: Page) {
  return page.evaluate(async () => {
    const probe = window.__ocMedia;
    const read = await probe.read();
    return {
      openPeers: probe.peers.filter((p) => p.connectionState !== "closed").length,
      openSignaling: probe.signaling.filter((s) => s.readyState !== WebSocket.CLOSED).length,
      liveCapture: read.liveCapture,
    };
  });
}

/**
 * A stream's quality readout: the chip on a watched tile ("1080p · 30 fps")
 * and its stats popover (resolution, frame rate, bitrate, codec, packet
 * loss), from two receiver samples taken a poll apart.
 */

import { createElement, appendChildren } from "@lib/dom";
import { voiceText as t } from "../../i18n/voice";
import type { StreamSample } from "../../features/voice/remoteTracks";
import type { ShareSenderSample } from "../../features/voice/shareSenderStats";

export type { StreamSample };

export interface StreamInfo {
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly bitrate?: number;
  readonly codec?: string;
  /** percent */
  readonly loss?: number;
}

/** Derive what the chip and popover show; fps needs the previous sample. */
export function streamInfo(sample: StreamSample, prev?: StreamSample): StreamInfo {
  const dt = prev === undefined ? 0 : (sample.timestamp - prev.timestamp) / 1000;
  const frames =
    prev?.framesDecoded !== undefined && sample.framesDecoded !== undefined
      ? sample.framesDecoded - prev.framesDecoded
      : undefined;
  const lost = sample.packetsLost ?? 0;
  const total = lost + (sample.packetsReceived ?? 0);
  return {
    width: sample.frameWidth,
    height: sample.frameHeight,
    fps: dt > 0 && frames !== undefined && frames >= 0 ? Math.round(frames / dt) : undefined,
    bitrate: sample.bitrate,
    codec: sample.codec?.split("/").pop()?.toUpperCase(),
    loss: total > 0 ? (lost / total) * 100 : undefined,
  };
}

function limitationText(reason: string | undefined): string | undefined {
  switch (reason) {
    case undefined:
      return undefined;
    case "none":
      return t("tile.senderNotLimited");
    case "cpu":
      return t("tile.senderLimitedCpu");
    case "bandwidth":
      return t("tile.senderLimitedBandwidth");
    default:
      return t("tile.senderLimitedOther");
  }
}

/** Your own share's second line (M-1): the capture rate (measured, or "set
 *  to" where the browser only reports what the capture was opened at), what holds the
 *  encoder back, and which codec and encoder, e.g. "Capture 120 fps · Limited
 *  by CPU · VP8 · libvpx". Empty before anything is known; a note where the
 *  share has no sender stats to read (null: no sample yet). */
export function senderText(sample: ShareSenderSample | null): string {
  if (sample === null) return t("tile.senderUnavailable");
  const parts = [
    sample.captureFps === undefined
      ? undefined
      : sample.captureFpsSource === "configured"
        ? t("tile.senderCaptureSet", { fps: String(sample.captureFps) })
        : t("tile.senderCapture", { fps: String(sample.captureFps) }),
    limitationText(sample.limitation),
    sample.codec?.split("/").pop()?.toUpperCase(),
    sample.encoder,
  ];
  return parts.filter((p): p is string => p !== undefined && p !== "").join(" · ");
}

/** One line per encoder layer when the share sends more than one, widest
 *  first, e.g. "1080p · 24 fps" over "720p · 30 fps"; a layer nobody watches
 *  says "paused". Empty for a single layer: the second line already says it. */
export function layersText(sample: ShareSenderSample | null): string {
  const layers = sample?.layers ?? [];
  if (layers.length < 2) return "";
  return layers
    .filter((l) => l.height !== undefined)
    .map((l) => {
      // Plain strings: the catalog would group 1080 as "1,080".
      const height = String(l.height);
      if (!l.active) return t("tile.senderLayerPaused", { height });
      return l.sentFps === undefined
        ? t("tile.qualityHeight", { height })
        : t("tile.shareQuality", { height, fps: String(l.sentFps) });
    })
    .join("\n");
}

/** The chip's text and spoken name, or null when there is nothing to say. */
export function chipText(info: StreamInfo): { text: string; label: string } | null {
  if (info.height === undefined || info.height <= 0) return null;
  if (info.fps === undefined) {
    const text = t("tile.qualityHeight", { height: String(info.height) });
    return { text, label: t("tile.statsLabel", { summary: text }) };
  }
  return {
    text: t("tile.shareQuality", { height: String(info.height), fps: String(info.fps) }),
    label: t("tile.statsLabel", {
      summary: t("tile.qualitySpoken", { height: String(info.height), fps: String(info.fps) }),
    }),
  };
}

function bitrateText(bps: number): string {
  return bps >= 1_000_000
    ? t("tile.mbps", { value: (bps / 1_000_000).toFixed(1) })
    : t("tile.kbps", { value: String(Math.round(bps / 1000)) });
}

/** Fill (or refill) the popover's rows. */
export function renderStats(pop: HTMLElement, name: string, info: StreamInfo): void {
  const rows: Array<[string, string | undefined]> = [
    [
      t("tile.statsResolution"),
      info.width !== undefined && info.height !== undefined
        ? t("tile.resolutionValue", { width: String(info.width), height: String(info.height) })
        : undefined,
    ],
    [
      t("tile.statsFps"),
      info.fps !== undefined ? t("tile.fpsValue", { fps: String(info.fps) }) : undefined,
    ],
    [t("tile.statsBitrate"), info.bitrate !== undefined ? bitrateText(info.bitrate) : undefined],
    [t("tile.statsCodec"), info.codec],
    [
      t("tile.statsLoss"),
      info.loss !== undefined ? t("tile.lossValue", { value: info.loss.toFixed(1) }) : undefined,
    ],
  ];
  const dl = createElement("dl");
  for (const [term, value] of rows) {
    if (value === undefined) continue;
    appendChildren(dl, createElement("dt", {}, term), createElement("dd", {}, value));
  }
  pop.replaceChildren(createElement("h4", {}, name), dl);
}

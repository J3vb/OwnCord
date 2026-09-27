/**
 * A stream's quality readout: the chip on a watched tile ("1080p · 30 fps")
 * and its stats popover (resolution, frame rate, bitrate, codec, packet
 * loss), from two receiver samples taken a poll apart.
 */

import { createElement, appendChildren } from "@lib/dom";
import { voiceText as t } from "../../i18n/voice";
import type { StreamSample } from "../../features/voice/remoteTracks";

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

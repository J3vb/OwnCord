/**
 * Small tile pieces of the video grid, split from gridStreams.ts: relabelling,
 * the picture swap check and the tile's static elements.
 */
import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { voiceText } from "../../../i18n/voice";
import { log, type CellEntry } from "./gridShared";
import type { TileConfig } from "./VideoGrid";

export function setTrackMuted(entry: CellEntry, muted: boolean): void {
  entry.el.classList.toggle("track-muted", muted);
  entry.video.classList.toggle("track-muted", muted);
}

export function applyNames(entry: CellEntry, username: string, name: string): void {
  entry.name = name;
  const label = entry.el.querySelector(".video-username");
  if (label !== null) label.textContent = username;
  entry.el
    .querySelector(".video-cell-select")
    ?.setAttribute("aria-label", voiceText("tile.watch", { name: username }));
  entry.el
    .querySelector(".tile-volume-slider")
    ?.setAttribute(
      "aria-label",
      entry.config?.isScreenshare === true
        ? voiceText("tile.streamVolume", { name })
        : voiceText("tile.voiceVolume", { name }),
    );
}

/** Only replace srcObject if the underlying tracks changed. */
export function sameTracks(video: HTMLVideoElement, stream: MediaStream): boolean {
  const oldTracks = (video.srcObject as MediaStream | null)?.getTracks() ?? [];
  const newTracks = stream.getTracks();
  return (
    video.srcObject != null &&
    oldTracks.length === newTracks.length &&
    oldTracks.every((t, i) => t.id === newTracks[i]?.id)
  );
}

export function buildTileVideo(userId: number, stream: MediaStream | null): HTMLVideoElement {
  const video = createElement("video", {
    autoplay: "",
    playsinline: "",
  });
  video.muted = true;
  if (stream !== null) {
    video.srcObject = stream;
    video.play()?.catch((err) => {
      log.debug("Video autoplay rejected (new tile)", { userId, err });
    });
  }
  return video;
}

/** Who is watching this screen share: an eye and the count, top-right,
 *  hidden at zero (applyStreamViewers draws it). */
export function buildViewersBadge(): HTMLElement {
  const viewers = createElement("span", {
    class: "video-viewers",
    role: "img",
    "data-testid": "tile-viewers",
  });
  viewers.hidden = true;
  viewers.appendChild(createIcon("eye", 14));
  viewers.appendChild(createElement("span", { class: "video-viewers__count" }));
  return viewers;
}

export function buildTileLabel(config: TileConfig | undefined): HTMLElement {
  const label = createElement("div", { class: "video-label" });
  label.appendChild(createElement("div", { class: "video-username" }));
  if (config?.isScreenshare === true) {
    label.appendChild(createElement("span", { class: "video-live" }, voiceText("tile.live")));
  }
  return label;
}

/**
 * The voice widget's stream card while you share your screen: what
 * is going out, Change source, Quality and Stop. Loaded on the first share.
 * Change source is offered wherever the share can change without stopping;
 * Quality only on the web path (the Linux native capture picks its quality in
 * its own dialog).
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import {
  canChangeScreenshareSource,
  changeScreenshareSource,
  getLocalScreenshareStream,
  getScreenshareQuality,
  setScreenshareQuality,
  type StreamQuality,
} from "@lib/voice/livekitSession";
import { voiceText as t } from "../../i18n/voice";

const QUALITIES: readonly StreamQuality[] = ["low", "medium", "high", "source"];

/** Chromium labels a capture by its id ("screen:0:0", "window:42:0", a tab's
 *  web-contents URL); only a label that is not one names the source. */
const ID_LABEL = /^(screen|window|web-contents-media-stream):/;

/** What is going out: the kind of source, and its name when the capture
 *  carries one. */
export function shareSourceName(track: MediaStreamTrack | undefined): string {
  const surface = track?.getSettings?.()?.displaySurface;
  const kind =
    surface === "window"
      ? t("tile.sharingWindow")
      : surface === "browser"
        ? t("tile.sharingTab")
        : t("tile.sharingScreen");
  const label = track?.label ?? "";
  return label === "" || ID_LABEL.test(label) ? kind : t("card.sourceNamed", { kind, name: label });
}

export interface StreamCard {
  readonly el: HTMLElement;
  /** Redraw from the live share (its source or quality changed). */
  update(): void;
}

export function createStreamCard(onStop: () => void, signal: AbortSignal): StreamCard {
  const el = createElement("div", {
    class: "vw-stream-card",
    role: "group",
    "aria-label": t("card.label"),
    "data-testid": "vw-stream-card",
  });
  const name = createElement("div", { class: "vw-stream-name" });
  const actions = createElement("div", {});
  const change = createElement(
    "button",
    { type: "button", "data-testid": "vw-stream-change" },
    t("card.changeSource"),
  );
  const quality = createElement("select", {
    "aria-label": t("picker.quality"),
    "data-testid": "vw-stream-quality",
  });
  for (const q of QUALITIES) {
    // i18n-exempt: catalog key assembled from the StreamQuality value
    quality.appendChild(createElement("option", { value: q }, t(`picker.quality.${q}`)));
  }
  const stop = createElement(
    "button",
    { type: "button", class: "vw-stream-stop", "data-testid": "vw-stream-stop" },
    t("widget.control.shareStop"),
  );
  appendChildren(actions, change, quality, stop);
  appendChildren(el, name, actions);

  function update(): void {
    setText(name, shareSourceName(getLocalScreenshareStream()?.getVideoTracks()[0]));
    const current = getScreenshareQuality();
    change.hidden = !canChangeScreenshareSource();
    quality.hidden = current === null;
    if (current !== null) quality.value = current;
  }

  change.addEventListener(
    "click",
    () => {
      change.disabled = true;
      void changeScreenshareSource().finally(() => {
        change.disabled = false;
      });
    },
    { signal },
  );
  quality.addEventListener(
    "change",
    () => {
      quality.disabled = true;
      void setScreenshareQuality(quality.value as StreamQuality).finally(() => {
        quality.disabled = false;
        // A refused change puts the live quality back.
        update();
      });
    },
    { signal },
  );
  stop.addEventListener("click", onStop, { signal });

  update();
  return { el, update };
}

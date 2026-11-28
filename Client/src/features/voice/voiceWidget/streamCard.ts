/**
 * The voice widget's share card while you share your screen: a LIVE header
 * with what is going out, a live preview of it, its resolution, frame rate
 * and audio, the Quality segments, then Change source and Stop sharing.
 * Loaded on the first share. Change source is offered wherever the share can
 * change without stopping; Quality wherever the share reports one (the Linux
 * native capture picks its quality in its own dialog). The preview shows only
 * where the share has a picture in this page (not on the Linux native path).
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { hasVideoSurface } from "@lib/voice/videoSurface";
import {
  canChangeScreenshareSource,
  changeScreenshareSource,
  getLocalScreenshareStream,
  getScreenshareQuality,
  hasLocalScreenshareAudio,
  setScreenshareQuality,
  type StreamQuality,
} from "../livekitSession";
import { voiceText as t } from "../../../i18n/voice";
import { createQualitySegment } from "./qualitySegment";
import { shareFormat, shareSource } from "./shareSource";

export interface StreamCard {
  readonly el: HTMLElement;
  /** Redraw from the live share (its source or quality changed). */
  update(): void;
  /** Whether the card is on screen: a closed popover plays no preview. */
  setShown(shown: boolean): void;
}

/** The muted live picture of the share, with "What others see" and a
 *  Hide preview / Show preview toggle on it. Hiding it only stops this
 *  picture; the share goes on. */
function createPreview(signal: AbortSignal): {
  el: HTMLDivElement;
  show(stream: MediaStream | null): void;
  setShown(shown: boolean): void;
} {
  const el = createElement("div", { class: "vw-share-preview" });
  const video = createElement("video", { class: "vw-share-preview-video", "aria-hidden": "true" });
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  const toggle = createElement("button", {
    type: "button",
    class: "vw-share-preview-toggle",
    "data-testid": "vw-stream-preview-toggle",
    "aria-pressed": "false",
  });
  appendChildren(
    el,
    video,
    createElement("span", { class: "vw-share-preview-tag" }, t("card.whatOthersSee")),
    toggle,
  );
  let hidden = false;
  /** The card is on screen (inline, or its popover open). */
  let onScreen = true;
  /** The track the picture plays, so a redraw of the same share does not
   *  restart it (the session hands out a new stream object each time). */
  let shownTrackId: string | null = null;

  function show(stream: MediaStream | null): void {
    // A picture our own renderer draws (the Linux native capture) is held by
    // the stream tile's canvas; a <video> here would stay blank.
    const found = stream?.getVideoTracks()[0];
    const track = found !== undefined && hasVideoSurface(found) ? undefined : found;
    el.hidden = track === undefined;
    el.classList.toggle("vw-share-preview--off", hidden);
    setText(toggle, hidden ? t("card.showPreview") : t("tile.hidePreview"));
    toggle.setAttribute("aria-pressed", String(hidden));
    const next = hidden || !onScreen || track === undefined ? null : track.id;
    if (next === shownTrackId) return;
    shownTrackId = next;
    video.srcObject = next === null ? null : stream;
  }

  toggle.addEventListener(
    "click",
    () => {
      hidden = !hidden;
      show(getLocalScreenshareStream());
    },
    { signal },
  );
  signal.addEventListener("abort", () => (video.srcObject = null), { once: true });
  return {
    el,
    show,
    setShown(shown) {
      onScreen = shown;
      show(getLocalScreenshareStream());
    },
  };
}

function chip(text: string, extra = ""): HTMLSpanElement {
  return createElement("span", { class: `vw-chip ${extra}`.trim() }, text);
}

/** The LIVE badge: a red pill with a dot, shared with your own share's tile. */
export function createLiveBadge(): HTMLSpanElement {
  return createElement("span", { class: "vw-live-badge" }, t("card.live"));
}

export function createStreamCard(onStop: () => void, signal: AbortSignal): StreamCard {
  const el = createElement("div", {
    class: "vw-stream-card",
    role: "group",
    "aria-label": t("card.label"),
    "data-testid": "vw-stream-card",
  });
  const head = createElement("div", { class: "vw-card-head" });
  appendChildren(
    head,
    createLiveBadge(),
    createElement("span", { class: "vw-card-eyebrow" }, t("card.eyebrow")),
  );
  const title = createElement("div", { class: "vw-card-title vw-stream-name" });
  const sub = createElement("div", { class: "vw-card-sub" });
  const preview = createPreview(signal);
  const chips = createElement("div", { class: "vw-chips", "data-testid": "vw-stream-chips" });
  const qualityLabel = createElement("div", { class: "vw-card-eyebrow" }, t("card.quality"));
  const quality = createQualitySegment(pickQuality, signal);

  const change = createElement("button", {
    type: "button",
    class: "vw-card-btn",
    "data-testid": "vw-stream-change",
  });
  appendChildren(change, createIcon("monitor", 15), t("card.changeSource"));
  const stop = createElement("button", {
    type: "button",
    class: "vw-card-btn vw-stream-stop",
    "data-testid": "vw-stream-stop",
  });
  appendChildren(stop, createIcon("square", 13), t("card.stopSharing"));
  const actions = createElement("div", { class: "vw-card-actions" });
  appendChildren(actions, change, stop);
  appendChildren(el, head, title, sub, preview.el, chips, qualityLabel, quality.el, actions);

  function renderChips(track: MediaStreamTrack | undefined): void {
    const { height, fps } = shareFormat(track);
    const audio = hasLocalScreenshareAudio();
    const items = [height, fps].filter((x): x is string => x !== null).map((x) => chip(x));
    items.push(
      chip(audio ? t("card.audioOn") : t("card.audioOff"), audio ? "vw-chip--on" : "vw-chip--off"),
    );
    chips.replaceChildren(...items);
  }

  function update(): void {
    const stream = getLocalScreenshareStream();
    const track = stream?.getVideoTracks()[0];
    const source = shareSource(track);
    setText(title, source.kind);
    setText(sub, source.name ?? "");
    sub.hidden = source.name === null;
    preview.show(stream);
    renderChips(track);
    const current = getScreenshareQuality();
    change.hidden = !canChangeScreenshareSource();
    quality.set(current);
    qualityLabel.hidden = current === null;
  }

  function pickQuality(q: StreamQuality): void {
    quality.setBusy(true);
    void setScreenshareQuality(q).finally(() => {
      quality.setBusy(false);
      // A refused change puts the live quality back.
      update();
    });
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
  stop.addEventListener("click", onStop, { signal });

  update();
  return { el, update, setShown: preview.setShown };
}

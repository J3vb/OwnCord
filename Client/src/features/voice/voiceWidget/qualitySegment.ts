/**
 * The share card's Quality control: four segments (Low, Medium, High,
 * Source) with a small resolution under each, as one radio group. Arrow keys
 * move the choice like any radio group, and the focus stays on the group
 * while a change is applied (the segments are marked busy, not disabled, so
 * they keep the focus).
 */
import { createElement, appendChildren } from "@lib/dom";
import type { StreamQuality } from "@lib/voice/videoPresets";
import { voiceText as t } from "../../../i18n/voice";

const QUALITIES: readonly StreamQuality[] = ["low", "medium", "high", "source"];

export interface QualitySegment {
  readonly el: HTMLDivElement;
  /** Show the live quality; null hides the control (the share has none). */
  set(quality: StreamQuality | null): void;
  /** While a change is applied, further picks are ignored. */
  setBusy(busy: boolean): void;
}

/** Arrow keys step through the segments, wrapping at the ends. */
function stepFor(key: string): number {
  if (key === "ArrowRight" || key === "ArrowDown") return 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return -1;
  return 0;
}

export function createQualitySegment(
  onPick: (quality: StreamQuality) => void,
  signal: AbortSignal,
): QualitySegment {
  const el = createElement("div", {
    class: "vw-quality",
    role: "radiogroup",
    "aria-label": t("picker.quality"),
    "data-testid": "vw-stream-quality",
  });
  let current: StreamQuality | null = null;
  let busy = false;

  const segments = QUALITIES.map((q) => {
    const seg = createElement("button", {
      type: "button",
      role: "radio",
      class: "vw-quality-seg",
      "aria-checked": "false",
      tabindex: "-1",
      "data-quality": q,
    });
    appendChildren(
      seg,
      // i18n-exempt: catalog keys assembled from the StreamQuality value
      createElement("span", { class: "vw-quality-name" }, t(`card.quality.${q}`)),
      createElement("span", { class: "vw-quality-res" }, t(`card.quality.${q}.res`)),
    );
    return seg;
  });
  appendChildren(el, ...segments);

  function pick(q: StreamQuality): void {
    if (busy || q === current) return;
    set(q);
    onPick(q);
  }

  function set(quality: StreamQuality | null): void {
    current = quality;
    el.hidden = quality === null;
    segments.forEach((seg, i) => {
      const on = QUALITIES[i] === quality;
      seg.setAttribute("aria-checked", String(on));
      seg.tabIndex = on ? 0 : -1;
    });
  }

  function setBusy(next: boolean): void {
    busy = next;
    el.setAttribute("aria-busy", String(next));
    for (const seg of segments) seg.setAttribute("aria-disabled", String(next));
  }

  el.addEventListener(
    "click",
    (e) => {
      const seg = (e.target as Element).closest<HTMLElement>("[data-quality]");
      if (seg !== null) pick(seg.dataset["quality"] as StreamQuality);
    },
    { signal },
  );
  el.addEventListener(
    "keydown",
    (e) => {
      const step = stepFor(e.key);
      if (step === 0) return;
      e.preventDefault();
      if (busy) return;
      const from = current === null ? 0 : QUALITIES.indexOf(current);
      const index = (from + step + QUALITIES.length) % QUALITIES.length;
      segments[index]?.focus();
      pick(QUALITIES[index]!);
    },
    { signal },
  );

  set(null);
  return { el, set, setBusy };
}

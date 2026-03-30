/**
 * Text & Images settings tab — link previews, embeds, inline media, GIF/emoji animation, spoilers.
 */

import { createElement, appendChildren } from "@lib/dom";
import { loadPref, savePref, createToggle } from "./helpers";

export function buildTextImagesTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });

  const toggles: ReadonlyArray<{ key: string; label: string; desc: string; fallback: boolean }> = [
    {
      key: "showLinkPreviews",
      label: "Link Preview",
      desc: "Show website previews for links shared in chat",
      fallback: true,
    },
    {
      key: "showEmbeds",
      label: "Show Embeds",
      desc: "Display rich embeds in chat messages",
      fallback: true,
    },
    {
      key: "inlineMedia",
      label: "Inline Attachment Preview",
      desc: "Automatically display images, videos, and GIFs inline",
      fallback: true,
    },
    {
      key: "animateGifs",
      label: "Animate GIFs",
      desc: "Play GIF animations automatically. When disabled, GIFs show as static images",
      fallback: true,
    },
  ];

  for (const item of toggles) {
    const row = createElement("div", { class: "setting-row" });
    const info = createElement("div", {});
    const label = createElement("div", { class: "setting-label" }, item.label);
    const desc = createElement("div", { class: "setting-desc" }, item.desc);
    appendChildren(info, label, desc);
    const isOn = loadPref<boolean>(item.key, item.fallback);
    const toggle = createToggle(isOn, {
      signal,
      onChange: (nowOn) => { savePref(item.key, nowOn); },
    });
    appendChildren(row, info, toggle);
    section.appendChild(row);
  }

  return section;
}

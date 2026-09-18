/**
 * Text & Images settings tab — link previews, embeds, inline media, GIF/emoji animation, spoilers.
 */

import { createElement } from "@lib/dom";
import { appendToggleRows } from "./helpers";

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

  appendToggleRows(section, toggles, signal);

  return section;
}

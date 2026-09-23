/**
 * Text & Images settings tab — link previews, embeds, inline media, GIF/emoji animation, spoilers.
 */

import { appendChildren, createElement, setText } from "@lib/dom";
import { resetExternalConsent } from "../../features/content-consent/external";
import { externalConsentText as t } from "../../i18n/externalConsent";
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
  section.appendChild(buildConsentResetRow(signal));

  return section;
}

/** B9-8 (Q3): forget every server's external-content choice. Turning off one
 *  of the toggles above does the same. */
function buildConsentResetRow(signal: AbortSignal): HTMLDivElement {
  const row = createElement("div", { class: "setting-row" });
  const info = createElement("div", {});
  const status = createElement("div", { class: "setting-desc", role: "status" });
  appendChildren(
    info,
    createElement("div", { class: "setting-label" }, t("reset.label")),
    createElement("div", { class: "setting-desc" }, t("reset.desc")),
    status,
  );
  const btn = createElement(
    "button",
    { class: "ac-btn", type: "button", "aria-label": t("reset.label") },
    t("reset.button"),
  );
  btn.addEventListener(
    "click",
    () => {
      resetExternalConsent();
      setText(status, t("reset.done"));
    },
    { signal },
  );
  appendChildren(row, info, btn);
  return row;
}

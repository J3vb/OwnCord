/**
 * Text & Images settings tab — link previews, embeds, inline media, GIF/emoji animation, spoilers.
 */

import { appendChildren, createElement, setText } from "@lib/dom";
import { resetExternalConsent } from "../../features/content-consent/external";
import { externalConsentText } from "../../i18n/externalConsent";
import { appendToggleRows } from "./helpers";
import { settingsText as t } from "../../i18n/settings";

export function buildTextImagesTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });

  const toggles: ReadonlyArray<{ key: string; label: string; desc: string; fallback: boolean }> = [
    {
      key: "showLinkPreviews",
      label: t("images.linkPreview.label"),
      desc: t("images.linkPreview.desc"),
      fallback: true,
    },
    {
      key: "showEmbeds",
      label: t("images.embeds.label"),
      desc: t("images.embeds.desc"),
      fallback: true,
    },
    {
      key: "inlineMedia",
      label: t("images.inline.label"),
      desc: t("images.inline.desc"),
      fallback: true,
    },
    {
      key: "animateGifs",
      label: t("images.animateGifs.label"),
      desc: t("images.animateGifs.desc"),
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
    createElement("div", { class: "setting-label" }, externalConsentText("reset.label")),
    createElement("div", { class: "setting-desc" }, externalConsentText("reset.desc")),
    status,
  );
  const btn = createElement(
    "button",
    { class: "ac-btn", type: "button", "aria-label": externalConsentText("reset.label") },
    externalConsentText("reset.button"),
  );
  btn.addEventListener(
    "click",
    () => {
      resetExternalConsent();
      setText(status, externalConsentText("reset.done"));
    },
    { signal },
  );
  appendChildren(row, info, btn);
  return row;
}

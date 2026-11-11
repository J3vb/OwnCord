/**
 * The Audio option widgets of the screen share picker: the unavailable note
 * and the Share audio switch. Split from `ScreenSharePicker.ts`.
 */

import { createElement } from "@lib/dom";
import { voiceText as t } from "../../i18n/voice";

/** Without a sound server to capture from, the Audio option is a note. */
export function buildAudioNote(): HTMLElement {
  const wrap = createElement("div", { class: "ssp-opt" });
  wrap.appendChild(createElement("div", { class: "ssp-opt-label" }, t("picker.audio")));
  wrap.appendChild(createElement("div", { class: "ssp-opt-text" }, t("picker.audioUnavailable")));
  return wrap;
}

/** The Share audio switch (on by default, as the Windows picker's); `onChange`
 *  hears every flip. */
export function buildAudioSwitch(
  onChange: (on: boolean) => void,
  copy: { label: string; hint: string } = {
    label: t("picker.shareAudio"),
    hint: t("picker.shareAudioHint"),
  },
): HTMLElement {
  const wrap = createElement("div", { class: "ssp-opt" });
  const row = createElement("div", { class: "ssp-opt-row" });
  row.appendChild(
    createElement("div", { class: "ssp-opt-label", id: "ssp-audio-label" }, copy.label),
  );
  const toggle = createElement("div", {
    class: "toggle on",
    role: "switch",
    tabindex: "0",
    "aria-checked": "true",
    "aria-labelledby": "ssp-audio-label",
    "aria-describedby": "ssp-audio-hint",
    "data-testid": "ssp-share-audio",
  });
  const flip = (): void => {
    const on = !toggle.classList.contains("on");
    toggle.classList.toggle("on", on);
    toggle.setAttribute("aria-checked", String(on));
    onChange(on);
  };
  toggle.addEventListener("click", flip);
  toggle.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    flip();
  });
  row.appendChild(toggle);
  wrap.appendChild(row);
  wrap.appendChild(createElement("div", { class: "ssp-hint", id: "ssp-audio-hint" }, copy.hint));
  return wrap;
}

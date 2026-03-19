/**
 * Keybinds settings tab — push-to-talk and quick switcher bindings.
 */

import { createElement, appendChildren } from "@lib/dom";
import { loadPref } from "./helpers";

export function buildKeybindsTab(): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });
  const header = createElement("h1", {}, "Keybinds");
  section.appendChild(header);

  const pttRow = createElement("div", { class: "keybind-row" });
  const pttLabel = createElement("span", { class: "setting-label" }, "Push to Talk");
  const pttValue = createElement("span", { class: "kbd" }, loadPref<string>("pttKey", "Not set"));
  appendChildren(pttRow, pttLabel, pttValue);
  section.appendChild(pttRow);

  const searchRow = createElement("div", { class: "keybind-row" });
  const searchLabel = createElement("span", { class: "setting-label" }, "Quick Switcher");
  const searchValue = createElement("span", { class: "kbd" }, "Ctrl + K");
  appendChildren(searchRow, searchLabel, searchValue);
  section.appendChild(searchRow);

  return section;
}

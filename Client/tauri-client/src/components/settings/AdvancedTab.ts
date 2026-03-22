/**
 * Advanced settings tab — developer mode, hardware acceleration, and debug tools.
 */

import { createElement, appendChildren } from "@lib/dom";
import { loadPref, savePref, createToggle } from "./helpers";

export function buildAdvancedTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });

  // ---- Toggles ---------------------------------------------------------------

  const toggles: ReadonlyArray<{ key: string; label: string; desc: string; fallback: boolean }> = [
    {
      key: "developerMode",
      label: "Developer Mode",
      desc: "Show message IDs, user IDs, and channel IDs on context menus",
      fallback: false,
    },
    {
      key: "hardwareAcceleration",
      label: "Hardware Acceleration",
      desc: "Use GPU for rendering. Disable if experiencing graphical issues",
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

  // ---- Separator -------------------------------------------------------------

  const sep = createElement("div", { class: "settings-separator" });
  section.appendChild(sep);

  // ---- Debug section ---------------------------------------------------------

  const debugTitle = createElement("div", { class: "settings-section-title" }, "Debug");
  section.appendChild(debugTitle);

  // DevTools button row
  const devtoolsRow = createElement("div", { class: "setting-row" });
  const devtoolsInfo = createElement("div", {});
  const devtoolsLabel = createElement("div", { class: "setting-label" }, "Open DevTools");
  const devtoolsDesc = createElement("div", { class: "setting-desc" }, "Open the browser developer tools for debugging");
  appendChildren(devtoolsInfo, devtoolsLabel, devtoolsDesc);

  const devtoolsBtn = createElement("button", { class: "ac-btn" }, "Open DevTools");
  devtoolsBtn.addEventListener("click", () => {
    void import("@tauri-apps/api/core")
      .then((mod) => mod.invoke("open_devtools"))
      .catch(() => {
        // DevTools not available in this build
      });
  }, { signal });

  appendChildren(devtoolsRow, devtoolsInfo, devtoolsBtn);
  section.appendChild(devtoolsRow);

  return section;
}

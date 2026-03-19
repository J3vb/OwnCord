/**
 * Notifications settings tab — desktop notifications, taskbar flash, sounds.
 */

import { createElement, appendChildren } from "@lib/dom";
import { loadPref, savePref } from "./helpers";

export function buildNotificationsTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });
  const header = createElement("h1", {}, "Notifications");
  section.appendChild(header);

  const toggles: ReadonlyArray<{ key: string; label: string; desc: string; fallback: boolean }> = [
    { key: "desktopNotifications", label: "Desktop Notifications", desc: "Show desktop notifications for messages", fallback: true },
    { key: "flashTaskbar", label: "Flash Taskbar", desc: "Flash taskbar on new messages", fallback: true },
    { key: "suppressEveryone", label: "Suppress @everyone", desc: "Mute @everyone and @here mentions", fallback: false },
    { key: "notificationSounds", label: "Notification Sounds", desc: "Play sounds for notifications", fallback: true },
  ];

  for (const item of toggles) {
    const row = createElement("div", { class: "setting-row" });
    const info = createElement("div", {});
    const label = createElement("div", { class: "setting-label" }, item.label);
    const desc = createElement("div", { class: "setting-desc" }, item.desc);
    appendChildren(info, label, desc);

    const isOn = loadPref<boolean>(item.key, item.fallback);
    const toggle = createElement("div", { class: isOn ? "toggle on" : "toggle" });
    toggle.addEventListener("click", () => {
      const nowOn = !toggle.classList.contains("on");
      toggle.classList.toggle("on", nowOn);
      savePref(item.key, nowOn);
    }, { signal });

    appendChildren(row, info, toggle);
    section.appendChild(row);
  }

  return section;
}

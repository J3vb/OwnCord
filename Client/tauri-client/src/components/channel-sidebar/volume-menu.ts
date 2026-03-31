/**
 * Per-user volume context menu — right-click on a voice user row
 * to adjust their playback volume locally.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { setUserVolume, getUserVolume } from "@lib/livekitSession";

export function showUserVolumeMenu(
  userId: number,
  username: string,
  x: number,
  y: number,
  signal: AbortSignal,
): void {
  // Remove any existing context menus and abort their dismiss controllers
  document.querySelectorAll(".user-vol-menu").forEach((el) => {
    const prev = (el as HTMLElement & { _dismissAc?: AbortController })._dismissAc;
    prev?.abort();
    el.remove();
  });

  const menu = createElement("div", { class: "context-menu user-vol-menu" });

  const header = createElement("div", {
    class: "context-menu-item",
    style: "font-weight:600;cursor:default;pointer-events:none",
  }, username);
  menu.appendChild(header);

  const sep = createElement("div", { class: "context-menu-sep" });
  menu.appendChild(sep);

  const currentVol = getUserVolume(userId);
  const volLabel = createElement("div", {
    class: "context-menu-item",
    style: "font-size:12px;color:var(--text-muted);cursor:default;pointer-events:none",
  }, `User Volume: ${currentVol}%`);
  menu.appendChild(volLabel);

  const sliderRow = createElement("div", {
    style: "padding:4px 10px;display:flex;align-items:center;gap:8px",
  });
  const slider = createElement("input", {
    type: "range",
    class: "settings-slider",
    min: "0",
    max: "200",
    value: String(currentVol),
    style: "flex:1",
  });
  const valLabel = createElement("span", {
    class: "slider-val",
    style: "min-width:40px;text-align:right;font-size:12px;color:var(--text-muted)",
  }, `${currentVol}%`);

  slider.addEventListener("input", () => {
    const val = Number(slider.value);
    setText(valLabel, `${val}%`);
    setText(volLabel, `User Volume: ${val}%`);
    setUserVolume(userId, val);
  });

  appendChildren(sliderRow, slider, valLabel);
  menu.appendChild(sliderRow);

  const resetBtn = createElement("div", { class: "context-menu-item" }, "Reset Volume");
  resetBtn.addEventListener("click", () => {
    setUserVolume(userId, 100);
    slider.value = "100";
    setText(valLabel, "100%");
    setText(volLabel, "User Volume: 100%");
  });
  menu.appendChild(resetBtn);

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Close on click outside — store controller on element for cleanup on re-open
  const dismissAc = new AbortController();
  (menu as HTMLElement & { _dismissAc?: AbortController })._dismissAc = dismissAc;
  setTimeout(() => {
    if (dismissAc.signal.aborted) return;
    document.addEventListener("mousedown", (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        dismissAc.abort();
      }
    }, { signal: dismissAc.signal });
  }, 0);

  // Also clean up if the parent component is destroyed
  signal.addEventListener("abort", () => {
    menu.remove();
    dismissAc.abort();
  });
}

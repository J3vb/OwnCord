/**
 * Keybinds settings tab — push-to-talk key capture and quick switcher display.
 * PTT uses Rust-side GetAsyncKeyState polling so the key is NOT hijacked.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref } from "./helpers";
import { updatePttKey, captureKeyPress, vkName } from "@lib/ptt";

export function buildKeybindsTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });

  // ── Push to Talk ──────────────────────────────────────────
  const pttRow = createElement("div", { class: "keybind-row" });
  const pttLabel = createElement("span", { class: "setting-label" }, "Push to Talk");
  let currentVk = loadPref<number>("pttVk", 0);
  const pttValue = createElement("span", {
    class: "kbd",
    style: "cursor: pointer; min-width: 80px; text-align: center;",
    title: "Click to set keybind",
  }, currentVk !== 0 ? vkName(currentVk) : "Not set");
  const pttClear = createElement("button", {
    class: "ac-btn",
    style: `margin-left: 8px; font-size: 12px; padding: 4px 10px; ${currentVk !== 0 ? "" : "display: none;"}`,
  }, "Clear");

  let capturing = false;

  pttValue.addEventListener("click", () => {
    if (capturing) return;
    capturing = true;
    pttValue.textContent = "Press any key...";
    pttValue.style.borderColor = "var(--accent)";
    pttValue.style.color = "var(--accent)";

    // Use Rust-side key detection (supports mouse buttons, works globally).
    // Returns 0 on timeout (10s) if the user didn't press anything.
    void captureKeyPress().then((vk) => {
      capturing = false;
      pttValue.style.borderColor = "";
      pttValue.style.color = "";
      if (vk === 0) {
        // Timed out — restore previous value
        setText(pttValue, currentVk !== 0 ? vkName(currentVk) : "Not set");
        return;
      }
      currentVk = vk;
      setText(pttValue, vkName(vk));
      pttClear.style.display = "";
      void updatePttKey(vk);
    }).catch(() => {
      // Fallback: capture via JS keydown (dev mode without Tauri)
      capturing = false;
      pttValue.style.borderColor = "";
      pttValue.style.color = "";
      setText(pttValue, currentVk !== 0 ? vkName(currentVk) : "Not set");
    });
  }, { signal });

  pttClear.addEventListener("click", (e) => {
    e.stopPropagation();
    currentVk = 0;
    setText(pttValue, "Not set");
    pttClear.style.display = "none";
    void updatePttKey(0);
  }, { signal });

  appendChildren(pttRow, pttLabel, pttValue, pttClear);
  section.appendChild(pttRow);

  // PTT hint
  const pttHint = createElement("div", {
    style: "font-size: 11px; color: var(--text-micro); margin: 4px 0 16px 0; line-height: 1.4;",
  }, "PTT works globally and does not hijack the key \u2014 you can still type and use other apps normally. Mouse buttons (Mouse 4/5) also work.");
  section.appendChild(pttHint);

  // ── Navigation section ────────────────────────────────────
  section.appendChild(createElement("div", { class: "settings-separator" }));

  const navHeader = createElement("div", {
    style: "font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 4px 0 8px 0;",
  }, "Navigation");
  section.appendChild(navHeader);

  const navBinds: [string, string][] = [
    ["Quick Switcher", "Ctrl + K"],
    ["Mark as Read", "Escape"],
    ["Search Messages", "Ctrl + F"],
  ];
  for (const [label, shortcut] of navBinds) {
    const row = createElement("div", { class: "keybind-row" });
    appendChildren(row,
      createElement("span", { class: "setting-label" }, label),
      createElement("span", { class: "kbd" }, shortcut),
    );
    section.appendChild(row);
  }

  // ── Communication section ──────────────────────────────────
  section.appendChild(createElement("div", { class: "settings-separator" }));

  const commHeader = createElement("div", {
    style: "font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 4px 0 8px 0;",
  }, "Communication");
  section.appendChild(commHeader);

  const commBinds: [string, string][] = [
    ["Toggle Mute", "Ctrl + M"],
    ["Toggle Deafen", "Ctrl + D"],
    ["Toggle Camera", "Ctrl + Shift + V"],
  ];
  for (const [label, shortcut] of commBinds) {
    const row = createElement("div", { class: "keybind-row" });
    appendChildren(row,
      createElement("span", { class: "setting-label" }, label),
      createElement("span", { class: "kbd" }, shortcut),
    );
    section.appendChild(row);
  }

  // ── Messages section ───────────────────────────────────────
  section.appendChild(createElement("div", { class: "settings-separator" }));

  const msgHeader = createElement("div", {
    style: "font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 4px 0 8px 0;",
  }, "Messages");
  section.appendChild(msgHeader);

  const msgBinds: [string, string][] = [
    ["Upload File", "Ctrl + U"],
    ["Edit Last Message", "Arrow Up"],
  ];
  for (const [label, shortcut] of msgBinds) {
    const row = createElement("div", { class: "keybind-row" });
    appendChildren(row,
      createElement("span", { class: "setting-label" }, label),
      createElement("span", { class: "kbd" }, shortcut),
    );
    section.appendChild(row);
  }

  return section;
}

/**
 * Keybinds settings tab — push-to-talk key capture and quick switcher display.
 * PTT uses Rust-side GetAsyncKeyState polling so the key is NOT hijacked.
 *
 * The global mute/deafen section follows the host's `globalShortcuts.status()`
 * backend: polling shows the Ctrl+Shift capture rows, the portal backend
 * (Wayland with the desktop's shortcut service) shows a set-up button and the
 * triggers the desktop reports, and none shows the unsupported note.
 */

import { createElement, appendChildren } from "@lib/dom";
import { vkName } from "@lib/voice/ptt";
import { inputMode } from "@lib/ui/inputMode";
import { loadGlobalShortcutVks, type GlobalShortcutAction } from "@lib/voice/voiceShortcuts";
import { settingsText as t } from "../../i18n/settings";
import { buildPttControls } from "./pttControls";
import {
  KEYBIND_GROUPS,
  UNBOUND_BY_DEFAULT_ROWS,
  type KeybindGroupId,
} from "@lib/prefs/keybindCatalog";
import { REBINDABLE_ACTIONS, saveKeybind, type RebindableId } from "@lib/prefs/keybinds";
import { buildGlobalShortcutSection } from "./KeybindsGlobalRows";
import { appendGlobalKeysPortal } from "./KeybindsPortal";
import { buildComboCapture, cancelCapture, type ComboCapture } from "./comboCapture";

/** A catalog group's rows as text, with the rebindable action each one is. */
function groupRows(
  id: KeybindGroupId,
): { label: string; combo: string; action: RebindableId | null }[] {
  const group = KEYBIND_GROUPS.find((g) => g.id === id);
  return (group?.rows ?? []).map((r) => ({
    label: t(r.action),
    combo: t(r.combo),
    action: r.rebindable ?? null,
  }));
}

export function buildKeybindsTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });

  // Every rebindable row, so "Reset all" can redraw them.
  const captures: ComboCapture[] = [];
  const captureRow = (action: RebindableId, label: string): HTMLElement => {
    const capture = buildComboCapture(signal, {
      action,
      label,
      testId: `keybind-${action}`,
    });
    captures.push(capture);
    return capture.element;
  };
  /** A group's catalog rows: fixed ones as text, rebindable ones as captures. */
  const appendGroupRows = (id: KeybindGroupId): void => {
    for (const { label, combo, action } of groupRows(id)) {
      if (action !== null) {
        section.appendChild(captureRow(action, label));
        continue;
      }
      const row = createElement("div", { class: "keybind-row" });
      appendChildren(
        row,
        createElement("span", { class: "setting-label" }, label),
        createElement("span", { class: "kbd" }, combo),
      );
      section.appendChild(row);
    }
  };

  // ── Push to Talk ──────────────────────────────────────────
  section.append(...buildPttControls(signal));
  if (inputMode() !== "ptt") {
    section.appendChild(
      createElement(
        "div",
        { class: "setting-desc", "data-testid": "ptt-mode-note" },
        t("keybinds.pttModeOff"),
      ),
    );
  }

  // ── Navigation section ────────────────────────────────────
  section.appendChild(createElement("div", { class: "settings-separator" }));

  const navHeader = createElement(
    "div",
    {
      class: "keybind-section-header",
    },
    t("keybinds.navigation"),
  );
  section.appendChild(navHeader);

  appendGroupRows("navigation");

  // ── Communication section ──────────────────────────────────
  section.appendChild(createElement("div", { class: "settings-separator" }));

  const commHeader = createElement(
    "div",
    {
      class: "keybind-section-header",
    },
    t("keybinds.communication"),
  );
  section.appendChild(commHeader);

  // In-app mute and deafen fire on the global shortcut's own binding, so
  // these rows show it and follow a rebind below.
  const globalKeys = loadGlobalShortcutVks();
  const comboText = (action: GlobalShortcutAction): string =>
    t("keybinds.globalKey", { key: vkName(globalKeys[action]) });
  const commKbd: Partial<Record<GlobalShortcutAction, HTMLElement>> = {};
  for (const action of ["mute", "deafen"] as const) {
    const row = createElement("div", { class: "keybind-row" });
    const kbd = createElement("span", { class: "kbd" }, comboText(action));
    commKbd[action] = kbd;
    appendChildren(
      row,
      createElement(
        "span",
        { class: "setting-label" },
        t(action === "mute" ? "keybinds.action.toggleMute" : "keybinds.action.toggleDeafen"),
      ),
      kbd,
    );
    section.appendChild(row);
  }
  appendGroupRows("communication");
  for (const extra of UNBOUND_BY_DEFAULT_ROWS) {
    if (extra.group === "communication") {
      section.appendChild(captureRow(extra.rebindable, t(extra.action)));
    }
  }

  section.appendChild(
    createElement(
      "div",
      {
        style: "font-size: 11px; color: var(--text-micro); margin: 4px 0 0 0; line-height: 1.4;",
      },
      t("keybinds.voiceHint"),
    ),
  );
  section.appendChild(
    createElement(
      "div",
      { class: "keybind-hint", "data-testid": "keybinds-layout-note" },
      t("keybinds.layoutNote"),
    ),
  );
  // The portal backend: the desktop consumes its own shortcuts in every app,
  // ours included, so a clash is settled in its favour.
  const portalPriority = createElement(
    "div",
    {
      class: "keybind-hint",
      hidden: "",
      "data-testid": "keybinds-portal-priority",
    },
    t("keybinds.portalPriority"),
  );
  section.appendChild(portalPriority);

  const globalSection = buildGlobalShortcutSection(signal, globalKeys, comboText, commKbd);
  section.appendChild(globalSection);

  // U6: the voice shortcuts also work while the app is unfocused — through the
  // global key path on Windows/X11, and always through the tray's Mute/Deafen
  // items. Where global key state is unavailable (macOS, or any Wayland session), say
  // so instead of promising a shortcut that cannot fire.
  const globalHint = createElement(
    "div",
    {
      style: "font-size: 11px; color: var(--text-micro); margin: 2px 0 0 0; line-height: 1.4;",
      "data-testid": "keybinds-global-hint",
    },
    t("keybinds.globalHint"),
  );
  section.appendChild(globalHint);

  appendGlobalKeysPortal(section, {
    signal,
    commKbd,
    comboText,
    globalHint,
    globalSection,
    portalPriority,
  });

  // ── Messages section ───────────────────────────────────────
  section.appendChild(createElement("div", { class: "settings-separator" }));

  const msgHeader = createElement(
    "div",
    {
      class: "keybind-section-header",
    },
    t("keybinds.messages"),
  );
  section.appendChild(msgHeader);

  appendGroupRows("messages");

  section.appendChild(
    createElement(
      "div",
      {
        style: "font-size: 11px; color: var(--text-micro); margin: 4px 0 0 0; line-height: 1.4;",
      },
      t("keybinds.formatHint"),
    ),
  );

  // Back to the shipped keys for every rebindable action. Every override is
  // dropped first, then each row checks its default against the others, mute,
  // deafen and push to talk: a default that one of them holds now is saved as
  // unbound, and that row says why. (`parseKeybinds` does not check defaults.)
  const resetAll = createElement(
    "button",
    {
      type: "button",
      class: "ac-btn secondary",
      style: "margin-top: 16px;",
      "data-testid": "keybinds-reset-all",
    },
    t("keybinds.resetAll"),
  );
  resetAll.addEventListener(
    "click",
    () => {
      cancelCapture(signal);
      for (const { id } of REBINDABLE_ACTIONS) saveKeybind(id, undefined);
      for (const capture of captures) capture.reset();
    },
    { signal },
  );
  section.appendChild(resetAll);

  return section;
}

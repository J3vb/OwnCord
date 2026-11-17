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
import { buildSettingsSection } from "./settingsSection";
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
  const voice = buildSettingsSection({ label: t("keybinds.voiceInput") });
  const nav = buildSettingsSection({ label: t("keybinds.navigation") });
  const comm = buildSettingsSection({ label: t("keybinds.communication") });
  const msg = buildSettingsSection({ label: t("keybinds.messages") });

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
  const appendGroupRows = (id: KeybindGroupId, card: HTMLElement): void => {
    for (const { label, combo, action } of groupRows(id)) {
      if (action !== null) {
        card.appendChild(captureRow(action, label));
        continue;
      }
      const row = createElement("div", { class: "keybind-row" });
      appendChildren(
        row,
        createElement("span", { class: "setting-label" }, label),
        createElement("span", { class: "kbd" }, combo),
      );
      card.appendChild(row);
    }
  };

  // ── Push to Talk ──────────────────────────────────────────
  section.appendChild(voice.el);
  voice.card.append(...buildPttControls(signal));
  if (inputMode() !== "ptt") {
    voice.card.appendChild(
      createElement(
        "div",
        { class: "setting-desc", "data-testid": "ptt-mode-note" },
        t("keybinds.pttModeOff"),
      ),
    );
  }

  // ── Navigation section ────────────────────────────────────
  section.appendChild(nav.el);
  appendGroupRows("navigation", nav.card);

  // ── Communication section ──────────────────────────────────
  section.appendChild(comm.el);

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
    comm.card.appendChild(row);
  }
  appendGroupRows("communication", comm.card);
  for (const extra of UNBOUND_BY_DEFAULT_ROWS) {
    if (extra.group === "communication") {
      comm.card.appendChild(captureRow(extra.rebindable, t(extra.action)));
    }
  }

  comm.card.appendChild(
    createElement(
      "div",
      {
        style: "font-size: 11px; color: var(--text-micro); margin: 4px 0 0 0; line-height: 1.4;",
      },
      t("keybinds.voiceHint"),
    ),
  );
  comm.card.appendChild(
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
  comm.card.appendChild(portalPriority);

  const globalSection = buildGlobalShortcutSection(signal, globalKeys, comboText, commKbd);

  // U6: the voice shortcuts also work while the app is unfocused — through the
  // global key path on Windows/X11, and always through the tray's Mute/Deafen
  // items. Where global key state is unavailable (macOS, or any Wayland session), say
  // so instead of promising a shortcut that cannot fire. It opens the Global
  // shortcuts section, above the rows it speaks of.
  const globalHint = createElement(
    "div",
    {
      style:
        "font-size: 11px; color: var(--text-micro); margin: 0 0 var(--space-2); line-height: 1.4;",
      "data-testid": "keybinds-global-hint",
    },
    t("keybinds.globalHint"),
  );
  globalSection.el.insertBefore(globalHint, globalSection.card);
  section.appendChild(globalSection.el);

  appendGlobalKeysPortal(section, {
    signal,
    commKbd,
    comboText,
    globalHint,
    globalSection: globalSection.el,
    globalRows: globalSection.card,
    portalPriority,
  });

  // ── Messages section ───────────────────────────────────────
  section.appendChild(msg.el);
  appendGroupRows("messages", msg.card);

  msg.card.appendChild(
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

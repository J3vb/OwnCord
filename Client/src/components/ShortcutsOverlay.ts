/**
 * The read-only Keyboard Shortcuts overlay (Ctrl+/ or Cmd+/), like Discord's.
 * It renders the shared catalog (`lib/prefs/keybindCatalog.ts`) that the settings
 * Keybinds tab renders too, plus the current global mute and deafen keys. A
 * rebindable row shows the user's binding as it is when the overlay opens, and
 * screen share and disconnect appear once they are bound.
 * Loaded on demand from MainPage. The shared modal factory supplies the dialog
 * contract (role, aria-modal, focus trap, Escape, focus restore) and the
 * `.modal-overlay` that `dialogOpen()` counts, so other shortcuts stay quiet
 * while it is up.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createModal, type ModalInstance } from "@lib/ui/modalFactory";
import { KEYBIND_GROUPS, UNBOUND_BY_DEFAULT_ROWS } from "@lib/prefs/keybindCatalog";
import { loadEffectiveKeybinds } from "@lib/prefs/keybinds";
import { comboLabel, comboOrNotSet } from "@lib/prefs/keybindLabels";
import { vkName } from "@lib/voice/ptt";
import { loadGlobalShortcutVks } from "@lib/voice/voiceShortcuts";
import { settingsText as t } from "../i18n/settings";

let current: ModalInstance | null = null;

function row(label: string, combo: string): HTMLElement {
  const el = createElement("div", { class: "keybind-row" });
  appendChildren(
    el,
    createElement("span", { class: "setting-label" }, label),
    createElement("span", { class: "kbd" }, combo),
  );
  return el;
}

/** Open the overlay; a no-op when it is already open. */
export function openShortcutsOverlay(): void {
  if (current !== null) return;

  const content = createElement("div", {});
  const header = createElement("div", { class: "modal-header" });
  const closeBtn = createElement("button", {
    class: "modal-close",
    type: "button",
    "aria-label": t("shortcuts.close"),
    "data-testid": "shortcuts-close",
  });
  closeBtn.appendChild(createIcon("x", 14));
  appendChildren(
    header,
    createElement("h3", { id: "shortcuts-title" }, t("shortcuts.title")),
    closeBtn,
  );

  const body = createElement("div", { class: "modal-body" });
  const keys = loadGlobalShortcutVks();
  const bindings = loadEffectiveKeybinds();
  for (const group of KEYBIND_GROUPS) {
    body.appendChild(createElement("div", { class: "keybind-section-header" }, t(group.title)));
    if (group.id === "communication") {
      // Rebindable in Settings, so read from the saved binding on each open.
      body.appendChild(
        row(t("keybinds.action.toggleMute"), t("keybinds.globalKey", { key: vkName(keys.mute) })),
      );
      body.appendChild(
        row(
          t("keybinds.action.toggleDeafen"),
          t("keybinds.globalKey", { key: vkName(keys.deafen) }),
        ),
      );
    }
    for (const r of group.rows) {
      const combo = r.rebindable === undefined ? t(r.combo) : comboOrNotSet(bindings[r.rebindable]);
      body.appendChild(row(t(r.action), combo));
    }
    for (const extra of UNBOUND_BY_DEFAULT_ROWS) {
      const bound = bindings[extra.rebindable];
      if (extra.group === group.id && bound !== null) {
        body.appendChild(row(t(extra.action), comboLabel(bound)));
      }
    }
  }
  appendChildren(content, header, body);

  const owner = new Disposable();
  const modal = createModal({
    content,
    className: "shortcuts-modal",
    ariaLabelledBy: "shortcuts-title",
    overlayAttrs: { "data-testid": "shortcuts-overlay" },
    onClose: () => {
      owner.destroy();
      current = null;
    },
  });
  current = modal;
  closeBtn.addEventListener("click", () => modal.close(), { signal: owner.signal });
  // Ctrl+/ again closes it. The global handler stands down while a dialog is
  // open, so the overlay owns the toggle.
  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key !== "/" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      e.preventDefault();
      if (!e.repeat) modal.close();
    },
    { signal: owner.signal },
  );
}

/** Closes the overlay if it is open; the page calls it when it unmounts. */
export function closeShortcutsOverlay(): void {
  current?.close();
}

/**
 * The read-only Keyboard Shortcuts overlay (Ctrl+/ or Cmd+/), like Discord's.
 * It renders the shared catalog (`lib/keybindCatalog.ts`) that the settings
 * Keybinds tab renders too, plus the current global mute and deafen keys.
 * Loaded on demand from MainPage. The shared modal factory supplies the dialog
 * contract (role, aria-modal, focus trap, Escape, focus restore) and the
 * `.modal-overlay` that `dialogOpen()` counts, so other shortcuts stay quiet
 * while it is up.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createModal, type ModalInstance } from "@lib/modalFactory";
import { KEYBIND_GROUPS } from "@lib/keybindCatalog";
import { vkName } from "@lib/ptt";
import { loadGlobalShortcutVks } from "@lib/voiceShortcuts";
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
    for (const r of group.rows) body.appendChild(row(t(r.action), t(r.combo)));
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

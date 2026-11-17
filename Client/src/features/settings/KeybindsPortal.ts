/** Keybinds tab: the portal backend controls and the global keys status wiring. */

import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref } from "@lib/prefs/preferences";
import { loadGlobalShortcutVks, type GlobalShortcutAction } from "@lib/voice/voiceShortcuts";
import { globalKeysErrorCode, markPortalBound, portalHoldsShortcuts } from "@lib/ui/globalKeys";
import { desktop } from "../../platform/desktop";
import { staysAttached, watchGlobalKeys } from "./globalKeysWatch";
import type { GlobalKeysStatus } from "../../platform/contracts/globalShortcuts";
import { settingsText as t } from "../../i18n/settings";
import { buildSettingsSection } from "./settingsSection";

/** What the portal section shares with the rest of the Keybinds tab. */
export interface GlobalKeysPortalContext {
  readonly signal: AbortSignal;
  /** The Communication rows' key labels, which follow the portal's triggers. */
  readonly commKbd: Partial<Record<GlobalShortcutAction, HTMLElement>>;
  readonly comboText: (action: GlobalShortcutAction) => string;
  readonly globalHint: HTMLElement;
  /** The polling Global shortcuts section: its hint, then its rows. */
  readonly globalSection: HTMLElement;
  /** The polling rows' card, shown once the host says global keys can fire. */
  readonly globalRows: HTMLElement;
  readonly portalPriority: HTMLElement;
}

/**
 * Add the portal section to `section` and follow the host's global keys
 * status: polling shows the rebindable rows, the portal shows its controls.
 */
export function appendGlobalKeysPortal(
  section: HTMLElement,
  {
    signal,
    commKbd,
    comboText,
    globalHint,
    globalSection,
    globalRows,
    portalPriority,
  }: GlobalKeysPortalContext,
): void {
  // Portal backend: the desktop owns the keys. One button opens its dialog
  // while mute or deafen is unbound; the Communication rows show the triggers
  // it reports; a second button (version 2+) opens its own shortcut settings.
  const { el: portalSection, card: portalCard } = buildSettingsSection({
    label: t("keybinds.globalSection"),
    attrs: { "data-testid": "keybinds-portal" },
  });
  portalSection.style.display = "none";
  const portalSetUp = createElement(
    "button",
    { class: "ac-btn", "data-testid": "keybinds-portal-setup" },
    t("keybinds.portalSetUp"),
  );
  const portalChange = createElement(
    "button",
    { class: "ac-btn secondary", style: "display: none;", "data-testid": "keybinds-portal-change" },
    t("keybinds.portalChange"),
  );
  const portalWhere = createElement(
    "div",
    {
      style: "display: none; font-size: 11px; color: var(--text-micro); line-height: 1.4;",
      "data-testid": "keybinds-portal-where",
    },
    t("keybinds.portalWhereToChange"),
  );
  const portalNote = createElement(
    "div",
    {
      style:
        "display: none; font-size: 11px; color: var(--text-micro); margin: 2px 0 0 0; line-height: 1.4;",
      role: "status",
      "data-testid": "keybinds-portal-note",
    },
    "",
  );
  // The portal holds our shortcuts but names no keys (Hyprland): the user
  // assigns them in the compositor's config, so there is nothing to set up.
  const portalUnnamed = createElement(
    "div",
    {
      style: "display: none; font-size: 11px; color: var(--text-micro); line-height: 1.4;",
      "data-testid": "keybinds-portal-unnamed",
    },
    t("keybinds.portalUnnamed"),
  );
  appendChildren(
    portalCard,
    createElement(
      "div",
      {
        style: "font-size: 11px; color: var(--text-micro); margin: 2px 0 8px 0; line-height: 1.4;",
      },
      t("keybinds.portalHint"),
    ),
    portalSetUp,
    portalChange,
    portalWhere,
    portalUnnamed,
    portalNote,
  );
  section.appendChild(portalSection);

  let binding = false;
  // What the note holds: the portal's refusal (replaced by a later status),
  // or the outcome of a bind the user just ran (never replaced by one).
  let noteKind: "none" | "refused" | "bind" = "none";
  const showPortalNote = (text: string | null, kind: "refused" | "bind" = "bind"): void => {
    noteKind = text === null ? "none" : kind;
    portalNote.style.display = text === null ? "none" : "";
    setText(portalNote, text ?? "");
  };
  const paintPortalKeys = (status: GlobalKeysStatus): void => {
    const { mute, deafen } = status.triggers;
    // An unbound action keeps the in-app Ctrl+Shift combination it still answers to.
    // A desktop that names no keys has none to show; the action has no in-app
    // fallback to promise either, so say where it is set.
    const unbound = (action: "mute" | "deafen"): string =>
      status.triggersUnnamed ? t("keybinds.portalSetInDesktop") : comboText(action);
    if (commKbd.mute !== undefined) setText(commKbd.mute, mute ?? unbound("mute"));
    if (commKbd.deafen !== undefined) setText(commKbd.deafen, deafen ?? unbound("deafen"));
    portalSetUp.style.display =
      (mute === null || deafen === null) && !status.triggersUnnamed ? "" : "none";
    portalSetUp.disabled = binding;
    portalUnnamed.style.display = status.triggersUnnamed ? "" : "none";
  };
  const paintPortalRefusal = (status: GlobalKeysStatus): void => {
    if (status.sessionRefused) {
      if (noteKind !== "bind") showPortalNote(t("keybinds.portalRefused"), "refused");
    } else if (noteKind === "refused") {
      showPortalNote(null);
    }
  };
  // Where to change keys only matters once the desktop holds some.
  const paintPortalChange = (status: GlobalKeysStatus): void => {
    const { mute, deafen, ptt } = status.triggers;
    const anyBound = mute !== null || deafen !== null || ptt !== null || status.triggersUnnamed;
    portalChange.style.display = anyBound && status.canConfigure ? "" : "none";
    portalWhere.style.display = anyBound && !status.canConfigure ? "" : "none";
  };
  const renderPortal = (status: GlobalKeysStatus): void => {
    portalSection.style.display = "";
    portalPriority.hidden = false;
    paintPortalKeys(status);
    paintPortalRefusal(status);
    paintPortalChange(status);
  };

  portalSetUp.addEventListener(
    "click",
    () => {
      if (binding) return;
      binding = true;
      portalSetUp.disabled = true;
      showPortalNote(null);
      const keys = loadGlobalShortcutVks();
      void desktop.globalShortcuts
        .bindPortal({
          pttVk: loadPref<number>("pttVk", 0),
          muteVk: keys.mute,
          deafenVk: keys.deafen,
        })
        .then((status) => {
          // Saved even when the tab is gone, so the next start restores it.
          if (portalHoldsShortcuts(status)) markPortalBound();
          binding = false;
          if (signal.aborted) return;
          renderPortal(status);
        })
        .catch((err: unknown) => {
          binding = false;
          if (signal.aborted) return;
          portalSetUp.disabled = false;
          showPortalNote(
            globalKeysErrorCode(err) === "bind_cancelled"
              ? t("keybinds.portalCancelled")
              : t("keybinds.portalFailed"),
          );
        });
    },
    { signal },
  );
  portalChange.addEventListener(
    "click",
    () => {
      void desktop.globalShortcuts.configurePortal().catch(() => {
        if (!signal.aborted) showPortalNote(t("keybinds.portalFailed"));
      });
    },
    { signal },
  );

  let statusSeen = false;
  let polled = false;
  let inPortalMode = false;
  const applyStatus = (status: GlobalKeysStatus): void => {
    if (status.backend === "portal") {
      inPortalMode = true;
      globalHint.style.display = "none";
      globalSection.style.display = "none";
      renderPortal(status);
      return;
    }
    if (inPortalMode) {
      // The portal went away (thread failure, a portal without the
      // interface): drop its controls and say global keys are off.
      inPortalMode = false;
      portalSection.style.display = "none";
      portalPriority.hidden = true;
      if (commKbd.mute !== undefined) setText(commKbd.mute, comboText("mute"));
      if (commKbd.deafen !== undefined) setText(commKbd.deafen, comboText("deafen"));
      globalHint.style.display = "";
      globalSection.style.display = "";
      polled = false;
    }
    if (polled) return;
    polled = true;
    void desktop.globalShortcuts
      .supported()
      .catch(() => false)
      .then((supported) => {
        if (signal.aborted) return;
        if (supported) {
          globalRows.style.display = "";
          return;
        }
        setText(globalHint, t("keybinds.globalHintUnsupported"));
      });
  };
  // Subscribe before asking, and let an event outrank the older first answer.
  const attached = staysAttached(section);
  watchGlobalKeys(signal, (next) => {
    if (signal.aborted || !attached()) return false;
    statusSeen = true;
    applyStatus(next);
    return true;
  });
  void desktop.globalShortcuts
    .status()
    .then((status) => {
      if (signal.aborted || statusSeen) return;
      applyStatus(status);
    })
    .catch(() => {
      // status() does not reject; a host that cannot answer keeps the unsupported note.
      if (!signal.aborted) setText(globalHint, t("keybinds.globalHintUnsupported"));
    });
}

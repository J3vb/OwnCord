/**
 * Keybinds settings tab — push-to-talk key capture and quick switcher display.
 * PTT uses Rust-side GetAsyncKeyState polling so the key is NOT hijacked.
 *
 * The global mute/deafen section follows the host's `globalShortcuts.status()`
 * backend: polling shows the Ctrl+Shift capture rows, the portal backend
 * (Wayland with the desktop's shortcut service) shows a set-up button and the
 * triggers the desktop reports, and none shows the unsupported note.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { vkName } from "@lib/voice/ptt";
import { loadPref } from "@lib/prefs/preferences";
import { inputMode } from "@lib/ui/inputMode";
import {
  keyEventToVk,
  loadGlobalShortcutVks,
  saveGlobalShortcutVk,
  shortcutConflict,
  type GlobalShortcutAction,
} from "@lib/voice/voiceShortcuts";
import { globalKeysErrorCode, markPortalBound, portalHoldsShortcuts } from "@lib/ui/globalKeys";
import { desktop } from "../../platform/desktop";
import { staysAttached, watchGlobalKeys } from "./globalKeysWatch";
import type { GlobalKeysStatus } from "../../platform/contracts/globalShortcuts";
import { settingsText as t } from "../../i18n/settings";
import { buildPttControls } from "./pttControls";
import {
  KEYBIND_GROUPS,
  UNBOUND_BY_DEFAULT_ROWS,
  type KeybindGroupId,
} from "@lib/prefs/keybindCatalog";
import {
  REBINDABLE_ACTIONS,
  globalShortcutTakenVks,
  loadEffectiveKeybinds,
  saveKeybind,
  type RebindableId,
} from "@lib/prefs/keybinds";
import { beginCapture, buildComboCapture, cancelCapture, type ComboCapture } from "./comboCapture";

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

  // U6: the global (unfocused) mute/deafen shortcuts are rebindable. Each row
  // captures Ctrl+Shift+<key> from the focused webview, rejects a duplicate or
  // the in-app camera combination, persists the choice and pushes it to the
  // running native poller live. The key is always Ctrl+Shift in the poller, so
  // the row renders that fixed prefix and captures only the variable key.
  // The whole section hides where global keys cannot fire (see the hint below),
  // so no control promises a shortcut the platform will not deliver.
  const globalSection = createElement("div", { style: "display: none;" });
  globalSection.appendChild(createElement("div", { class: "settings-separator" }));
  globalSection.appendChild(
    createElement("div", { class: "keybind-section-header" }, t("keybinds.globalSection")),
  );

  const captureState: {
    binding: GlobalShortcutAction | null;
    onKey: ((e: KeyboardEvent) => void) | null;
  } = { binding: null, onKey: null };

  const stopCapture = (): void => {
    captureState.binding = null;
    if (captureState.onKey !== null) {
      document.removeEventListener("keydown", captureState.onKey, true);
      captureState.onKey = null;
    }
  };

  const conflict = createElement(
    "div",
    {
      style:
        "display: none; font-size: 11px; color: var(--text-danger); margin: 2px 0 0 0; line-height: 1.4;",
      role: "alert",
    },
    t("keybinds.globalConflict"),
  );

  const globalRow = (action: GlobalShortcutAction, label: string, testId: string, aria: string) => {
    const row = createElement("div", { class: "keybind-row" });
    const button = createElement(
      "button",
      {
        class: "kbd",
        style: "cursor: pointer; min-width: 80px; text-align: center;",
        title: t("keybinds.clickToSet"),
        "aria-label": aria,
        "data-testid": testId,
      },
      comboText(action),
    );
    const show = (text: string): void => {
      setText(button, text);
      button.setAttribute("aria-label", t("keybinds.rebindAria", { action: aria, combo: text }));
    };
    show(comboText(action));
    button.addEventListener(
      "click",
      () => {
        if (captureState.binding !== null) return;
        conflict.style.display = "none";
        captureState.binding = action;
        button.style.borderColor = "var(--accent)";
        show(t("keybinds.pressKey"));

        let release: (() => void) | null = null;
        const finish = (): void => {
          release?.();
          stopCapture();
          button.style.borderColor = "";
          show(comboText(action));
        };

        const onKey = (e: KeyboardEvent): void => {
          if (e.code === "Escape") {
            e.preventDefault();
            e.stopPropagation(); // cancel the capture, not the whole Settings overlay
            finish();
            return;
          }
          if (e.code === "Tab") {
            finish(); // focus moves on; the capture must not follow it
            return;
          }
          const vk = keyEventToVk(e);
          if (vk === null) return; // modifiers and unmapped keys do not bind
          e.preventDefault();
          e.stopPropagation();
          const reason = shortcutConflict(
            vk,
            action,
            globalKeys,
            globalShortcutTakenVks(loadEffectiveKeybinds()),
          );
          if (reason !== null) {
            finish();
            conflict.style.display = "";
            return;
          }
          globalKeys[action] = vk;
          saveGlobalShortcutVk(action, vk);
          const kbd = commKbd[action];
          if (kbd !== undefined) setText(kbd, comboText(action));
          finish();
          void desktop.globalShortcuts
            .setKeys({ muteVk: globalKeys.mute, deafenVk: globalKeys.deafen })
            .catch(() => {
              // Not a Tauri host, or the command was refused: the tray and the
              // in-app shortcuts still work; the global key path stays as it was.
            });
        };
        captureState.onKey = onKey;
        // Starting this capture ends an in-app row's, and the reverse.
        release = beginCapture(signal, finish);
        document.addEventListener("keydown", onKey, { capture: true, signal });
      },
      { signal },
    );
    appendChildren(row, createElement("span", { class: "setting-label" }, label), button);
    return row;
  };

  globalSection.appendChild(
    globalRow(
      "mute",
      t("keybinds.action.toggleMute"),
      "keybind-global-mute",
      t("keybinds.globalAria"),
    ),
  );
  globalSection.appendChild(
    globalRow(
      "deafen",
      t("keybinds.action.toggleDeafen"),
      "keybind-global-deafen",
      t("keybinds.globalDeafenAria"),
    ),
  );
  globalSection.appendChild(conflict);
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

  // Portal backend: the desktop owns the keys. One button opens its dialog
  // while mute or deafen is unbound; the Communication rows show the triggers
  // it reports; a second button (version 2+) opens its own shortcut settings.
  const portalSection = createElement("div", {
    style: "display: none;",
    "data-testid": "keybinds-portal",
  });
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
    portalSection,
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
  let portalHeading = false;
  const renderPortal = (status: GlobalKeysStatus): void => {
    // The heading is built on first use so a polling or unsupported desktop
    // carries no empty section.
    if (!portalHeading) {
      portalHeading = true;
      portalSection.prepend(
        createElement("div", { class: "settings-separator" }),
        createElement("div", { class: "keybind-section-header" }, t("keybinds.globalSection")),
      );
    }
    portalSection.style.display = "";
    portalPriority.hidden = false;
    const { mute, deafen } = status.triggers;
    const muteKbd = commKbd.mute;
    const deafenKbd = commKbd.deafen;
    // An unbound action keeps the in-app Ctrl+Shift combination it still answers to.
    // A desktop that names no keys has none to show; the action has no in-app
    // fallback to promise either, so say where it is set.
    const unbound = (action: "mute" | "deafen"): string =>
      status.triggersUnnamed ? t("keybinds.portalSetInDesktop") : comboText(action);
    if (muteKbd !== undefined) setText(muteKbd, mute ?? unbound("mute"));
    if (deafenKbd !== undefined) setText(deafenKbd, deafen ?? unbound("deafen"));
    portalSetUp.style.display =
      (mute === null || deafen === null) && !status.triggersUnnamed ? "" : "none";
    portalSetUp.disabled = binding;
    portalUnnamed.style.display = status.triggersUnnamed ? "" : "none";
    if (status.sessionRefused) {
      if (noteKind !== "bind") showPortalNote(t("keybinds.portalRefused"), "refused");
    } else if (noteKind === "refused") {
      showPortalNote(null);
    }
    // Where to change keys only matters once the desktop holds some.
    const anyBound =
      mute !== null || deafen !== null || status.triggers.ptt !== null || status.triggersUnnamed;
    portalChange.style.display = anyBound && status.canConfigure ? "" : "none";
    portalWhere.style.display = anyBound && !status.canConfigure ? "" : "none";
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
          globalSection.style.display = "";
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

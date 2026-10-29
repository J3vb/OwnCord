/**
 * Per-user context menu on a voice participant row: local playback volume for
 * everyone, plus a moderation section where the server says this user may
 * moderate voice in the row's channel (can_moderate_voice).
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { createMenuItem, openMenuShell } from "@lib/context-menu";
import { createIcon } from "@lib/icons";
import {
  setUserVolume,
  getUserVolume,
  setUserLocalMute,
  getUserLocalMute,
} from "@lib/livekitSession";
import { voiceText as t } from "../../i18n/voice";

/** Moderation section wiring. Passed only when the local user may moderate
 *  voice; the menu renders the section iff this is present, so the permission
 *  decision stays with the caller (which knows the channel's verdict). A string
 *  instead is why the section is unavailable, shown as disabled text. */
export interface VoiceModMenuOptions {
  /** Current moderator-imposed state of the target, for the toggle labels. */
  readonly serverMuted?: boolean;
  readonly serverDeafened?: boolean;
  /** Voice channels the target can be moved to (the current one excluded). */
  readonly moveTargets: readonly { readonly id: number; readonly name: string }[];
  /** Mute, deafen and disconnect render only when their handler is present: a
   *  Move Members-only role is given just `moveTargets` and `onMove` (WP 8.4b). */
  readonly onServerMute?: (muted: boolean) => void;
  readonly onServerDeafen?: (deafened: boolean) => void;
  readonly onMove: (toChannelId: number) => void;
  readonly onDisconnect?: () => void;
  /** Set while the actions cannot reach the server (socket not connected): the
   *  rows stay visible but greyed and inert, with this as the reason. */
  readonly disabledReason?: string;
}

/**
 * `lifetimeSignal` should be the sidebar's own factory-lifetime signal
 * (aborted only on sidebar destroy), NOT a per-render signal that gets
 * replaced on every redraw — this menu is mounted on document.body,
 * independent of any one render, and must not be torn down by an unrelated
 * re-render (OC-0282).
 */
export function showUserVolumeMenu(
  userId: number,
  username: string,
  x: number,
  y: number,
  lifetimeSignal: AbortSignal,
  mod?: VoiceModMenuOptions | string,
): void {
  // Discord-width: a long notice (moderation unavailable) wraps instead of
  // stretching the menu. The keyboard model leaves the slider a native Tab stop.
  openMenuShell({
    x,
    y,
    className: "user-vol-menu",
    attrs: { style: "max-width:240px" },
    signal: lifetimeSignal,
    build: (menu, closeMenu) => buildVolumeMenu(menu, closeMenu, userId, username, mod),
  });
}

function buildVolumeMenu(
  menu: HTMLElement,
  closeMenu: () => void,
  userId: number,
  username: string,
  mod: VoiceModMenuOptions | string | undefined,
): void {
  const header = createElement(
    "div",
    {
      class: "context-menu-item",
      style: "font-weight:600;cursor:default;pointer-events:none",
    },
    username,
  );
  menu.appendChild(header);

  const sep = createElement("div", { class: "context-menu-sep" });
  menu.appendChild(sep);

  const currentVol = getUserVolume(userId);
  const volLabel = createElement(
    "div",
    {
      class: "context-menu-item",
      style: "font-size:12px;color:var(--text-muted);cursor:default;pointer-events:none",
    },
    t("volume.user", { percent: currentVol }),
  );
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
  const valLabel = createElement(
    "span",
    {
      class: "slider-val",
      style: "min-width:40px;text-align:right;font-size:12px;color:var(--text-muted)",
    },
    `${currentVol}%`,
  );

  slider.addEventListener("input", () => {
    const val = Number(slider.value);
    setText(valLabel, `${val}%`);
    setText(volLabel, t("volume.user", { percent: val }));
    setUserVolume(userId, val);
    // Raising the level unmutes, as the tile slider does.
    if (val > 0 && getUserLocalMute(userId)) setUserLocalMute(userId, false);
    mute.sync();
  });

  appendChildren(sliderRow, slider, valLabel);
  menu.appendChild(sliderRow);

  const showFullVolume = (): void => {
    slider.value = "100";
    setText(valLabel, "100%");
    setText(volLabel, t("volume.resetFull"));
  };
  const resetBtn = createMenuItem(t("volume.reset"), "context-menu-item");
  resetBtn.addEventListener("click", () => {
    setUserVolume(userId, 100);
    showFullVolume();
    mute.sync();
  });
  menu.appendChild(resetBtn);

  const mute = createLocalMuteItem(userId, showFullVolume);
  menu.appendChild(mute.item);

  if (mod !== undefined) appendVoiceModeration(menu, mod, closeMenu);
}

/**
 * Local Mute, as a checkbox row: silences this user for you only and keeps
 * their level, so unchecking it brings that level back. A level of 0 reads as
 * muted too, and unchecking it restores 100% (then `onRestoreFull` runs, so
 * the caller can redraw its slider). The menu stays open. `sync` redraws the
 * check after the caller changes the level.
 */
export function createLocalMuteItem(
  userId: number,
  onRestoreFull: () => void,
): { readonly item: HTMLElement; readonly sync: () => void } {
  const isSilenced = (): boolean => getUserLocalMute(userId) || getUserVolume(userId) === 0;
  const item = createMenuItem(t("volume.mute"), "context-menu-item");
  item.setAttribute("role", "menuitemcheckbox");
  item.setAttribute("data-action", "local-mute");
  item.style.display = "flex";
  item.style.alignItems = "center";
  const check = createElement("span", {
    "aria-hidden": "true",
    style: "margin-left:auto;display:inline-flex",
  });
  check.appendChild(createIcon("check", 14));
  item.appendChild(check);
  const sync = (): void => {
    const muted = isSilenced();
    item.setAttribute("aria-checked", String(muted));
    check.style.visibility = muted ? "visible" : "hidden";
  };
  sync();
  item.addEventListener("click", () => {
    if (!isSilenced()) {
      setUserLocalMute(userId, true);
    } else {
      setUserLocalMute(userId, false);
      if (getUserVolume(userId) === 0) {
        setUserVolume(userId, 100);
        onRestoreFull();
      }
    }
    sync();
  });
  return { item, sync };
}

/** The moderation section, or why it is unavailable (a string, shown as
 *  disabled text). Shared with the video tile menu. */
export function appendVoiceModeration(
  menu: HTMLElement,
  mod: VoiceModMenuOptions | string,
  close: () => void,
): void {
  if (typeof mod !== "string") {
    appendModerationSection(menu, mod, close);
    return;
  }
  menu.appendChild(createElement("div", { class: "context-menu-sep" }));
  menu.appendChild(
    createElement(
      "div",
      {
        class: "context-menu-item",
        "aria-disabled": "true",
        "data-action": "voice-mod-unavailable",
        style: "font-size:12px;color:var(--text-muted);cursor:default;pointer-events:none",
      },
      mod,
    ),
  );
}

/** Builds the moderation rows. close() runs after any action so the menu does
 *  not linger showing stale labels while the server round-trip is in flight. */
function appendModerationSection(
  menu: HTMLElement,
  mod: VoiceModMenuOptions,
  close: () => void,
): void {
  menu.appendChild(createElement("div", { class: "context-menu-sep" }));
  const disabled = mod.disabledReason !== undefined;

  /** One moderation row; inert and greyed while `disabled`. */
  const modItem = (label: string, action: string, run: () => void, danger = false): HTMLElement => {
    const cls = ["context-menu-item", danger ? "danger" : "", disabled ? "disabled" : ""]
      .filter((c) => c !== "")
      .join(" ");
    const item = createMenuItem(label, cls);
    item.setAttribute("data-action", action);
    if (disabled) {
      (item as HTMLButtonElement).disabled = true;
      item.title = mod.disabledReason ?? "";
      return item;
    }
    item.addEventListener("click", () => {
      run();
      close();
    });
    return item;
  };

  if (mod.disabledReason !== undefined) {
    menu.appendChild(
      createElement(
        "div",
        {
          class: "context-menu-item",
          "aria-disabled": "true",
          "data-action": "voice-mod-offline",
          style: "font-size:12px;color:var(--text-muted);cursor:default;pointer-events:none",
        },
        mod.disabledReason,
      ),
    );
  }

  const { onServerMute, onServerDeafen, onDisconnect } = mod;
  if (onServerMute !== undefined) {
    menu.appendChild(
      modItem(
        mod.serverMuted === true ? t("volume.serverUnmute") : t("volume.serverMute"),
        "server-mute",
        () => onServerMute(mod.serverMuted !== true),
      ),
    );
  }
  if (onServerDeafen !== undefined) {
    menu.appendChild(
      modItem(
        mod.serverDeafened === true ? t("volume.serverUndeafen") : t("volume.serverDeafen"),
        "server-deafen",
        () => onServerDeafen(mod.serverDeafened !== true),
      ),
    );
  }

  if (mod.moveTargets.length > 0) {
    // Hover-revealed flyout, same shape as the AdminActions role submenu. The
    // trigger is a role=menuitem so ArrowRight/Enter opens it from the keyboard.
    const moveWrap = createMenuItem(
      t("volume.moveTo"),
      disabled
        ? "context-menu-item context-menu-item--submenu disabled"
        : "context-menu-item context-menu-item--submenu",
      { submenu: true },
    );
    moveWrap.setAttribute("data-action", "move-to");
    if (disabled) {
      moveWrap.setAttribute("aria-disabled", "true");
      moveWrap.title = mod.disabledReason ?? "";
    } else {
      const sub = createElement("div", { class: "context-menu__submenu" });
      sub.style.display = "none";
      moveWrap.addEventListener("mouseenter", () => {
        sub.style.display = "";
      });
      moveWrap.addEventListener("mouseleave", () => {
        sub.style.display = "none";
      });
      for (const ch of mod.moveTargets) {
        const item = createMenuItem(ch.name, "context-menu-item");
        item.setAttribute("data-move-channel", String(ch.id));
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          mod.onMove(ch.id);
          close();
        });
        sub.appendChild(item);
      }
      moveWrap.appendChild(sub);
    }
    menu.appendChild(moveWrap);
  }

  if (onDisconnect !== undefined) {
    menu.appendChild(modItem(t("volume.disconnect"), "voice-disconnect", onDisconnect, true));
  }
}

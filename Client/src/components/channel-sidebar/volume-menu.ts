/**
 * Per-user context menu on a voice participant row: local playback volume for
 * everyone, plus a moderation section where the server says this user may
 * moderate voice in the row's channel (can_moderate_voice).
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren, setOwnedTimeout } from "@lib/dom";
import { createMenuItem, enableMenuKeyboard } from "@lib/context-menu";
import { setUserVolume, getUserVolume } from "@lib/livekitSession";
import { voiceText as t } from "../../i18n/voice";

/** No-op default until the keyboard model installs the real restorer. */
const noop = (): void => {};

/** Moderation section wiring. Passed only when the local user may moderate
 *  voice; the menu renders the section iff this is present, so the permission
 *  decision stays with the caller (which knows the channel's verdict). A string
 *  instead is why the section is unavailable, shown as disabled text. */
export interface VoiceModMenuOptions {
  /** Current moderator-imposed state of the target, for the toggle labels. */
  readonly serverMuted: boolean;
  readonly serverDeafened: boolean;
  /** Voice channels the target can be moved to (the current one excluded). */
  readonly moveTargets: readonly { readonly id: number; readonly name: string }[];
  readonly onServerMute: (muted: boolean) => void;
  readonly onServerDeafen: (deafened: boolean) => void;
  readonly onMove: (toChannelId: number) => void;
  readonly onDisconnect: () => void;
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
  // Remove any existing context menus and destroy their dismiss owners
  document.querySelectorAll(".user-vol-menu").forEach((el) => {
    const prev = (el as HTMLElement & { dismiss?: Disposable }).dismiss;
    prev?.destroy();
    el.remove();
  });

  const menu = createElement("div", { class: "context-menu user-vol-menu" });
  // One owner for the menu's whole life, so the keyboard model and the
  // outside-click dismissal are torn down together (B9 A11Y-01).
  const dismiss = new Disposable();
  (menu as HTMLElement & { dismiss?: Disposable }).dismiss = dismiss;

  // Restores focus to the invoking row; replaced once the keyboard model is
  // installed. Every close path funnels through closeMenu so focus never drops
  // to <body> (A11Y-01).
  let restoreFocus: () => void = noop;
  const closeMenu = (): void => {
    menu.remove();
    dismiss.destroy();
    restoreFocus();
  };

  const header = createElement(
    "div",
    {
      class: "context-menu-item",
      // Purely a label: not a menuitem, so roving navigation skips it.
      role: "presentation",
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
      role: "presentation",
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
  });

  appendChildren(sliderRow, slider, valLabel);
  menu.appendChild(sliderRow);

  const resetBtn = createMenuItem(t("volume.reset"), "context-menu-item");
  resetBtn.addEventListener("click", () => {
    setUserVolume(userId, 100);
    slider.value = "100";
    setText(valLabel, "100%");
    setText(volLabel, t("volume.resetFull"));
  });
  menu.appendChild(resetBtn);

  if (typeof mod === "string") {
    menu.appendChild(createElement("div", { class: "context-menu-sep" }));
    menu.appendChild(
      createElement(
        "div",
        {
          class: "context-menu-item",
          role: "presentation",
          "aria-disabled": "true",
          "data-action": "voice-mod-unavailable",
          style: "font-size:12px;color:var(--text-muted);cursor:default;pointer-events:none",
        },
        mod,
      ),
    );
  } else if (mod !== undefined) {
    appendModerationSection(menu, mod, closeMenu);
  }

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Keyboard model (A11Y-01): focus the first row on open, arrows/Home/End
  // move, Escape closes and restores the invoking row. The slider stays a
  // native Tab stop.
  restoreFocus = enableMenuKeyboard(menu, { signal: dismiss.signal, onClose: closeMenu });

  // Close on click outside — store the owner on the element for cleanup on re-open
  setOwnedTimeout(
    dismiss.signal,
    () => {
      document.addEventListener(
        "mousedown",
        (e: MouseEvent) => {
          if (!menu.contains(e.target as Node)) closeMenu();
        },
        { signal: dismiss.signal },
      );
    },
    0,
  );

  // Also clean up if the parent component is destroyed. Tied to dismiss's
  // own signal (mirrors context-menu.ts's menuOwner pattern) so this bridge
  // listener is torn down with the menu itself — otherwise it never runs
  // (the lifetime signal is long-lived) and every right-click permanently
  // accumulates one closure retaining a detached .user-vol-menu subtree.
  lifetimeSignal.addEventListener(
    "abort",
    () => {
      menu.remove();
      dismiss.destroy();
    },
    { signal: dismiss.signal },
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

  const muteItem = createMenuItem(
    mod.serverMuted ? t("volume.serverUnmute") : t("volume.serverMute"),
    "context-menu-item",
  );
  muteItem.setAttribute("data-action", "server-mute");
  muteItem.addEventListener("click", () => {
    mod.onServerMute(!mod.serverMuted);
    close();
  });
  menu.appendChild(muteItem);

  const deafenItem = createMenuItem(
    mod.serverDeafened ? t("volume.serverUndeafen") : t("volume.serverDeafen"),
    "context-menu-item",
  );
  deafenItem.setAttribute("data-action", "server-deafen");
  deafenItem.addEventListener("click", () => {
    mod.onServerDeafen(!mod.serverDeafened);
    close();
  });
  menu.appendChild(deafenItem);

  if (mod.moveTargets.length > 0) {
    // Hover-revealed flyout, same shape as the AdminActions role submenu. The
    // trigger is a role=menuitem so ArrowRight/Enter opens it from the keyboard.
    const moveWrap = createMenuItem(
      t("volume.moveTo"),
      "context-menu-item context-menu-item--submenu",
      { submenu: true },
    );
    moveWrap.setAttribute("data-action", "move-to");
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
    menu.appendChild(moveWrap);
  }

  const kickItem = createMenuItem(t("volume.disconnect"), "context-menu-item danger");
  kickItem.setAttribute("data-action", "voice-disconnect");
  kickItem.addEventListener("click", () => {
    mod.onDisconnect();
    close();
  });
  menu.appendChild(kickItem);
}

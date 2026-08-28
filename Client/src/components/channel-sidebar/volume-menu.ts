/**
 * Per-user context menu on a voice participant row: local playback volume for
 * everyone, plus a moderation section for users whose role holds MUTE_MEMBERS.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { setUserVolume, getUserVolume } from "@lib/livekitSession";

/** Moderation section wiring. Passed only when the local user may moderate
 *  voice; the menu renders the section iff this is present, so the permission
 *  decision stays with the caller (which knows the role list). */
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
  mod?: VoiceModMenuOptions,
): void {
  // Remove any existing context menus and abort their dismiss controllers
  document.querySelectorAll(".user-vol-menu").forEach((el) => {
    const prev = (el as HTMLElement & { _dismissAc?: AbortController })._dismissAc;
    prev?.abort();
    el.remove();
  });

  const menu = createElement("div", { class: "context-menu user-vol-menu" });

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
    `User Volume: ${currentVol}%`,
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

  if (mod !== undefined) {
    appendModerationSection(menu, mod, () => {
      menu.remove();
    });
  }

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Close on click outside — store controller on element for cleanup on re-open
  const dismissAc = new AbortController();
  (menu as HTMLElement & { _dismissAc?: AbortController })._dismissAc = dismissAc;
  setTimeout(() => {
    if (dismissAc.signal.aborted) return;
    document.addEventListener(
      "mousedown",
      (e: MouseEvent) => {
        if (!menu.contains(e.target as Node)) {
          menu.remove();
          dismissAc.abort();
        }
      },
      { signal: dismissAc.signal },
    );
  }, 0);

  // Also clean up if the parent component is destroyed. Tied to dismissAc's
  // own signal (mirrors context-menu.ts's menuAc pattern) so this bridge
  // listener is torn down with the menu itself — otherwise it never runs
  // (the lifetime signal is long-lived) and every right-click permanently
  // accumulates one closure retaining a detached .user-vol-menu subtree.
  lifetimeSignal.addEventListener(
    "abort",
    () => {
      menu.remove();
      dismissAc.abort();
    },
    { signal: dismissAc.signal },
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

  const muteItem = createElement(
    "div",
    { class: "context-menu-item", "data-action": "server-mute" },
    mod.serverMuted ? "Server Unmute" : "Server Mute",
  );
  muteItem.addEventListener("click", () => {
    mod.onServerMute(!mod.serverMuted);
    close();
  });
  menu.appendChild(muteItem);

  const deafenItem = createElement(
    "div",
    { class: "context-menu-item", "data-action": "server-deafen" },
    mod.serverDeafened ? "Server Undeafen" : "Server Deafen",
  );
  deafenItem.addEventListener("click", () => {
    mod.onServerDeafen(!mod.serverDeafened);
    close();
  });
  menu.appendChild(deafenItem);

  if (mod.moveTargets.length > 0) {
    // Hover-revealed flyout, same shape as the AdminActions role submenu.
    const moveWrap = createElement("div", {
      class: "context-menu-item context-menu-item--submenu",
      "data-action": "move-to",
    });
    moveWrap.appendChild(createElement("span", {}, "Move to"));
    const sub = createElement("div", { class: "context-menu__submenu" });
    sub.style.display = "none";
    moveWrap.addEventListener("mouseenter", () => {
      sub.style.display = "";
    });
    moveWrap.addEventListener("mouseleave", () => {
      sub.style.display = "none";
    });
    for (const ch of mod.moveTargets) {
      const item = createElement(
        "div",
        { class: "context-menu-item", "data-move-channel": String(ch.id) },
        ch.name,
      );
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

  const kickItem = createElement(
    "div",
    { class: "context-menu-item danger", "data-action": "voice-disconnect" },
    "Disconnect",
  );
  kickItem.addEventListener("click", () => {
    mod.onDisconnect();
    close();
  });
  menu.appendChild(kickItem);
}

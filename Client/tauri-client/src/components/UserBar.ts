/**
 * UserBar component — shows current user info at the bottom of the sidebar.
 * Subscribes to authStore for user data. Settings button opens settings overlay.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { authStore } from "@stores/auth.store";
import { openSettings } from "@stores/ui.store";

export function createUserBar(): MountableComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;

  // Element references for targeted updates
  let avatarEl: HTMLDivElement | null = null;
  let avatarTextEl: HTMLSpanElement | null = null;
  let nameEl: HTMLSpanElement | null = null;
  let statusEl: HTMLSpanElement | null = null;

  function updateFromState(): void {
    const state = authStore.getState();
    const user = state.user;
    const username = user?.username ?? "Unknown";
    const initial = username.charAt(0).toUpperCase() || "?";

    if (avatarTextEl !== null) {
      setText(avatarTextEl, initial);
    }
    if (nameEl !== null) {
      setText(nameEl, username);
    }
    if (statusEl !== null) {
      setText(statusEl, state.isAuthenticated ? "Online" : "Offline");
    }
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "user-bar", "data-testid": "user-bar" });

    avatarEl = createElement(
      "div",
      { class: "ub-avatar", style: "background: var(--accent); position: relative;" },
    );
    avatarTextEl = createElement("span", {});
    avatarEl.appendChild(avatarTextEl);
    const statusDot = createElement("div", {
      class: "status-dot",
      style: "background: var(--green); width: 10px; height: 10px; border-radius: 50%; position: absolute; bottom: 0; right: 0;",
    });
    avatarEl.appendChild(statusDot);

    const info = createElement("div", { class: "ub-info" });
    nameEl = createElement("span", { class: "ub-name", "data-testid": "user-bar-name" });
    statusEl = createElement("span", { class: "ub-status" });
    appendChildren(info, nameEl, statusEl);

    const buttons = createElement("div", { class: "ub-controls" });

    const muteBtn = createElement(
      "button",
      { title: "Mute", "aria-label": "Mute" },
      "\uD83C\uDFA4",
    );

    const deafenBtn = createElement(
      "button",
      { title: "Deafen", "aria-label": "Deafen" },
      "\uD83C\uDFA7",
    );

    const settingsBtn = createElement(
      "button",
      { title: "Settings", "aria-label": "Settings" },
      "\u2699",
    );

    settingsBtn.addEventListener(
      "click",
      () => {
        openSettings();
      },
      { signal: ac.signal },
    );

    appendChildren(buttons, muteBtn, deafenBtn, settingsBtn);
    appendChildren(root, avatarEl, info, buttons);

    // Initial render
    updateFromState();

    // Subscribe to auth changes
    unsubscribe = authStore.subscribe(() => {
      updateFromState();
    });

    container.appendChild(root);
  }

  function destroy(): void {
    ac.abort();
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
    if (root !== null) {
      root.remove();
      root = null;
    }
    avatarEl = null;
    avatarTextEl = null;
    nameEl = null;
    statusEl = null;
  }

  return { mount, destroy };
}

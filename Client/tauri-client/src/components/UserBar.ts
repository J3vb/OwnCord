/**
 * UserBar component — shows current user info at the bottom of the sidebar.
 * Subscribes to authStore for user data. Settings button opens settings overlay.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import { Disposable } from "@lib/disposable";
import { authStore } from "@stores/auth.store";
import { openSettings } from "@stores/ui.store";
import { createStatusPicker, type StatusPickerComponent } from "@components/StatusPicker";
import type { UserStatus } from "@lib/types";
import type { WsClient } from "@lib/ws";

export interface UserBarOptions {
  readonly onDisconnect?: () => void;
  readonly ws?: WsClient | null;
}

export function createUserBar(options?: UserBarOptions): MountableComponent {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;

  // Element references for targeted updates
  let avatarEl: HTMLDivElement | null = null;
  let avatarTextEl: HTMLSpanElement | null = null;
  let nameEl: HTMLSpanElement | null = null;
  let statusEl: HTMLSpanElement | null = null;
  let statusPicker: StatusPickerComponent | null = null;

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

    avatarEl = createElement("div", {
      class: "ub-avatar",
      style: "background: var(--accent); position: relative;",
    });
    avatarTextEl = createElement("span", {});
    avatarEl.appendChild(avatarTextEl);
    const statusDot = createElement("div", {
      class: "status-dot",
      style:
        "background: var(--green); width: 10px; height: 10px; border-radius: 50%; position: absolute; bottom: 0; right: 0;",
    });
    avatarEl.appendChild(statusDot);

    const info = createElement("div", { class: "ub-info" });
    nameEl = createElement("span", { class: "ub-name", "data-testid": "user-bar-name" });
    statusEl = createElement("span", { class: "ub-status" });
    appendChildren(info, nameEl, statusEl);

    // Status picker — anchored below username, opens upward
    const statusPickerWrap = createElement("div", {
      class: "ub-status-picker-wrap",
      "data-testid": "status-picker-wrap",
    });

    const isWsConnected = (): boolean => {
      const ws = options?.ws;
      return ws !== undefined && ws !== null && ws.getState() === "connected";
    };

    statusPicker = createStatusPicker({
      currentStatus: "online" as UserStatus,
      onStatusChange: (status: UserStatus) => {
        const ws = options?.ws;
        if (ws !== null && ws !== undefined && isWsConnected()) {
          ws.send({ type: "presence_update", payload: { status } } as never);
        }
      },
    });
    statusPicker.mount(statusPickerWrap);

    // Disable picker when WS is disconnected
    const updatePickerDisabled = (): void => {
      const ws = options?.ws;
      const connected = ws !== undefined && ws !== null && ws.getState() === "connected";
      statusPickerWrap.classList.toggle("ub-status-picker--disabled", !connected);
      if (!connected) {
        statusPickerWrap.title = "Offline";
      } else {
        statusPickerWrap.title = "";
      }
    };
    updatePickerDisabled();

    // Subscribe to WS state changes if ws is provided
    if (options?.ws !== undefined && options?.ws !== null) {
      const unsub = options.ws.onStateChange(() => updatePickerDisabled());
      disposable.addCleanup(unsub);
    }

    info.appendChild(statusPickerWrap);

    const buttons = createElement("div", { class: "ub-controls" });

    const settingsBtn = createElement("button", { title: "Settings", "aria-label": "Settings" });
    settingsBtn.appendChild(createIcon("settings", 18));

    disposable.onEvent(settingsBtn, "click", () => {
      openSettings();
    });

    buttons.appendChild(settingsBtn);

    if (options?.onDisconnect !== undefined) {
      const disconnectFn = options.onDisconnect;
      const disconnectBtn = createElement("button", {
        class: "ub-ctrl-btn",
        title: "Switch server",
        "aria-label": "Switch server",
        "data-testid": "disconnect-btn",
      });
      disconnectBtn.appendChild(createIcon("log-out", 18));
      disposable.onEvent(disconnectBtn, "click", () => disconnectFn());
      buttons.appendChild(disconnectBtn);
    }

    appendChildren(root, avatarEl, info, buttons);

    // Initial render
    updateFromState();

    // Subscribe to auth changes
    disposable.onStoreChange(
      authStore,
      (s) => s.user,
      () => updateFromState(),
    );

    container.appendChild(root);
  }

  function destroy(): void {
    statusPicker?.destroy();
    statusPicker = null;
    disposable.destroy();
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

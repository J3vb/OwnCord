/**
 * UserBar component — shows current user info at the bottom of the sidebar.
 * Subscribes to authStore for user data. Settings button opens settings overlay.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import { Disposable } from "@lib/disposable";
import { authStore } from "@stores/auth.store";
import { openSettings, uiStore } from "@stores/ui.store";
import { createStatusPicker, type StatusPickerComponent } from "@components/StatusPicker";
import type { UserStatus } from "@lib/types";
import {
  loadCustomStatus,
  loadUserStatus,
  onUserStatusChange,
  saveCustomStatus,
  saveUserStatus,
} from "@lib/userStatus";
import { avatarInitial, isRenderableAvatar, resolveDisplayName } from "@lib/avatar";
import { fetchImageAsDataUrl, resolveServerUrl } from "@components/message-list/attachments";
import type { WsClient } from "@lib/ws";

export interface UserBarOptions {
  readonly onDisconnect?: () => void;
  readonly ws?: WsClient | null;
}

/** Status labels for the line under the username. */
const STATUS_TEXT: Readonly<Record<UserStatus, string>> = {
  online: "Online",
  idle: "Idle",
  dnd: "Do Not Disturb",
  invisible: "Invisible",
  offline: "Offline",
};

export function createUserBar(options?: UserBarOptions): MountableComponent {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;

  // Element references for targeted updates
  let avatarEl: HTMLDivElement | null = null;
  let avatarTextEl: HTMLSpanElement | null = null;
  let avatarImgEl: HTMLImageElement | null = null;
  /** Avatar URL currently rendered, so a re-render for an unrelated auth
   *  change doesn't re-fetch the same picture. */
  let renderedAvatarUrl: string | null = null;
  let nameEl: HTMLSpanElement | null = null;
  let statusEl: HTMLSpanElement | null = null;
  let statusPicker: StatusPickerComponent | null = null;

  /** Swap the letter for the uploaded picture, or back again. */
  function renderAvatar(subject: {
    username: string;
    displayName: string | null;
    avatar: string | null;
  }): void {
    if (avatarEl === null) return;
    if (avatarTextEl !== null) setText(avatarTextEl, avatarInitial(subject));

    const url = isRenderableAvatar(subject.avatar) ? resolveServerUrl(subject.avatar) : null;
    if (url === renderedAvatarUrl) return;
    renderedAvatarUrl = url;

    if (avatarImgEl !== null) {
      avatarImgEl.remove();
      avatarImgEl = null;
    }
    if (url === null) {
      if (avatarTextEl !== null) avatarTextEl.style.display = "";
      avatarEl.style.background = "var(--accent)";
      return;
    }
    void fetchImageAsDataUrl(url).then((dataUrl) => {
      // The URL may have changed again (or the bar been torn down) while the
      // bytes were in flight.
      if (dataUrl === null || avatarEl === null || renderedAvatarUrl !== url) return;
      const img = createElement("img", {
        class: "avatar-img",
        src: dataUrl,
        alt: subject.username,
      });
      avatarImgEl = img;
      if (avatarTextEl !== null) avatarTextEl.style.display = "none";
      avatarEl.style.background = "transparent";
      avatarEl.insertBefore(img, avatarEl.firstChild);
    });
  }

  function updateFromState(): void {
    const state = authStore.getState();
    const user = state.user;
    const subject = {
      username: user?.username ?? "Unknown",
      displayName: user?.display_name ?? null,
      avatar: user?.avatar ?? null,
    };

    renderAvatar(subject);
    if (nameEl !== null) {
      setText(nameEl, resolveDisplayName(subject));
    }
    if (statusEl !== null) {
      // The bar shows the user's own chosen status, invisible included —
      // everyone else is told offline, but lying to the owner about their own
      // state is exactly the bug real invisible exists to fix.
      const text = state.isAuthenticated ? (STATUS_TEXT[loadUserStatus()] ?? "Online") : "Offline";
      setText(statusEl, text);
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

    const info = createElement("div", { class: "ub-info" });
    nameEl = createElement("span", { class: "ub-name", "data-testid": "user-bar-name" });
    statusEl = createElement("span", { class: "ub-status" });
    appendChildren(info, nameEl, statusEl);

    // Status picker — the dot itself lives in the avatar's corner (same spot
    // the old plain status indicator occupied) so it doubles as the status
    // display and its click target; the dropdown still opens upward from there.
    const statusPickerWrap = createElement("div", {
      class: "ub-status-picker-wrap",
      "data-testid": "status-picker-wrap",
    });

    // The picker is usable only when the socket is live (store-backed status,
    // docs/architecture/ux §3) AND a ws client was provided to send through —
    // without a send path, selecting a status would be a silent no-op.
    const canSetStatus = (): boolean => {
      const ws = options?.ws;
      return ws !== undefined && ws !== null && uiStore.getState().connectionStatus === "connected";
    };

    statusPicker = createStatusPicker({
      // Start from the stored selection, not a hardcoded "online" — otherwise
      // this picker and the settings Account tab show different statuses.
      currentStatus: loadUserStatus(),
      currentCustomStatus: loadCustomStatus(),
      onStatusChange: (status: UserStatus) => {
        saveUserStatus(status);
        updateFromState();
        const ws = options?.ws;
        if (ws !== null && ws !== undefined && canSetStatus()) {
          // No custom_status field: a plain status change must leave whatever
          // text the user set standing.
          ws.send({ type: "presence_update", payload: { status } } as never);
        }
      },
      onCustomStatusChange: (text: string) => {
        saveCustomStatus(text);
        const ws = options?.ws;
        if (ws !== null && ws !== undefined && canSetStatus()) {
          ws.send({
            type: "presence_update",
            payload: { status: loadUserStatus(), custom_status: text },
          } as never);
        }
      },
    });
    statusPicker.mount(statusPickerWrap);

    // Reflect status changes made on the settings Account tab.
    disposable.addCleanup(
      onUserStatusChange(
        (status) => {
          statusPicker?.setStatus(status);
          updateFromState();
        },
        { signal: disposable.signal },
      ),
    );

    // Disable picker (with a reason) when the connection is down
    const updatePickerDisabled = (): void => {
      const enabled = canSetStatus();
      statusPickerWrap.classList.toggle("ub-status-picker--disabled", !enabled);
      if (!enabled) {
        statusPickerWrap.title = "Offline";
      } else {
        statusPickerWrap.title = "";
      }
    };
    updatePickerDisabled();

    disposable.onStoreChange(
      uiStore,
      (s) => s.connectionStatus,
      () => updatePickerDisabled(),
    );

    avatarEl.appendChild(statusPickerWrap);

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
    statusPicker?.destroy?.();
    statusPicker = null;
    disposable.destroy();
    if (root !== null) {
      root.remove();
      root = null;
    }
    avatarEl = null;
    avatarTextEl = null;
    avatarImgEl = null;
    renderedAvatarUrl = null;
    nameEl = null;
    statusEl = null;
  }

  return { mount, destroy };
}

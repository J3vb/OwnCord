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
import type { PresenceSender } from "@lib/presence";

export interface UserBarOptions {
  readonly onDisconnect?: () => void;
  readonly ws?: WsClient | null;
  /**
   * The session's single shared presence sender (MainPage owns the instance
   * and threads it to every producer — auto-idle, the settings Account tab,
   * and this picker). Sending straight through `ws` instead would bypass the
   * presence rate limiter's client-side token *and* its retry, so a frame
   * the server drops (1 update / 10s, keyed by user id — service/
   * channel.go) is lost for the rest of the session instead of retried
   * (OC-0210). Required, alongside `ws`, for the picker to be enabled.
   */
  readonly presenceSender?: PresenceSender | null;
}

/**
 * The signed-in user's custom status as the server told it to us, or `null`
 * when no user is loaded yet (before the first `ready`/auth_ok). `null` is
 * the only case callers should fall back to the localStorage pref for —
 * once a user is loaded, its `custom_status` (even "") is authoritative and
 * must not be second-guessed against a value that may belong to a different
 * account or server (OC-0310).
 */
function serverCustomStatus(): string | null {
  const user = authStore.getState().user;
  return user !== null ? (user.custom_status ?? "") : null;
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
    // docs/architecture/ux §3) AND a presence sender was provided to send
    // through — without one, selecting a status would either be a silent
    // no-op or (worse) bypass the shared presence rate limiter and its retry
    // (OC-0210). `ws` is checked too since a sender without a live socket
    // behind it is not meaningfully usable either.
    const canSetStatus = (): boolean => {
      const ws = options?.ws;
      const sender = options?.presenceSender;
      return (
        ws !== undefined &&
        ws !== null &&
        sender !== undefined &&
        sender !== null &&
        uiStore.getState().connectionStatus === "connected"
      );
    };

    statusPicker = createStatusPicker({
      // Start from the stored selection, not a hardcoded "online" — otherwise
      // this picker and the settings Account tab show different statuses.
      currentStatus: loadUserStatus(),
      // The server's own auth_ok.user.custom_status is authoritative (OC-0310):
      // the localStorage pref is only a same-window fallback for before the
      // first `ready` arrives. Once authStore has a user, its custom_status —
      // even null/"" meaning "no status set" — wins outright; falling through
      // to the pref there (via `??`) would let a stale value from a previous
      // account/server on this machine leak back in exactly when the server
      // says there is nothing to show, which is the one case that must render
      // empty for the picker's clear-it flow to work at all.
      currentCustomStatus: serverCustomStatus() ?? loadCustomStatus(),
      onStatusChange: (status: UserStatus) => {
        saveUserStatus(status);
        updateFromState();
        const sender = options?.presenceSender;
        if (sender !== null && sender !== undefined && canSetStatus()) {
          // No custom_status field: a plain status change must leave whatever
          // text the user set standing. Routed through the shared sender
          // (not ws.send directly) so a frame the presence limiter's window
          // rejects is retried instead of lost — see @lib/presence.
          sender.send(status);
        }
      },
      onCustomStatusChange: (text: string) => {
        saveCustomStatus(text);
        const sender = options?.presenceSender;
        if (sender !== null && sender !== undefined && canSetStatus()) {
          sender.send(loadUserStatus(), text);
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

    // Subscribe to auth changes. Also reflects a custom_status that arrives
    // (or changes) through authStore — a later auth_ok, or the settings
    // Account tab's own presence send being echoed back — into the picker,
    // using the same setCustomStatus() the seed above trusts (OC-0310). The
    // null-safe read happens inside the callback so both "no user yet" and
    // "user with no custom status" collapse to the same "" default.
    disposable.onStoreChange(
      authStore,
      (s) => s.user,
      () => {
        updateFromState();
        statusPicker?.setCustomStatus(serverCustomStatus() ?? "");
      },
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

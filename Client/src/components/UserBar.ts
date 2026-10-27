/**
 * UserBar component — shows current user info at the bottom of the sidebar.
 * Subscribes to authStore for user data. Settings button opens settings overlay.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import { Disposable } from "@lib/disposable";
import { authStore } from "@stores/auth.store";
import { membersStore } from "@stores/members.store";
import { voiceStore, isSelfMuted, type VoiceState } from "@stores/voice.store";
import { openSettings, uiStore } from "@stores/ui.store";
import { createStatusPicker, type StatusPickerComponent } from "@components/StatusPicker";
import { createSelfProfileCard, type SelfProfileCard } from "@components/SelfProfileCard";
import type { UserStatus } from "@lib/types";
import {
  isTimedStatus,
  loadCustomStatus,
  loadUserStatus,
  onUserStatusChange,
  saveCustomStatus,
  saveStatusTimer,
  saveUserStatus,
} from "@lib/userStatus";
import { parseExpiry } from "@components/statusDefs";
import { avatarInitial, resolveDisplayName } from "@lib/avatar";
import {
  avatarAnimationMode,
  isRenderableAvatar,
  setAvatarSource,
} from "@components/message-list/avatar";
import {
  fetchImageAsObjectUrl,
  recoverEvictedImage,
  resolveServerUrl,
} from "@components/message-list/attachments";
import type { WsClient } from "@lib/ws";
import type { PresenceSender } from "@lib/presence";
import { shellText } from "../i18n/shell";
import { voiceText } from "../i18n/voice";
import { portalText } from "../i18n/portal";

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
  /** The mic and headphone buttons. They work in a call or not: outside one
   *  they only change the saved state the next join starts with. */
  readonly onMuteToggle?: () => void;
  readonly onDeafenToggle?: () => void;
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

/**
 * When your own custom status clears itself. Your member entry first (the
 * optimistic apply of a "Clear after" and a change from another device write
 * it, `null` meaning none), then auth_ok's, which is where the server states
 * it on a fresh connection.
 */
function ownCustomStatusExpiresAt(): string | null {
  const user = authStore.getState().user;
  const m = user === null ? undefined : membersStore.getState().members.get(user.id);
  if (m?.customStatusExpiresAt !== undefined) return m.customStatusExpiresAt;
  return user?.custom_status_expires_at ?? null;
}

/** Status labels for the line under the username. */
const STATUS_TEXT = {
  online: "status.online",
  idle: "status.idle",
  dnd: "status.dnd",
  invisible: "status.invisible",
  offline: "status.offline",
} as const satisfies Readonly<Record<UserStatus, string>>;

function swapIcon(btn: HTMLButtonElement, name: IconName): void {
  btn.querySelector("svg")?.remove();
  btn.appendChild(createIcon(name, 18));
}

/** Paint the mic and headphone buttons from the voice store. A moderator's
 *  mute or deafen is not ours to lift (the server refuses it), so its button
 *  is disabled and says why. In a call joined listen-only there is no mic to
 *  mute, and an idle push-to-talk key reads as its own state, not a mute. */
function renderVoiceControls(muteBtn: HTMLButtonElement, deafenBtn: HTMLButtonElement): void {
  const voice = voiceStore.getState();
  const inCall = voice.currentChannelId !== null;
  const userMuted = isSelfMuted(voice);
  const serverMuted = voice.localServerMuted === true;
  const serverDeafened = voice.localServerDeafened === true;
  // The AFK channel is listen-only for everyone: the mic reads muted and is locked.
  const afkLocked = inCall && voice.inAfkChannel === true;
  const listenOnly = inCall && voice.listenOnly && !serverMuted && !afkLocked;
  const pttGated = inCall && voice.pttGated === true && !userMuted && !listenOnly && !afkLocked;

  muteBtn.classList.toggle("active-ctrl", userMuted);
  muteBtn.classList.toggle("ptt-gated", pttGated);
  muteBtn.classList.toggle("ub-listen-only", listenOnly);
  swapIcon(muteBtn, userMuted || listenOnly || afkLocked ? "mic-off" : "mic");
  muteBtn.setAttribute("aria-pressed", String(userMuted || afkLocked));
  muteBtn.disabled = serverMuted || listenOnly || afkLocked;
  muteBtn.title = serverMuted
    ? voiceText("widget.mutedByModerator")
    : afkLocked
      ? voiceText("widget.control.afkLocked")
      : listenOnly
        ? voiceText("widget.control.listenOnly")
        : pttGated
          ? voiceText("widget.control.pttGated")
          : voiceText(userMuted ? "widget.control.unmute" : "widget.control.mute");

  deafenBtn.classList.toggle("active-ctrl", voice.localDeafened);
  swapIcon(deafenBtn, voice.localDeafened ? "headphones-off" : "headphones");
  deafenBtn.setAttribute("aria-pressed", String(voice.localDeafened));
  deafenBtn.disabled = serverDeafened;
  deafenBtn.title = serverDeafened
    ? voiceText("widget.deafenedByModerator")
    : voiceText(voice.localDeafened ? "widget.control.undeafen" : "widget.control.deafen");
}

/** Everything renderVoiceControls reads, as one comparable key. */
function voiceControlsKey(s: VoiceState): string {
  return [
    s.currentChannelId !== null,
    s.localMuted,
    s.localDeafened,
    s.localServerMuted === true,
    s.localServerDeafened === true,
    s.listenOnly,
    s.pttGated === true,
    s.inAfkChannel === true,
  ].join("|");
}

/** The same speaking ring as the user's own voice-channel row, while their
 *  mic is live: never through a mute, a deafen or a released push-to-talk. */
function selfSpeaking(s: VoiceState): boolean {
  const id = authStore.getState().user?.id;
  const self =
    s.currentChannelId === null || id === undefined
      ? undefined
      : s.voiceUsers.get(s.currentChannelId)?.get(id);
  return self?.speaking === true && !s.localMuted && !s.localDeafened && s.pttGated !== true;
}

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
  let profileCard: SelfProfileCard | null = null;

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
    void fetchImageAsObjectUrl(url).then(async (objectUrl) => {
      // The URL may have changed again (or the bar been torn down) while the
      // bytes were in flight.
      const current = (): boolean => avatarEl !== null && renderedAvatarUrl === url;
      if (objectUrl === null || !current()) return;
      const img = createElement("img", { class: "avatar-img", alt: subject.username });
      recoverEvictedImage(img, { url });
      const el = avatarEl;
      if (el === null) return;
      if (!(await setAvatarSource(img, objectUrl, () => avatarAnimationMode(el), current))) return;
      avatarImgEl = img;
      if (avatarTextEl !== null) avatarTextEl.style.display = "none";
      el.style.background = "transparent";
      el.insertBefore(img, el.firstChild);
    });
  }

  function updateFromState(): void {
    const state = authStore.getState();
    const user = state.user;
    const subject = {
      username: user?.username ?? shellText("common.unknown"),
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
      const text = shellText(
        state.isAuthenticated
          ? (STATUS_TEXT[loadUserStatus()] ?? "status.online")
          : "status.offline",
      );
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

    // The avatar and name are one real button that opens your own profile
    // card. The status dot is a sibling laid over the avatar's corner (a
    // control cannot nest inside a button) and keeps its own dropdown.
    const self = createElement("div", { class: "ub-self" });
    const profileBtn = createElement("button", {
      class: "ub-profile-btn",
      type: "button",
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      "data-testid": "user-bar-profile",
    });
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

    // One save path for the dropdown and the profile card.
    function applyStatus(status: UserStatus, durationMs?: number): void {
      saveUserStatus(status);
      // After the save, which ends any earlier timer: this one reverts the
      // status to Online when it runs out (lib/statusTimer, started by the page).
      if (durationMs !== undefined && isTimedStatus(status)) {
        saveStatusTimer(status, Date.now() + durationMs);
      }
      updateFromState();
      const sender = options?.presenceSender;
      if (sender !== null && sender !== undefined && canSetStatus()) {
        // No custom_status field: a plain status change must leave whatever
        // text the user set standing. Routed through the shared sender
        // (not ws.send directly) so a frame the presence limiter's window
        // rejects is retried instead of lost — see @lib/presence.
        sender.send(status);
      }
    }
    function applyCustomStatus(text: string, expiresInSeconds?: number): void {
      saveCustomStatus(text);
      const sender = options?.presenceSender;
      if (sender !== null && sender !== undefined && canSetStatus()) {
        sender.send(loadUserStatus(), text, expiresInSeconds);
      }
    }

    profileCard = createSelfProfileCard({
      trigger: profileBtn,
      canSetStatus,
      // Our own member entry first: the optimistic apply and the server echo
      // write it, while authStore.user.custom_status only moves at auth_ok
      // and on a rollback.
      getCustomStatus: () => {
        const id = authStore.getState().user?.id;
        const m = id === undefined ? undefined : membersStore.getState().members.get(id);
        const text =
          m !== undefined ? (m.customStatus ?? "") : (serverCustomStatus() ?? loadCustomStatus());
        // The server clears an expired status itself; until its broadcast
        // lands, do not show text whose time has already passed.
        const expiresAt = parseExpiry(ownCustomStatusExpiresAt());
        return expiresAt !== null && expiresAt <= Date.now() ? "" : text;
      },
      getCustomStatusExpiresAt: ownCustomStatusExpiresAt,
      onStatusChange: applyStatus,
      onCustomStatusChange: applyCustomStatus,
    });
    disposable.onEvent(profileBtn, "click", () => profileCard?.toggle());

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
      onStatusChange: applyStatus,
      onCustomStatusChange: applyCustomStatus,
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

    // Disable picker (with a reason) when the connection is down. Truly inert
    // (no Tab stop, no open, no selection): a custom status set while the
    // socket is down is saved locally, never sent, and overwritten on the next
    // reconnect (F16).
    const updatePickerDisabled = (): void => {
      const enabled = canSetStatus();
      statusPicker?.setEnabled(enabled);
      statusPickerWrap.classList.toggle("ub-status-picker--disabled", !enabled);
      if (!enabled) {
        statusPickerWrap.title = shellText("status.offline");
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

    appendChildren(profileBtn, avatarEl, info);
    appendChildren(self, profileBtn, statusPickerWrap);

    const buttons = createElement("div", { class: "ub-controls" });

    const onMuteToggle = options?.onMuteToggle;
    const onDeafenToggle = options?.onDeafenToggle;
    if (onMuteToggle !== undefined && onDeafenToggle !== undefined) {
      const muteBtn = createElement("button", {
        "aria-label": voiceText("widget.control.mute"),
        "data-testid": "ub-mute",
      });
      const deafenBtn = createElement("button", {
        "aria-label": voiceText("widget.control.deafen"),
        "data-testid": "ub-deafen",
      });
      disposable.onEvent(muteBtn, "click", () => onMuteToggle());
      disposable.onEvent(deafenBtn, "click", () => onDeafenToggle());
      renderVoiceControls(muteBtn, deafenBtn);
      disposable.onStoreChange(voiceStore, voiceControlsKey, () =>
        renderVoiceControls(muteBtn, deafenBtn),
      );
      appendChildren(buttons, muteBtn, deafenBtn);
    }

    const settingsBtn = createElement("button", {
      title: shellText("common.settings"),
      "aria-label": shellText("common.settings"),
    });
    settingsBtn.appendChild(createIcon("settings", 18));

    disposable.onEvent(settingsBtn, "click", () => {
      openSettings();
    });

    buttons.appendChild(settingsBtn);

    if (options?.onDisconnect !== undefined) {
      const disconnectFn = options.onDisconnect;
      // The portal serves one server, so the button signs out instead.
      const disconnectLabel = __OWNCORD_WEB__
        ? portalText("userBar.signOut")
        : shellText("quickSwitch.label");
      const disconnectBtn = createElement("button", {
        class: "ub-ctrl-btn",
        title: disconnectLabel,
        "aria-label": disconnectLabel,
        "data-testid": "disconnect-btn",
      });
      disconnectBtn.appendChild(createIcon("log-out", 18));
      disposable.onEvent(disconnectBtn, "click", () => disconnectFn());
      buttons.appendChild(disconnectBtn);
    }

    appendChildren(root, self, buttons);

    // Initial render
    updateFromState();

    avatarEl.classList.toggle("speaking", selfSpeaking(voiceStore.getState()));
    disposable.onStoreChange(voiceStore, selfSpeaking, (speaking: boolean) =>
      avatarEl?.classList.toggle("speaking", speaking),
    );

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

    // A presence rollback (a TIMED_OUT refusal) puts the previous custom status
    // back in the members store, which can leave authStore unchanged and so
    // never fire the subscription above — the picker would keep the refused
    // text and ignore a retype of it. Follow our own member entry as well.
    disposable.onStoreChange(
      membersStore,
      (s) => {
        const id = authStore.getState().user?.id;
        return id === undefined ? "" : (s.members.get(id)?.customStatus ?? "");
      },
      (text: string) => statusPicker?.setCustomStatus(text),
    );

    container.appendChild(root);
  }

  function destroy(): void {
    profileCard?.destroy();
    profileCard = null;
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

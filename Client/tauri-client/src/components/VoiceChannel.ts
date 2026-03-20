/**
 * VoiceChannel component — renders a voice channel item with connected users.
 * Returns an HTMLDivElement (not a MountableComponent).
 * Step 6.51
 */

import { createElement, appendChildren, clearChildren, setText } from "@lib/dom";
import { voiceStore } from "@stores/voice.store";
import type { VoiceUser } from "@stores/voice.store";
import { membersStore } from "@stores/members.store";
import { setUserVolume, getUserVolume } from "@lib/livekitSession";
import { authStore } from "@stores/auth.store";

export interface VoiceChannelOptions {
  channelId: number;
  channelName: string;
  onJoin(): void;
}

export interface VoiceChannelResult {
  element: HTMLDivElement;
  update(): void;
  destroy(): void;
}

const AVATAR_COLORS = ["#5865f2", "#57f287", "#fee75c", "#eb459e", "#ed4245"];

function pickAvatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] ?? "#5865f2";
}

export function createVoiceChannel(options: VoiceChannelOptions): VoiceChannelResult {
  const ac = new AbortController();
  const unsubs: Array<() => void> = [];

  // Wrapper div to hold the channel-item and voice-users-list as siblings
  const root = createElement("div");

  // Channel item row (same structure as text channels)
  const channelItem = createElement("div", { class: "channel-item voice" });
  const icon = createElement("span", { class: "ch-icon" }, "\uD83D\uDD0A");
  const nameEl = createElement("span", { class: "ch-name" }, options.channelName);
  appendChildren(channelItem, icon, nameEl);

  // Users container
  const usersContainer = createElement("div", { class: "voice-users-list" });

  appendChildren(root, channelItem, usersContainer);

  // Click to join
  channelItem.addEventListener("click", options.onJoin, { signal: ac.signal });

  // Track active context menu for cleanup
  let activeCtxMenu: HTMLDivElement | null = null;
  let menuDismissAc: AbortController | null = null;

  function closeContextMenu(): void {
    if (menuDismissAc !== null) {
      menuDismissAc.abort();
      menuDismissAc = null;
    }
    if (activeCtxMenu !== null) {
      activeCtxMenu.remove();
      activeCtxMenu = null;
    }
  }

  function showVolumeMenu(userId: number, username: string, x: number, y: number): void {
    closeContextMenu();

    const menu = createElement("div", { class: "context-menu" });

    // Header
    const header = createElement("div", {
      class: "context-menu-item",
      style: "font-weight:600;cursor:default;pointer-events:none",
    }, username);
    menu.appendChild(header);

    const sep = createElement("div", { class: "context-menu-sep" });
    menu.appendChild(sep);

    // Volume label
    const currentVol = getUserVolume(userId);
    const volLabel = createElement("div", {
      class: "context-menu-item",
      style: "font-size:12px;color:var(--text-muted);cursor:default;pointer-events:none",
    }, `User Volume: ${currentVol}%`);
    menu.appendChild(volLabel);

    // Volume slider (0-200%, like Discord)
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
    const valLabel = createElement("span", {
      class: "slider-val",
      style: "min-width:40px;text-align:right;font-size:12px;color:var(--text-muted)",
    }, `${currentVol}%`);

    slider.addEventListener("input", () => {
      const val = Number(slider.value);
      setText(valLabel, `${val}%`);
      setText(volLabel, `User Volume: ${val}%`);
      setUserVolume(userId, val);
    });

    appendChildren(sliderRow, slider, valLabel);
    menu.appendChild(sliderRow);

    // Reset button
    const resetBtn = createElement("div", { class: "context-menu-item" }, "Reset Volume");
    resetBtn.addEventListener("click", () => {
      setUserVolume(userId, 100);
      slider.value = "100";
      setText(valLabel, "100%");
      setText(volLabel, "User Volume: 100%");
    });
    menu.appendChild(resetBtn);

    // Position and show
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    document.body.appendChild(menu);
    activeCtxMenu = menu;

    // Close on click outside — uses AbortController so cleanup on destroy works
    menuDismissAc = new AbortController();
    const dismissSignal = menuDismissAc.signal;
    setTimeout(() => {
      document.addEventListener("mousedown", (e: MouseEvent) => {
        if (!menu.contains(e.target as Node)) {
          closeContextMenu();
        }
      }, { signal: dismissSignal });
    }, 0);
  }

  function createUserRow(user: VoiceUser, username: string): HTMLDivElement {
    const classes = user.speaking
      ? "voice-user-item speaking"
      : "voice-user-item";
    const row = createElement("div", { class: classes });

    const initial = username.length > 0 ? username.charAt(0).toUpperCase() : "?";
    const color = pickAvatarColor(username);
    const avatar = createElement("div", { class: "vu-avatar" }, initial);
    avatar.style.background = color;
    row.appendChild(avatar);

    const name = createElement("span", { class: "vu-name" }, username);
    row.appendChild(name);

    if (user.muted || user.deafened) {
      const mutedIcon = user.deafened ? "\uD83D\uDD08" : "\uD83D\uDD07";
      const mutedEl = createElement("span", { class: "vu-muted" }, mutedIcon);
      row.appendChild(mutedEl);
    }

    // Right-click for per-user volume (skip for own user)
    const currentUser = authStore.getState().user;
    if (currentUser === null || currentUser.id !== user.userId) {
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        showVolumeMenu(user.userId, username, e.clientX, e.clientY);
      }, { signal: ac.signal });
    }

    return row;
  }

  // Track previous Map reference to skip unnecessary re-renders
  let prevChannelUsers: ReadonlyMap<number, VoiceUser> | undefined;
  let prevMembers: ReadonlyMap<number, unknown> | undefined;

  function update(): void {
    const channelUsers = voiceStore.getState().voiceUsers.get(options.channelId);
    const members = membersStore.getState().members;

    // Skip re-render if neither the channel's user map nor members changed
    if (channelUsers === prevChannelUsers && members === prevMembers) return;
    prevChannelUsers = channelUsers;
    prevMembers = members;

    clearChildren(usersContainer);

    if (channelUsers === undefined) {
      channelItem.classList.remove("active");
      return;
    }

    for (const user of channelUsers.values()) {
      const member = members.get(user.userId);
      const username = (member as { username?: string } | undefined)?.username ?? "Unknown";
      const row = createUserRow(user, username);
      usersContainer.appendChild(row);
    }

    // Mark channel-item active if there are users
    if (channelUsers.size > 0) {
      channelItem.classList.add("active");
    } else {
      channelItem.classList.remove("active");
    }
  }

  // Initial render and subscribe
  update();
  unsubs.push(voiceStore.subscribeSelector((s) => s.voiceUsers, () => update()));
  unsubs.push(membersStore.subscribeSelector((s) => s.members, () => update()));

  function destroy(): void {
    closeContextMenu();
    ac.abort();
    for (const unsub of unsubs) {
      unsub();
    }
    unsubs.length = 0;
  }

  return { element: root, update, destroy };
}

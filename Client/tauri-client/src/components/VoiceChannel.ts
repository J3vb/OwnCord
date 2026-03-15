/**
 * VoiceChannel component — renders a voice channel item with connected users.
 * Returns an HTMLDivElement (not a MountableComponent).
 * Step 6.51
 */

import { createElement, appendChildren, clearChildren } from "@lib/dom";
import { voiceStore } from "@stores/voice.store";
import type { VoiceUser } from "@stores/voice.store";
import { membersStore } from "@stores/members.store";

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

    return row;
  }

  function update(): void {
    clearChildren(usersContainer);

    const channelUsers = voiceStore.getState().voiceUsers.get(options.channelId);
    if (channelUsers === undefined) return;

    const members = membersStore.getState().members;

    for (const user of channelUsers.values()) {
      const member = members.get(user.userId);
      const username = member?.username ?? "Unknown";
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
  unsubs.push(voiceStore.subscribe(() => update()));
  unsubs.push(membersStore.subscribe(() => update()));

  function destroy(): void {
    ac.abort();
    for (const unsub of unsubs) {
      unsub();
    }
    unsubs.length = 0;
  }

  return { element: root, update, destroy };
}

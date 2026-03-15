/**
 * VoiceChannel component — renders a voice channel item with connected users.
 * Returns an HTMLDivElement (not a MountableComponent).
 * Step 6.51
 */

import { createElement, appendChildren, setText, clearChildren } from "@lib/dom";
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

export function createVoiceChannel(options: VoiceChannelOptions): VoiceChannelResult {
  const ac = new AbortController();
  const unsubs: Array<() => void> = [];

  const root = createElement("div", { class: "voice-channel-item" });

  // Header
  const header = createElement("div", { class: "voice-channel-header" });
  const icon = createElement("span", { class: "voice-icon" }, "\uD83D\uDD0A");
  const nameEl = createElement("span", { class: "voice-channel-name" }, options.channelName);
  appendChildren(header, icon, nameEl);

  // Users container
  const usersContainer = createElement("div", { class: "voice-channel-users" });

  appendChildren(root, header, usersContainer);

  // Click to join
  root.addEventListener("click", options.onJoin, { signal: ac.signal });

  function createUserRow(user: VoiceUser, username: string): HTMLDivElement {
    const classes = user.speaking
      ? "voice-user voice-user--speaking"
      : "voice-user";
    const row = createElement("div", { class: classes });

    const name = createElement("span", { class: "voice-user__name" }, username);
    row.appendChild(name);

    const icons: string[] = [];
    if (user.muted) icons.push("\uD83D\uDD07");
    if (user.deafened) icons.push("\uD83D\uDD08");

    if (icons.length > 0) {
      const iconsEl = createElement("span", { class: "voice-user__icons" }, icons.join(""));
      row.appendChild(iconsEl);
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

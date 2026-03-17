/**
 * VoiceWidget component — shows active voice channel info with controls.
 * Hidden when not connected to a voice channel.
 * Step 6.50
 */

import { createElement, appendChildren, setText, clearChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { voiceStore } from "@stores/voice.store";
import type { VoiceUser } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";

export interface VoiceWidgetOptions {
  onDisconnect(): void;
  onMuteToggle(): void;
  onDeafenToggle(): void;
  onCameraToggle(): void;
  onScreenshareToggle(): void;
}

export function createVoiceWidget(options: VoiceWidgetOptions): MountableComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;
  let channelNameEl: HTMLSpanElement | null = null;
  let usersContainer: HTMLDivElement | null = null;
  let muteBtn: HTMLButtonElement | null = null;
  let deafenBtn: HTMLButtonElement | null = null;

  const unsubs: Array<() => void> = [];

  function render(): void {
    if (root === null || channelNameEl === null || usersContainer === null) return;

    const voice = voiceStore.getState();
    const channelId = voice.currentChannelId;

    if (channelId === null) {
      root.classList.remove("visible");
      return;
    }

    root.classList.add("visible");

    // Channel name
    const channel = channelsStore.getState().channels.get(channelId);
    setText(channelNameEl, channel?.name ?? "Voice Channel");

    // Toggle button active states
    muteBtn?.classList.toggle("active-ctrl", voice.localMuted);
    deafenBtn?.classList.toggle("active-ctrl", voice.localDeafened);

    // User list
    clearChildren(usersContainer);
    const channelUsers = voice.voiceUsers.get(channelId);
    if (channelUsers === undefined) return;

    const members = membersStore.getState().members;

    for (const user of channelUsers.values()) {
      const userEl = createUserRow(user, members.get(user.userId)?.username);
      usersContainer.appendChild(userEl);
    }
  }

  function createUserRow(user: VoiceUser, username?: string): HTMLDivElement {
    const row = createElement("div", {
      class: user.speaking ? "voice-user-item speaking" : "voice-user-item",
      "data-testid": `voice-user-${user.userId}`,
    });
    const avatar = createElement("div", {
      class: "vu-avatar",
      style: "background: var(--accent)",
    }, (username ?? "?").charAt(0).toUpperCase());
    const nameEl = createElement("span", {}, username ?? "Unknown");

    appendChildren(row, avatar, nameEl);

    if (user.muted) {
      const muted = createElement("span", { class: "vu-muted" }, "\uD83D\uDD07");
      row.appendChild(muted);
    }

    return row;
  }

  function createControlButton(
    label: string,
    icon: string,
    handler: () => void,
    extraClass?: string,
  ): HTMLButtonElement {
    const btn = createElement("button", {
      class: extraClass ?? "",
      "aria-label": label,
    }, icon);
    btn.addEventListener("click", handler, { signal: ac.signal });
    return btn;
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "voice-widget", "data-testid": "voice-widget" });

    const header = createElement("div", { class: "vw-header" });
    const connLabel = createElement("span", { class: "vw-connected" }, "Voice Connected");
    channelNameEl = createElement("span", { class: "vw-channel" }, "Voice Channel");
    appendChildren(header, connLabel, channelNameEl);

    usersContainer = createElement("div", { class: "voice-users-list" });

    const controls = createElement("div", { class: "vw-controls" });
    muteBtn = createControlButton("Mute", "\uD83C\uDFA4", options.onMuteToggle);
    deafenBtn = createControlButton("Deafen", "\uD83C\uDFA7", options.onDeafenToggle);
    const cameraBtn = createControlButton("Camera", "\uD83D\uDCF7", options.onCameraToggle);
    const shareBtn = createControlButton("Screenshare", "\uD83D\uDDA5", options.onScreenshareToggle);
    const disconnectBtn = createControlButton(
      "Disconnect", "\u260E", options.onDisconnect, "disconnect",
    );
    appendChildren(controls, muteBtn, deafenBtn, cameraBtn, shareBtn, disconnectBtn);

    appendChildren(root, header, usersContainer, controls);

    render();

    unsubs.push(voiceStore.subscribe(() => render()));
    unsubs.push(channelsStore.subscribe(() => render()));
    unsubs.push(membersStore.subscribe(() => render()));

    container.appendChild(root);
  }

  function destroy(): void {
    ac.abort();
    for (const unsub of unsubs) {
      unsub();
    }
    unsubs.length = 0;
    root?.remove();
    root = null;
    channelNameEl = null;
    usersContainer = null;
    muteBtn = null;
    deafenBtn = null;
  }

  return { mount, destroy };
}

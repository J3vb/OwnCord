/**
 * VoiceWidget component — shows active voice channel info with controls.
 * Hidden when not connected to a voice channel.
 * Users are displayed under the voice channel in the sidebar, NOT here.
 * Step 6.50
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { voiceStore } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";

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
  let muteBtn: HTMLButtonElement | null = null;
  let deafenBtn: HTMLButtonElement | null = null;
  let cameraBtn: HTMLButtonElement | null = null;

  const unsubs: Array<() => void> = [];

  function render(): void {
    if (root === null || channelNameEl === null) return;

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
    cameraBtn?.classList.toggle("active-ctrl", voice.localCamera);
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

    const controls = createElement("div", { class: "vw-controls" });
    muteBtn = createControlButton("Mute", "\uD83C\uDFA4", options.onMuteToggle);
    deafenBtn = createControlButton("Deafen", "\uD83C\uDFA7", options.onDeafenToggle);
    cameraBtn = createControlButton("Camera", "\uD83D\uDCF7", options.onCameraToggle);
    const shareBtn = createControlButton("Screenshare", "\uD83D\uDDA5", options.onScreenshareToggle);
    const disconnectBtn = createControlButton(
      "Disconnect", "\u260E", options.onDisconnect, "disconnect",
    );
    appendChildren(controls, muteBtn, deafenBtn, cameraBtn, shareBtn, disconnectBtn);

    appendChildren(root, header, controls);

    render();

    unsubs.push(voiceStore.subscribe(() => render()));
    unsubs.push(channelsStore.subscribe(() => render()));

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
    muteBtn = null;
    deafenBtn = null;
    cameraBtn = null;
  }

  return { mount, destroy };
}

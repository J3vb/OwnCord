/**
 * VoiceWidget component — shows active voice channel info with controls.
 * Hidden when not connected to a voice channel.
 * Users are displayed under the voice channel in the sidebar, NOT here.
 * Step 6.50
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
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
  let shareBtn: HTMLButtonElement | null = null;

  const unsubs: Array<() => void> = [];

  function swapIcon(btn: HTMLButtonElement, name: IconName): void {
    const existing = btn.querySelector("svg");
    if (existing) existing.remove();
    btn.appendChild(createIcon(name, 18));
  }

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

    // Toggle button active states, swap icons, and update aria-pressed
    muteBtn?.classList.toggle("active-ctrl", voice.localMuted);
    deafenBtn?.classList.toggle("active-ctrl", voice.localDeafened);
    cameraBtn?.classList.toggle("active-ctrl", voice.localCamera);

    if (muteBtn) { swapIcon(muteBtn, voice.localMuted ? "mic-off" : "mic"); muteBtn.setAttribute("aria-pressed", String(voice.localMuted)); }
    if (deafenBtn) { swapIcon(deafenBtn, voice.localDeafened ? "headphones-off" : "headphones"); deafenBtn.setAttribute("aria-pressed", String(voice.localDeafened)); }
    if (cameraBtn) { swapIcon(cameraBtn, voice.localCamera ? "camera-off" : "camera"); cameraBtn.setAttribute("aria-pressed", String(voice.localCamera)); }
    shareBtn?.classList.toggle("active-ctrl", voice.localScreenshare);
    if (shareBtn) { swapIcon(shareBtn, voice.localScreenshare ? "monitor-off" : "monitor"); shareBtn.setAttribute("aria-pressed", String(voice.localScreenshare)); }
  }

  function createControlButton(
    label: string,
    icon: IconName,
    handler: () => void,
    extraClass?: string,
  ): HTMLButtonElement {
    const btn = createElement("button", {
      class: extraClass ?? "",
      "aria-label": label,
    });
    btn.appendChild(createIcon(icon, 18));
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
    muteBtn = createControlButton("Mute", "mic", options.onMuteToggle);
    deafenBtn = createControlButton("Deafen", "headphones", options.onDeafenToggle);
    cameraBtn = createControlButton("Camera", "camera", options.onCameraToggle);
    shareBtn = createControlButton("Screenshare", "monitor", options.onScreenshareToggle);
    const disconnectBtn = createControlButton(
      "Disconnect", "phone", options.onDisconnect, "disconnect",
    );
    appendChildren(controls, muteBtn, deafenBtn, cameraBtn, shareBtn, disconnectBtn);

    appendChildren(root, header, controls);

    render();

    unsubs.push(voiceStore.subscribeSelector(
      (s) => ({
        channelId: s.currentChannelId,
        muted: s.localMuted,
        deafened: s.localDeafened,
        camera: s.localCamera,
        screenshare: s.localScreenshare,
      }),
      () => render(),
      (a, b) =>
        a.channelId === b.channelId &&
        a.muted === b.muted &&
        a.deafened === b.deafened &&
        a.camera === b.camera &&
        a.screenshare === b.screenshare,
    ));
    unsubs.push(channelsStore.subscribeSelector(
      (s) => s.channels,
      () => render(),
    ));

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
    shareBtn = null;
  }

  return { mount, destroy };
}

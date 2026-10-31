/**
 * PhoneCallBar — the call you are in, under the chat header, on a phone.
 *
 * Joining a call closes the drawer, which holds the voice widget, so nothing
 * else on screen would say you are still in it. The bar shows who is there,
 * how long, and Mute and Leave; the rest of it opens the call. It steps aside
 * while the call view is up and while you are looking at your own DM call (both
 * have their own controls), and off a phone.
 *
 * Mute and Leave are the voice widget's own callbacks, so the rate limits and
 * the moderator guards are the same. The timer runs only while the bar shows.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setText, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
import type { MountableComponent } from "@lib/text/safeRender";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { voiceStore } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";
import { voiceText as t } from "../i18n/voice";
import {
  formatElapsed,
  headerStatusText,
  isConnecting,
  micControlKey,
  micControlState,
} from "./voiceStatusText";
import { callParticipants, participantAvatar, participantKey } from "./callParticipants";

export interface PhoneCallBarOptions {
  /** The call view's grid is up in this window. */
  isGridUp(): boolean;
  onMuteToggle(): void;
  onLeave(): void;
  /** Open the call's channel: its DM, or the call view of a guild voice channel. */
  onOpenCall(channelId: number): void;
}

export interface PhoneCallBar extends MountableComponent {
  /** Re-decide whether the bar shows (the call view opened or closed). */
  refresh(): void;
}

const MAX_AVATARS = 3;

/** The second line: the call's status while it connects, else who and how long. */
function detailText(count: number): string {
  const voice = voiceStore.getState();
  const status = voice.voiceStatus;
  if (isConnecting(status) || status === "reconnecting") return headerStatusText(status);
  const elapsed = voice.joinedAt === null ? 0 : Math.max(0, Date.now() - voice.joinedAt);
  return t("callBar.detail", {
    // You are in it, even before your own voice_state has landed.
    people: t("callBar.people", { count: Math.max(1, count) }),
    time: formatElapsed(elapsed),
  });
}

export function createPhoneCallBar(options: PhoneCallBarOptions): PhoneCallBar {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;
  let avatarsEl: HTMLSpanElement;
  let nameEl: HTMLSpanElement;
  let detailEl: HTMLSpanElement;
  let openBtn: HTMLButtonElement;
  let muteBtn: HTMLButtonElement;
  let avatarsKey = "";
  let muteIcon: IconName | null = null;
  let openChannelId: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function stopTimer(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function startTimer(): void {
    if (timer !== null) return;
    timer = setInterval(update, 1000);
  }

  function update(): void {
    if (root === null) return;
    const voice = voiceStore.getState();
    const channelId = voice.currentChannelId;
    // A DM call resolves through the DM store, as the voice widget does: the
    // channels-store row for a DM only exists once the conversation was opened.
    const dm =
      channelId === null
        ? undefined
        : dmStore.getState().channels.find((c) => c.channelId === channelId);
    // The DM's call panel (its own mute, camera and leave controls) is on
    // screen whenever that DM is the open channel and you are in its call.
    const dmPanelUp = dm !== undefined && channelsStore.getState().activeChannelId === channelId;
    const show = channelId !== null && isPhoneLayout() && !options.isGridUp() && !dmPanelUp;
    root.hidden = !show;
    if (!show || channelId === null) {
      stopTimer();
      openChannelId = null;
      return;
    }
    startTimer();
    openChannelId = channelId;

    const channel = channelsStore.getState().channels.get(channelId);
    const name =
      dm !== undefined ? dmDisplayName(dm) : (channel?.name ?? t("widget.channelFallback"));
    setText(nameEl, name);
    openBtn.setAttribute("aria-label", t("callBar.open", { name }));
    // A call whose channel is not known yet has nowhere to open.
    openBtn.disabled = dm === undefined && channel?.type !== "voice";

    const people = callParticipants(channelId);
    const shown = people.slice(0, MAX_AVATARS);
    const key = shown.map(participantKey).join(",");
    if (key !== avatarsKey) {
      avatarsKey = key;
      clearChildren(avatarsEl);
      for (const person of shown) {
        avatarsEl.appendChild(participantAvatar(person, "pcb-avatar"));
      }
    }
    const detail = detailText(people.length);
    if (detailEl.textContent !== detail) setText(detailEl, detail);

    const mic = micControlState(voice);
    const icon: IconName = mic.micOff ? "mic-off" : "mic";
    if (icon !== muteIcon) {
      muteIcon = icon;
      clearChildren(muteBtn);
      muteBtn.appendChild(createIcon(icon, 20));
    }
    muteBtn.classList.toggle("active-ctrl", mic.userMuted);
    muteBtn.setAttribute("aria-pressed", String(mic.pressed));
    muteBtn.setAttribute("aria-label", mic.title);
    muteBtn.title = mic.title;
    muteBtn.disabled = mic.disabled;
  }

  function mount(container: Element): void {
    root = createElement("div", {
      class: "phone-call-bar",
      role: "region",
      "aria-label": t("callBar.region"),
      "data-testid": "phone-call-bar",
    });
    root.hidden = true;

    avatarsEl = createElement("span", { class: "pcb-avatars", "aria-hidden": "true" });
    nameEl = createElement("span", { class: "pcb-name", "data-testid": "pcb-name" });
    detailEl = createElement("span", { class: "pcb-detail", "data-testid": "pcb-detail" });
    const text = createElement("span", { class: "pcb-text" });
    appendChildren(text, nameEl, detailEl);
    openBtn = createElement("button", {
      type: "button",
      class: "pcb-open",
      "data-testid": "pcb-open",
    });
    appendChildren(openBtn, avatarsEl, text);
    disposable.onEvent(openBtn, "click", () => {
      if (openChannelId !== null) options.onOpenCall(openChannelId);
    });

    muteBtn = createElement("button", {
      type: "button",
      class: "pcb-btn pcb-mute",
      "data-testid": "pcb-mute",
    });
    disposable.onEvent(muteBtn, "click", () => options.onMuteToggle());
    const leaveBtn = createElement("button", {
      type: "button",
      class: "pcb-btn pcb-leave",
      "aria-label": t("callBar.leave"),
      title: t("callBar.leave"),
      "data-testid": "pcb-leave",
    });
    leaveBtn.appendChild(createIcon("phone-off", 20));
    disposable.onEvent(leaveBtn, "click", () => options.onLeave());

    appendChildren(root, openBtn, muteBtn, leaveBtn);
    container.appendChild(root);

    disposable.onStoreChange(
      voiceStore,
      (s) =>
        [
          s.currentChannelId,
          s.voiceStatus,
          s.joinedAt,
          micControlKey(s),
          s.currentChannelId === null
            ? ""
            : Array.from(s.voiceUsers.get(s.currentChannelId)?.keys() ?? []).join(","),
        ].join("|"),
      update,
    );
    disposable.onStoreChange(membersStore, (s) => s.members, update);
    disposable.onStoreChange(dmStore, (s) => s.channels, update);
    disposable.onStoreChange(channelsStore, (s) => s.channels, update);
    // Opening or leaving the DM of your call brings its panel up or down.
    disposable.onStoreChange(channelsStore, (s) => s.activeChannelId, update);
    // Rotation and resizing move the window across the phone breakpoint.
    disposable.onEvent(window, "resize", update);
    disposable.addCleanup(stopTimer);
    update();
  }

  return {
    mount,
    refresh: update,
    destroy: () => {
      disposable.destroy();
      root?.remove();
      root = null;
    },
  };
}

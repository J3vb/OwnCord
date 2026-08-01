/**
 * Notifications settings tab — desktop notifications, taskbar flash, sounds.
 */

import { createElement, appendChildren, clearChildren, setText } from "@lib/dom";
import { loadPref, savePref, createToggle } from "./helpers";
import { listMutedChannels, unmuteChannel } from "@lib/channel-mutes";
import { channelsStore } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";

export function buildNotificationsTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });

  const toggles: ReadonlyArray<{ key: string; label: string; desc: string; fallback: boolean }> = [
    {
      key: "desktopNotifications",
      label: "Desktop Notifications",
      desc: "Show desktop notifications for messages",
      fallback: true,
    },
    {
      key: "flashTaskbar",
      label: "Flash Taskbar",
      desc: "Flash taskbar on new messages",
      fallback: true,
    },
    {
      key: "suppressEveryone",
      label: "Suppress @everyone",
      desc: "Mute @everyone and @here — messages that name you still notify",
      fallback: false,
    },
    {
      key: "notificationSounds",
      label: "Notification Sounds",
      desc: "Play sounds for notifications",
      fallback: true,
    },
  ];

  for (const item of toggles) {
    const row = createElement("div", { class: "setting-row" });
    const info = createElement("div", {});
    const label = createElement("div", { class: "setting-label" }, item.label);
    const desc = createElement("div", { class: "setting-desc" }, item.desc);
    appendChildren(info, label, desc);

    const isOn = loadPref<boolean>(item.key, item.fallback);
    const toggle = createToggle(isOn, {
      signal,
      onChange: (nowOn) => {
        savePref(item.key, nowOn);
      },
    });

    appendChildren(row, info, toggle);
    section.appendChild(row);
  }

  section.appendChild(buildMutedChannelsSection(signal));
  return section;
}

/** Best name available for a muted id: a channel, a DM, or neither. */
function mutedChannelName(channelId: number): string {
  const ch = channelsStore.getState().channels.get(channelId);
  if (ch !== undefined && ch.type !== "dm") return `#${ch.name}`;
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  if (dm !== undefined) return `@${dmDisplayName(dm)}`;
  // A mute can outlive the channel it names (deleted channel, left group). It
  // is shown rather than hidden so the user can clear it.
  return `Channel ${channelId}`;
}

/**
 * The muted-channel list.
 *
 * Mutes are set from a right-click on a row, which makes them easy to set and
 * easy to forget — a channel muted six weeks ago is silent for a reason nobody
 * remembers. This is the one place that answers "what have I silenced", and
 * the only place to undo it without finding the row again.
 */
function buildMutedChannelsSection(signal: AbortSignal): HTMLDivElement {
  const wrapper = createElement("div", { class: "setting-row", style: "display:block;" });
  const label = createElement("div", { class: "setting-label" }, "Muted Channels");
  const desc = createElement(
    "div",
    { class: "setting-desc" },
    "Muted channels never notify you, but messages that mention you still do.",
  );
  const list = createElement("div", {
    class: "settings-muted-list",
    "data-testid": "muted-channel-list",
  });
  appendChildren(wrapper, label, desc, list);

  function render(): void {
    clearChildren(list);
    const muted = listMutedChannels();
    if (muted.length === 0) {
      list.appendChild(
        createElement(
          "div",
          { class: "setting-desc", "data-testid": "muted-empty" },
          "Nothing is muted.",
        ),
      );
      return;
    }
    for (const channelId of muted) {
      const row = createElement("div", { class: "settings-muted-row" });
      const name = createElement("span", { class: "settings-muted-name" });
      setText(name, mutedChannelName(channelId));
      const btn = createElement(
        "button",
        {
          class: "btn btn-secondary",
          type: "button",
          "data-testid": `unmute-${channelId}`,
        },
        "Unmute",
      );
      btn.addEventListener(
        "click",
        () => {
          unmuteChannel(channelId);
          render();
        },
        { signal },
      );
      appendChildren(row, name, btn);
      list.appendChild(row);
    }
  }

  render();
  return wrapper;
}

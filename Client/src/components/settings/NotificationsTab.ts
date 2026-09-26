/**
 * Notifications settings tab — desktop notifications, taskbar flash, sounds.
 */

import { createElement, appendChildren, clearChildren, setText } from "@lib/dom";
import { appendToggleRows } from "./helpers";
import { listMutedChannels, unmuteChannel } from "@lib/channel-mutes";
import { channelsStore } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { desktop } from "../../platform/desktop";
import { settingsText as t } from "../../i18n/settings";

export function buildNotificationsTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });

  // The OS permission the toggles below are gated on, read from the native
  // notifier (the desktop contract) rather than assumed from a user-agent or
  // a browser API. A denied permission makes "Desktop Notifications" a switch
  // that cannot do anything, so the panel says so and offers the one action
  // that can change it.
  section.appendChild(buildPermissionRow(signal));

  const toggles: ReadonlyArray<{ key: string; label: string; desc: string; fallback: boolean }> = [
    {
      key: "desktopNotifications",
      label: t("notifications.desktop.label"),
      desc: t("notifications.desktop.desc"),
      fallback: true,
    },
    {
      key: "flashTaskbar",
      label: t("notifications.flash.label"),
      desc: t("notifications.flash.desc"),
      fallback: true,
    },
    {
      key: "suppressEveryone",
      label: t("notifications.suppress.label"),
      desc: t("notifications.suppress.desc"),
      fallback: false,
    },
    {
      key: "notificationSounds",
      label: t("notifications.sounds.label"),
      desc: t("notifications.sounds.desc"),
      fallback: true,
    },
  ];

  appendToggleRows(section, toggles, signal);

  section.appendChild(buildMutedChannelsSection(signal));
  return section;
}

/**
 * The OS notification-permission row.
 *
 * Its states come from the real notifier contract (`permissionGranted` /
 * `requestPermission`), not from a user-agent guess: `denied` means the OS
 * refuses notifications and the "Desktop Notifications" toggle cannot change
 * that, so it offers the one action that can re-ask; `unavailable` means this
 * build has no native notifier at all (a non-Tauri host), which is a different
 * limitation and gets different wording. A notifier that cannot observe the OS
 * setting (`readsOsPermission` false — the Tauri desktop plugin always answers
 * "granted") gets wording that says so instead of a granted claim, and no
 * Allow action, since asking it changes nothing.
 */
function buildPermissionRow(signal: AbortSignal): HTMLDivElement {
  const row = createElement("div", {
    class: "setting-row",
    "data-testid": "notification-permission-row",
  });
  const info = createElement("div", {});
  const label = createElement(
    "div",
    { class: "setting-label" },
    t("notifications.permission.label"),
  );
  const desc = createElement("div", { class: "setting-desc" });
  const actionWrap = createElement("div", {});
  appendChildren(info, label, desc);

  const allow = createElement(
    "button",
    { class: "ac-btn", type: "button", "data-testid": "notification-permission-allow" },
    t("notifications.permission.allow"),
  );
  allow.hidden = true;
  actionWrap.appendChild(allow);
  appendChildren(row, info, actionWrap);

  function setState(text: string): void {
    setText(desc, text);
  }

  function showGranted(): void {
    setState(t("notifications.permission.granted"));
    allow.hidden = true;
  }

  function showDenied(): void {
    setState(t("notifications.permission.denied"));
    allow.hidden = false;
  }

  allow.addEventListener(
    "click",
    () => {
      allow.disabled = true;
      void desktop.notifier
        .requestPermission()
        .then((granted) => {
          if (granted) showGranted();
          else showDenied();
        })
        .catch(() => {
          // No native notifier to ask. Say the limitation instead of leaving a
          // button that can never succeed.
          setState(t("notifications.permission.unavailable"));
          allow.hidden = true;
        })
        .finally(() => {
          allow.disabled = false;
        });
    },
    { signal },
  );

  void desktop.notifier.permissionGranted().then(
    (granted) => {
      if (!desktop.notifier.readsOsPermission) {
        setState(t("notifications.permission.unknown"));
        allow.hidden = true;
      } else if (granted) showGranted();
      else showDenied();
    },
    () => {
      // The notifier itself is absent (non-Tauri host): a real limitation,
      // not a denial, and no Allow action can fix it.
      setState(t("notifications.permission.unavailable"));
      allow.hidden = true;
    },
  );

  return row;
}

/** Best name available for a muted id: a channel, a DM, or neither. */
function mutedChannelName(channelId: number): string {
  const ch = channelsStore.getState().channels.get(channelId);
  if (ch !== undefined && ch.type !== "dm") return `#${ch.name}`;
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  if (dm !== undefined) return `@${dmDisplayName(dm)}`;
  // A mute can outlive the channel it names (deleted channel, left group). It
  // is shown rather than hidden so the user can clear it.
  // i18n-exempt: a numeric channel id, formatted as a plain string so it is not thousands-grouped
  return t("notifications.channelFallback", { id: String(channelId) });
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
  const label = createElement("div", { class: "setting-label" }, t("notifications.muted.title"));
  const desc = createElement("div", { class: "setting-desc" }, t("notifications.muted.desc"));
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
          t("notifications.muted.empty"),
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
        t("notifications.muted.unmute"),
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

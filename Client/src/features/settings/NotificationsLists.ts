/** Notifications tab lists: channels with their own notification level, and muted channels. */

import { createElement, appendChildren, clearChildren, setText } from "@lib/dom";
import {
  CHANNEL_MUTE_CHANGED,
  getChannelMute,
  listMutedChannels,
  unmuteChannel,
} from "@lib/prefs/channelMutes";
import { Disposable } from "@lib/disposable";
import { clockAndDate } from "../channels/muteMenu";
import {
  listChannelNotificationOverrides,
  setChannelNotificationLevel,
  type NotificationLevel,
} from "@lib/prefs/notificationLevel";
import { channelsStore } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { settingsText as t } from "../../i18n/settings";
import { onPrefChange } from "@lib/prefs/preferences";

export const LEVEL_LABELS: Readonly<Record<NotificationLevel, () => string>> = {
  all: () => t("notifications.level.all"),
  mentions: () => t("notifications.level.mentions"),
  nothing: () => t("notifications.level.nothing"),
};

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
 * The channels that carry their own notification level. Set from a right-click
 * on a row, so as easy to forget as a mute; Reset hands the channel back to the
 * server level.
 */
export function buildChannelLevelsSection(signal: AbortSignal): HTMLDivElement {
  const wrapper = createElement("div", { class: "setting-row stacked" });
  const list = createElement("div", {
    class: "settings-muted-list",
    "data-testid": "channel-level-list",
    tabindex: "-1",
  });
  appendChildren(
    wrapper,
    createElement("div", { class: "setting-label" }, t("notifications.channelLevels.title")),
    createElement("div", { class: "setting-desc" }, t("notifications.channelLevels.desc")),
    list,
  );

  let rows = new Disposable();
  signal.addEventListener("abort", () => rows.destroy(), { once: true });
  let drawnKey: string | null = null;
  let drawn: readonly number[] = [];

  function render(): void {
    if (signal.aborted) return;
    const overrides = listChannelNotificationOverrides();
    const key = [...overrides].map(([id, level]) => `${id}:${level}`).join(",");
    if (key === drawnKey) return;
    drawnKey = key;

    // Where focus was, so a removed Reset button hands it on instead of
    // dropping it to <body> (same hand-off as the muted list).
    const active = document.activeElement;
    const focusedId = list.contains(active)
      ? (drawn.find((id) => active?.getAttribute("data-testid") === `channel-level-reset-${id}`) ??
        null)
      : null;
    const before = drawn;
    drawn = [...overrides.keys()];
    if (focusedId !== null) {
      const at = before.indexOf(focusedId);
      const next =
        before.slice(at + 1).find((id) => overrides.has(id)) ??
        before
          .slice(0, at)
          .toReversed()
          .find((id) => overrides.has(id));
      queueMicrotask(() => {
        if (signal.aborted || list.contains(document.activeElement)) return;
        const target =
          next === undefined
            ? list
            : (list.querySelector<HTMLElement>(`[data-testid="channel-level-reset-${next}"]`) ??
              list);
        target.focus();
      });
    }
    rows.destroy();
    rows = new Disposable();
    clearChildren(list);
    if (overrides.size === 0) {
      list.appendChild(
        createElement(
          "div",
          { class: "setting-desc", "data-testid": "channel-level-empty" },
          t("notifications.channelLevels.empty"),
        ),
      );
      return;
    }
    for (const [channelId, level] of overrides) {
      const row = createElement("div", { class: "settings-muted-row" });
      const name = createElement("span", { class: "settings-muted-name" });
      setText(name, mutedChannelName(channelId));
      const btn = createElement(
        "button",
        {
          class: "btn btn-secondary",
          type: "button",
          "data-testid": `channel-level-reset-${channelId}`,
          "aria-label": t("notifications.channelLevels.resetLabel", {
            name: mutedChannelName(channelId),
          }),
        },
        t("notifications.channelLevels.reset"),
      );
      btn.addEventListener("click", () => setChannelNotificationLevel(channelId, null), {
        signal: rows.signal,
      });
      appendChildren(
        row,
        name,
        createElement(
          "span",
          { class: "settings-muted-until", "data-testid": `channel-level-${channelId}` },
          LEVEL_LABELS[level](),
        ),
        btn,
      );
      list.appendChild(row);
    }
  }

  render();
  // Every write announces itself as a pref change, including one from a menu
  // while this tab is open.
  onPrefChange("any", render, signal);
  window.addEventListener("storage", render, { signal });
  return wrapper;
}

/**
 * The muted-channel list.
 *
 * Mutes are set from a right-click on a row, which makes them easy to set and
 * easy to forget — a channel muted six weeks ago is silent for a reason nobody
 * remembers. This is the one place that answers "what have I silenced", and
 * the only place to undo it without finding the row again.
 */
export function buildMutedChannelsSection(signal: AbortSignal): HTMLDivElement {
  const wrapper = createElement("div", { class: "setting-row stacked" });
  const label = createElement("div", { class: "setting-label" }, t("notifications.muted.title"));
  const desc = createElement("div", { class: "setting-desc" }, t("notifications.muted.desc"));
  const list = createElement("div", {
    class: "settings-muted-list",
    "data-testid": "muted-channel-list",
    tabindex: "-1",
  });
  appendChildren(wrapper, label, desc, list);

  // Each draw owns its rows' listeners, so a redrawn button is released.
  let rows = new Disposable();
  signal.addEventListener("abort", () => rows.destroy(), { once: true });
  let drawn: readonly number[] = [];
  let drawnKey: string | null = null;

  function render(): void {
    if (signal.aborted) return;
    const muted = listMutedChannels();
    // Nothing changed (a burst of events, or the click that already drew).
    const key = muted.map((id) => `${id}:${getChannelMute(id)?.until ?? ""}`).join(",");
    if (key === drawnKey) return;
    drawnKey = key;

    // Where focus was, so a removed Unmute button hands it on instead of
    // dropping it to <body>.
    const active = document.activeElement;
    const focusedId = list.contains(active)
      ? (drawn.find((id) => active?.getAttribute("data-testid") === `unmute-${id}`) ?? null)
      : null;
    const before = drawn;
    drawn = muted;

    rows.destroy();
    rows = new Disposable();
    clearChildren(list);
    if (focusedId !== null) {
      const at = before.indexOf(focusedId);
      const next =
        before.slice(at + 1).find((id) => muted.includes(id)) ??
        before
          .slice(0, at)
          .toReversed()
          .find((id) => muted.includes(id));
      queueMicrotask(() => {
        if (signal.aborted || list.contains(document.activeElement)) return;
        const target =
          next === undefined
            ? list
            : (list.querySelector<HTMLElement>(`[data-testid="unmute-${next}"]`) ?? list);
        target.focus();
      });
    }
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
      const until = getChannelMute(channelId)?.until ?? null;
      let untilEl: HTMLElement | null = null;
      if (until !== null) {
        const { time, date } = clockAndDate(until);
        untilEl = createElement(
          "span",
          { class: "settings-muted-until", "data-testid": `muted-until-${channelId}` },
          date === null
            ? t("notifications.muted.until", { time })
            : t("notifications.muted.untilDate", { date, time }),
        );
      }
      const btn = createElement(
        "button",
        {
          class: "btn btn-secondary",
          type: "button",
          "data-testid": `unmute-${channelId}`,
          "aria-label": t("notifications.muted.unmuteLabel", { name: mutedChannelName(channelId) }),
        },
        t("notifications.muted.unmute"),
      );
      btn.addEventListener(
        "click",
        () => {
          unmuteChannel(channelId);
          render();
        },
        { signal: rows.signal },
      );
      appendChildren(row, name);
      if (untilEl !== null) row.appendChild(untilEl);
      row.appendChild(btn);
      list.appendChild(row);
    }
  }

  render();
  // A timed mute ends (or is changed from a menu) while this tab is open. One
  // prune that ends several mutes announces once per id; redraw once per burst.
  let pending = false;
  window.addEventListener(
    CHANNEL_MUTE_CHANGED,
    () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        render();
      });
    },
    { signal },
  );
  return wrapper;
}

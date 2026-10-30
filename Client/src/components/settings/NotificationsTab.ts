/**
 * Notifications settings tab — desktop notifications, taskbar flash, sounds.
 */

import { createElement, appendChildren, clearChildren, setText } from "@lib/dom";
import { appendToggleRows, savePref } from "./helpers";
import { playNotificationSound } from "@lib/notificationSound";
import {
  APP_SOUNDS_VOLUME_KEY,
  SOUND_SWITCH_KEYS,
  loadAppSoundsGain,
  type SoundSwitch,
} from "@lib/prefs/soundPrefs";
import { setStatusIcon, statusIcon, type StatusKind } from "../../features/settings/status";
import {
  CHANNEL_MUTE_CHANGED,
  getChannelMute,
  getChannelMutesHost,
  listMutedChannels,
  unmuteChannel,
} from "@lib/prefs/channelMutes";
import { Disposable } from "@lib/disposable";
import { clockAndDate } from "../muteMenu";
import {
  NOTIFICATION_LEVELS,
  getGlobalNotificationLevel,
  getServerNotificationLevel,
  setGlobalNotificationLevel,
  setServerNotificationLevel,
  clearServerNotificationLevel,
  listChannelNotificationOverrides,
  setChannelNotificationLevel,
  type NotificationLevel,
} from "@lib/prefs/notificationLevel";
import { setRovingTabindex, enableRovingNavigation } from "@lib/a11y";
import { channelsStore } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { desktop } from "../../platform/desktop";
import { settingsText as t } from "../../i18n/settings";
import { onPrefChange } from "@lib/prefs/preferences";

const LEVEL_LABELS: Readonly<Record<NotificationLevel, () => string>> = {
  all: () => t("notifications.level.all"),
  mentions: () => t("notifications.level.mentions"),
  nothing: () => t("notifications.level.nothing"),
};

/**
 * The notification level row: All / Mentions only / Nothing.
 *
 * A radiogroup in the row shape the tab already uses, rather than a `<select>`
 * — three options are all visible at once and each is one keystroke away.
 */
function buildLevelRow(signal: AbortSignal): HTMLDivElement {
  const row = createElement("div", { class: "setting-row" });
  const info = createElement("div", {});
  appendChildren(
    info,
    createElement("div", { class: "setting-label" }, t("notifications.level.label")),
    createElement("div", { class: "setting-desc" }, t("notifications.level.desc")),
  );

  const group = createElement("div", {
    class: "level-options",
    role: "radiogroup",
    "aria-label": t("notifications.level.label"),
    "data-testid": "notification-level",
  });

  const buttons = new Map<NotificationLevel, HTMLButtonElement>();
  const paint = (): void => {
    const current = getGlobalNotificationLevel();
    for (const [level, button] of buttons) {
      const on = level === current;
      button.classList.toggle("active", on);
      button.setAttribute("aria-checked", String(on));
    }
  };
  const choose = (level: NotificationLevel): void => {
    setGlobalNotificationLevel(level);
    paint();
  };

  for (const level of NOTIFICATION_LEVELS) {
    const button = createElement(
      "button",
      {
        class: "level-opt",
        type: "button",
        role: "radio",
        "aria-checked": "false",
        tabindex: "-1",
        "data-testid": `notification-level-${level}`,
      },
      LEVEL_LABELS[level](),
    );
    button.addEventListener("click", () => choose(level), { signal });
    // Enter/Space are handled by the roving navigation below (so keyboard and
    // mouse share the click path), matching the theme tiles in Appearance.
    buttons.set(level, button);
    group.appendChild(button);
  }
  paint();
  setRovingTabindex(group, "[role='radio']");
  enableRovingNavigation(group, "[role='radio']", signal);

  appendChildren(row, info, group);
  return row;
}

/**
 * The connected server's override of the global level, shown only while
 * connected. "Follow global setting" clears the override; the three levels set
 * an explicit value, so one noisy community can be quieted without muting every
 * other server. Stored against the host (see @lib/prefs/notificationLevel), so the
 * choice returns when you switch back.
 */
function buildServerLevelRow(signal: AbortSignal): HTMLDivElement | null {
  if (getChannelMutesHost() === null) return null;
  const row = createElement("div", {
    class: "setting-row",
    "data-testid": "server-notification-level-row",
  });
  const info = createElement("div", {});
  appendChildren(
    info,
    createElement("div", { class: "setting-label" }, t("notifications.serverLevel.label")),
    createElement("div", { class: "setting-desc" }, t("notifications.serverLevel.desc")),
  );

  const select = createElement("select", {
    class: "form-input",
    "aria-label": t("notifications.serverLevel.label"),
    "data-testid": "server-notification-level",
  });
  const options: ReadonlyArray<{ value: string; label: string }> = [
    { value: "", label: t("notifications.serverLevel.follow") },
    ...NOTIFICATION_LEVELS.map((level) => ({ value: level, label: LEVEL_LABELS[level]() })),
  ];
  for (const { value, label } of options) {
    select.appendChild(createElement("option", { value }, label));
  }
  select.value = getServerNotificationLevel() ?? "";
  select.addEventListener(
    "change",
    () => {
      if (select.value === "") clearServerNotificationLevel();
      else setServerNotificationLevel(select.value as NotificationLevel);
    },
    { signal },
  );

  appendChildren(row, info, select);
  return row;
}

/** Label and description of each per-sound switch. */
const SOUND_SWITCH_TEXT: Readonly<
  Record<SoundSwitch, { label: () => string; desc: () => string }>
> = {
  message: {
    label: () => t("notifications.sound.message.label"),
    desc: () => t("notifications.sound.message.desc"),
  },
  mention: {
    label: () => t("notifications.sound.mention.label"),
    desc: () => t("notifications.sound.mention.desc"),
  },
  ring: {
    label: () => t("notifications.sound.ring.label"),
    desc: () => t("notifications.sound.ring.desc"),
  },
  ringback: {
    label: () => t("notifications.sound.ringback.label"),
    desc: () => t("notifications.sound.ringback.desc"),
  },
  joinLeave: {
    label: () => t("notifications.sound.joinLeave.label"),
    desc: () => t("notifications.sound.joinLeave.desc"),
  },
  muteDeafen: {
    label: () => t("notifications.sound.muteDeafen.label"),
    desc: () => t("notifications.sound.muteDeafen.desc"),
  },
  stream: {
    label: () => t("notifications.sound.stream.label"),
    desc: () => t("notifications.sound.stream.desc"),
  },
};

/** A group switch (its pref key unchanged) followed by its nested per-sound
 *  switches. A sound plays only when both the group and its own switch are on. */
function appendSoundGroup(
  section: HTMLElement,
  group: { key: string; label: string; desc: string },
  sounds: ReadonlyArray<SoundSwitch>,
  signal: AbortSignal,
): void {
  appendToggleRows(section, [{ ...group, fallback: true }], signal);
  const rows = appendToggleRows(
    section,
    sounds.map((sound) => ({
      key: SOUND_SWITCH_KEYS[sound],
      label: SOUND_SWITCH_TEXT[sound].label(),
      desc: SOUND_SWITCH_TEXT[sound].desc(),
      fallback: true,
    })),
    signal,
  );
  for (const row of rows) row.classList.add("nested");
}

/** The slider's value as spoken and shown: a percent. */
function valueText(percent: number): string {
  return t("notifications.volume.value", { percent });
}

/**
 * The "App sounds volume" slider: scales the master gain every app
 * sound shares. 100% is today's level, 0% is silent. The value is saved on
 * every move (the player re-reads it on its next sound); letting go of the
 * thumb plays the message chime once so the level can be judged.
 */
function buildSoundsVolumeRow(signal: AbortSignal): HTMLDivElement {
  const row = createElement("div", { class: "setting-row", style: "display:block;" });
  appendChildren(
    row,
    createElement("div", { class: "setting-label" }, t("notifications.volume.label")),
    createElement("div", { class: "setting-desc" }, t("notifications.volume.desc")),
  );
  const saved = Math.round(loadAppSoundsGain() * 100);
  const slider = createElement("input", {
    class: "settings-slider",
    type: "range",
    min: "0",
    max: "100",
    step: "1",
    value: String(saved),
    "aria-label": t("notifications.volume.label"),
    "aria-valuetext": valueText(saved),
    "data-testid": "app-sounds-volume",
  });
  const readout = createElement("span", { class: "slider-val" }, valueText(saved));
  slider.addEventListener(
    "input",
    () => {
      const percent = Number(slider.value);
      savePref(APP_SOUNDS_VOLUME_KEY, percent);
      slider.setAttribute("aria-valuetext", valueText(percent));
      setText(readout, valueText(percent));
    },
    { signal },
  );
  slider.addEventListener("change", () => playNotificationSound(), { signal });
  const control = createElement("div", { class: "slider-row" });
  appendChildren(control, slider, readout);
  row.appendChild(control);
  return row;
}

export function buildNotificationsTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });

  // The OS permission the toggles below are gated on, read from the native
  // notifier (the desktop contract) rather than assumed from a user-agent or
  // a browser API. A denied permission makes "Desktop Notifications" a switch
  // that cannot do anything, so the panel says so and offers the one action
  // that can change it.
  const permissionRow = buildPermissionRow(signal, (blocked) => {
    // A denied permission makes this switch unable to deliver anything: dim
    // it and say why, but leave it operable (the choice still applies later).
    desktopRow.classList.toggle("blocked", blocked);
    blockedReason.hidden = !blocked;
  });
  section.appendChild(permissionRow);

  section.appendChild(buildLevelRow(signal));
  const serverLevelRow = buildServerLevelRow(signal);
  if (serverLevelRow !== null) section.appendChild(serverLevelRow);

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
      key: "unreadBadge",
      label: t("notifications.unreadBadge.label"),
      desc: t("notifications.unreadBadge.desc"),
      fallback: true,
    },
  ];

  const [desktopRow] = appendToggleRows(section, toggles, signal) as [HTMLDivElement];

  section.appendChild(buildSoundsVolumeRow(signal));

  // Each group switch keeps its pref key; its own sounds follow it, nested.
  appendSoundGroup(
    section,
    {
      key: "notificationSounds",
      label: t("notifications.sounds.label"),
      desc: t("notifications.sounds.desc"),
    },
    ["message", "mention"],
    signal,
  );
  appendSoundGroup(
    section,
    {
      key: "callSounds",
      label: t("notifications.callSound.label"),
      desc: t("notifications.callSound.desc"),
    },
    ["ring", "ringback"],
    signal,
  );
  appendSoundGroup(
    section,
    {
      key: "voiceSounds",
      label: t("notifications.voiceSounds.label"),
      desc: t("notifications.voiceSounds.desc"),
    },
    ["joinLeave", "muteDeafen", "stream"],
    signal,
  );
  const blockedReason = createElement(
    "div",
    { class: "setting-desc setting-blocked-reason" },
    t("notifications.blockedReason"),
  );
  blockedReason.hidden = true;
  desktopRow.querySelector(".setting-desc")!.after(blockedReason);

  section.appendChild(buildMutedChannelsSection(signal));
  section.appendChild(buildChannelLevelsSection(signal));
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
function buildPermissionRow(
  signal: AbortSignal,
  onBlocked: (blocked: boolean) => void,
): HTMLDivElement {
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
  // The state as an icon and one word; the line below only says how to fix it.
  const status = createElement("span", {
    class: "status-pill",
    "data-testid": "notification-permission-status",
  });
  const statusIconEl = statusIcon("pending");
  const statusWord = createElement("span", {});
  status.append(statusIconEl, statusWord);
  status.hidden = true;
  const actionWrap = createElement("div", { class: "setting-actions" });
  appendChildren(info, label, desc);

  const allow = createElement(
    "button",
    { class: "ac-btn", type: "button", "data-testid": "notification-permission-allow" },
    t("notifications.permission.allow"),
  );
  allow.hidden = true;
  appendChildren(actionWrap, status, allow);
  appendChildren(row, info, actionWrap);

  function setState(kind: StatusKind, word: string, text: string): void {
    status.hidden = false;
    setStatusIcon(statusIconEl, kind);
    setText(statusWord, word);
    setText(desc, text);
    desc.hidden = text === "";
    onBlocked(kind === "crit");
  }

  function showGranted(): void {
    setState("ok", t("notifications.permission.allowed"), "");
    allow.hidden = true;
  }

  function showDenied(): void {
    setState("crit", t("notifications.permission.blocked"), t("notifications.permission.denied"));
    allow.hidden = false;
  }

  function showUnavailable(): void {
    setState(
      "pending",
      t("notifications.permission.unavailableState"),
      t("notifications.permission.unavailable"),
    );
    allow.hidden = true;
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
          showUnavailable();
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
        setState(
          "pending",
          t("notifications.permission.unknownState"),
          t("notifications.permission.unknown"),
        );
        allow.hidden = true;
      } else if (granted) showGranted();
      else showDenied();
    },
    () => {
      // The notifier itself is absent (non-Tauri host): a real limitation,
      // not a denial, and no Allow action can fix it.
      showUnavailable();
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
 * The channels that carry their own notification level. Set from a right-click
 * on a row, so as easy to forget as a mute; Reset hands the channel back to the
 * server level.
 */
function buildChannelLevelsSection(signal: AbortSignal): HTMLDivElement {
  const wrapper = createElement("div", { class: "setting-row", style: "display:block;" });
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
function buildMutedChannelsSection(signal: AbortSignal): HTMLDivElement {
  const wrapper = createElement("div", { class: "setting-row", style: "display:block;" });
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

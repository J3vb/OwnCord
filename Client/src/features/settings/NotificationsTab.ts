/**
 * Notifications settings tab — desktop notifications, taskbar flash, sounds.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { appendToggleRows, platformText, savePref } from "./helpers";
import { isAndroidApp } from "../voice/native/platform";
import { playNotificationSound } from "@lib/media/notificationSound";
import {
  APP_SOUNDS_VOLUME_KEY,
  SOUND_STYLE_KEY,
  SOUND_SWITCH_KEYS,
  loadAppSoundsGain,
  loadSoundStyle,
  type SoundStyle,
  type SoundSwitch,
} from "@lib/prefs/soundPrefs";
import { setStatusIcon, statusIcon, type StatusKind } from "./status";
import { getChannelMutesHost } from "@lib/prefs/channelMutes";
import {
  NOTIFICATION_LEVELS,
  getGlobalNotificationLevel,
  getServerNotificationLevel,
  setGlobalNotificationLevel,
  setServerNotificationLevel,
  clearServerNotificationLevel,
  type NotificationLevel,
} from "@lib/prefs/notificationLevel";
import { desktop } from "../../platform/desktop";
import { settingsText as t } from "../../i18n/settings";
import { buildChoiceRow } from "./settingRow";
import {
  LEVEL_LABELS,
  buildChannelLevelsSection,
  buildMutedChannelsSection,
} from "./NotificationsLists";

/** The notification level row: All / Mentions only / Nothing, as one segmented choice. */
function buildLevelRow(signal: AbortSignal): HTMLDivElement {
  return buildChoiceRow<NotificationLevel>({
    signal,
    label: t("notifications.level.label"),
    desc: t("notifications.level.desc"),
    testId: "notification-level",
    options: NOTIFICATION_LEVELS.map((level) => [level, LEVEL_LABELS[level]()]),
    current: getGlobalNotificationLevel,
    save: setGlobalNotificationLevel,
  }).row;
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
  const row = createElement("div", { class: "setting-row stacked" });
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

/** The "Sound style" row: Modern or Classic. Picking one plays the message
 *  sound once in it, as letting go of the volume slider does. */
function buildSoundStyleRow(signal: AbortSignal): HTMLDivElement {
  return buildChoiceRow<SoundStyle>({
    signal,
    label: t("notifications.soundStyle.label"),
    desc: t("notifications.soundStyle.desc"),
    testId: "sound-style",
    options: [
      ["modern", t("notifications.soundStyle.modern")],
      ["classic", t("notifications.soundStyle.classic")],
    ],
    current: loadSoundStyle,
    save: (style) => {
      savePref(SOUND_STYLE_KEY, style);
      playNotificationSound();
    },
  }).row;
}

/** The Android app's push row, under the permission row; it loads on demand. */
function appendPushRow(after: HTMLElement, signal: AbortSignal): void {
  if (!isAndroidApp()) return;
  void import("../push/pushSettingRow").then(
    (m) => {
      if (!signal.aborted) after.after(m.buildPushRow(signal));
    },
    () => undefined,
  );
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
  appendPushRow(permissionRow, signal);

  section.appendChild(buildLevelRow(signal));
  const serverLevelRow = buildServerLevelRow(signal);
  if (serverLevelRow !== null) section.appendChild(serverLevelRow);

  const toggles: ReadonlyArray<{ key: string; label: string; desc: string; fallback: boolean }> = [
    {
      key: "desktopNotifications",
      label: platformText(
        t("notifications.desktop.label"),
        t("notifications.desktop.label.android"),
      ),
      desc: platformText(t("notifications.desktop.desc"), t("notifications.desktop.desc.android")),
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

  // The taskbar flash and the unread badge are desktop features.
  const shownToggles = toggles.filter(
    ({ key }) => !isAndroidApp() || (key !== "flashTaskbar" && key !== "unreadBadge"),
  );
  const [desktopRow] = appendToggleRows(section, shownToggles, signal) as [HTMLDivElement];

  section.appendChild(buildSoundsVolumeRow(signal));
  section.appendChild(buildSoundStyleRow(signal));

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

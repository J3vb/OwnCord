/** Tab names, their icons and labels, and the stable DOM id of a tab button. */

import { settingsText } from "../../i18n/settings";
import type { IconName } from "@lib/icons";

export type TabName =
  | "Account"
  | "Safety"
  | "My uploads"
  | "Appearance"
  | "Accessibility"
  | "Voice & Video"
  | "Text & Images"
  | "Notifications"
  | "Keybinds"
  | "Advanced"
  | "Logs"
  | "About";

export const TAB_ICONS: Record<TabName, IconName> = {
  Account: "user",
  Safety: "shield",
  "My uploads": "image",
  Appearance: "palette",
  Accessibility: "eye",
  "Voice & Video": "mic",
  "Text & Images": "image",
  Notifications: "bell",
  Keybinds: "keyboard",
  Advanced: "settings",
  Logs: "scroll-text",
  About: "file-text",
};

// i18n-exempt: TabName key; its label is settingsText("tabs.safety")
export const SAFETY = "Safety" satisfies TabName;
// i18n-exempt: TabName key; its label is settingsText("tabs.myUploads")
export const MY_UPLOADS = "My uploads" satisfies TabName;
// i18n-exempt: TabName key; its label is settingsText("tabs.keybinds")
export const KEYBINDS = "Keybinds" satisfies TabName;
// i18n-exempt: TabName key; its label is settingsText("tabs.account")
export const ACCOUNT = "Account" satisfies TabName;
// i18n-exempt: TabName key; its label is settingsText("tabs.about")
export const ABOUT = "About" satisfies TabName;

/**
 * What each tab is called on screen.
 * The key order is the nav order: Discord's app-settings order, then the
 * OwnCord-only tabs.
 */
export const TAB_LABEL_KEYS = {
  Account: "tabs.account",
  Safety: "tabs.safety",
  "My uploads": "tabs.myUploads",
  Appearance: "tabs.appearance",
  Accessibility: "tabs.accessibility",
  "Voice & Video": "tabs.voice",
  "Text & Images": "tabs.textImages",
  Notifications: "tabs.notifications",
  Keybinds: "tabs.keybinds",
  Advanced: "tabs.advanced",
  Logs: "tabs.logs",
  About: "tabs.about",
} as const satisfies Record<TabName, string>;

export function tabLabel(name: TabName): string {
  return settingsText(TAB_LABEL_KEYS[name]);
}

/** Stable DOM id for a tab button (aria-labelledby target), e.g. "settings-tab-text-images". */
export function tabId(name: TabName): string {
  return `settings-tab-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

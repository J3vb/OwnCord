import { defineCatalog } from "./format";
import { settingsShellEntries } from "./settingsShellEntries";
import { settingsNotificationsEntries } from "./settingsNotificationsEntries";
import { settingsAdvancedEntries } from "./settingsAdvancedEntries";
import { settingsVoiceEntries } from "./settingsVoiceEntries";

/**
 * Settings copy (including the Accessibility tab): tab labels,
 * Appearance, Notifications, Text & Images, Voice & Video, Keybinds,
 * Advanced, Logs and the connection-diagnostics panel. Loads with the lazily
 * loaded settings overlay, so none of it is in the startup chunk.
 */
export const settingsText = defineCatalog("settings", {
  "images.dataSaver.label": "Data saver",
  "images.dataSaver.desc":
    "Load images, GIFs and preview images only when tapped. Keep emoji and stickers still.",
  "images.dataSaver.off": "Off",
  "images.dataSaver.mobile": "On mobile data",
  "images.dataSaver.always": "Always",
  ...settingsShellEntries,
  ...settingsNotificationsEntries,
  ...settingsAdvancedEntries,
  ...settingsVoiceEntries,
});

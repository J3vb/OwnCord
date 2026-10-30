/**
 * The fixed (non-rebindable) keyboard shortcuts, in one place. The settings
 * Keybinds tab and the read-only Ctrl+/ shortcuts overlay both render from
 * this list, so what the two show cannot drift. Rows hold i18n keys of the
 * settings catalog, never text. Global mute and deafen and the portal triggers
 * are built by their own code and are not listed here. A row marked
 * `rebindable` shows the user's binding, not its `combo`, which is only the
 * shipped default; `UNBOUND_BY_DEFAULT_ROWS` lists the rebindable actions that
 * ship with no key, so they are not in the fixed list.
 */

import type { settingsText } from "../../i18n/settings";
import type { RebindableId } from "./keybinds";

/** A key of the settings catalog. */
export type SettingsTextKey = Parameters<typeof settingsText>[0];

export interface KeybindRow {
  /** Catalog key of what the shortcut does. */
  readonly action: SettingsTextKey;
  /** Catalog key of the key combination. */
  readonly combo: SettingsTextKey;
  /** The rebindable action this row is; `combo` is then its default. */
  readonly rebindable?: RebindableId;
}

export type KeybindGroupId = "navigation" | "communication" | "messages";

export interface KeybindGroup {
  readonly id: KeybindGroupId;
  /** Catalog key of the group heading. */
  readonly title: SettingsTextKey;
  readonly rows: readonly KeybindRow[];
}

/** Navigation, Communication, Messages — the order both surfaces show. */
export const KEYBIND_GROUPS: readonly KeybindGroup[] = [
  {
    id: "navigation",
    title: "keybinds.navigation", // i18n-exempt: catalog key, rendered through settingsText
    rows: [
      { action: "keybinds.action.quickSwitcher", combo: "keybinds.key.ctrlK" },
      {
        action: "keybinds.action.searchMessages",
        combo: "keybinds.key.ctrlF",
        rebindable: "search",
      },
      { action: "keybinds.action.openSettings", combo: "keybinds.key.ctrlComma" },
      { action: "keybinds.action.showShortcuts", combo: "keybinds.key.ctrlSlash" },
      { action: "keybinds.action.nextChannel", combo: "keybinds.key.altArrow" },
      { action: "keybinds.action.nextUnreadChannel", combo: "keybinds.key.altShiftArrow" },
      { action: "keybinds.action.closeOverlay", combo: "keybinds.key.escape" },
      { action: "keybinds.action.markChannelRead", combo: "keybinds.key.escape" },
      { action: "keybinds.action.markServerRead", combo: "keybinds.key.shiftEscape" },
      { action: "keybinds.action.scrollChat", combo: "keybinds.key.pageUpDown" },
    ],
  },
  {
    id: "communication",
    title: "keybinds.communication", // i18n-exempt: catalog key, rendered through settingsText
    rows: [
      {
        action: "keybinds.action.toggleCamera",
        combo: "keybinds.key.ctrlShiftV",
        rebindable: "toggleCamera",
      },
    ],
  },
  {
    id: "messages",
    title: "keybinds.messages", // i18n-exempt: catalog key, rendered through settingsText
    rows: [
      {
        action: "keybinds.action.uploadFile",
        combo: "keybinds.key.ctrlShiftU",
        rebindable: "uploadFile",
      },
      {
        action: "keybinds.action.emojiPicker",
        combo: "keybinds.key.ctrlE",
        rebindable: "emojiPicker",
      },
      { action: "keybinds.action.gifPicker", combo: "keybinds.key.ctrlG", rebindable: "gifPicker" },
      { action: "keybinds.action.editLastMessage", combo: "keybinds.key.arrowUp" },
      { action: "keybinds.action.bold", combo: "keybinds.key.ctrlB" },
      { action: "keybinds.action.italic", combo: "keybinds.key.ctrlI" },
      { action: "keybinds.action.underline", combo: "keybinds.key.ctrlU" },
    ],
  },
];

/** Rebindable actions with no default key, shown after their group's rows. */
export const UNBOUND_BY_DEFAULT_ROWS: readonly {
  readonly group: KeybindGroupId;
  readonly action: SettingsTextKey;
  readonly rebindable: RebindableId;
}[] = [
  {
    group: "communication",
    action: "keybinds.action.toggleScreenshare",
    rebindable: "toggleScreenshare",
  },
  { group: "communication", action: "keybinds.action.disconnect", rebindable: "disconnect" },
];

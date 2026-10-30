/**
 * Display text for rebindable actions and their key combinations, shared by
 * the Keybinds tab and the Ctrl+/ shortcuts overlay.
 */

import { vkName } from "../voice/ptt";
import type { ActionId, KeyCombo } from "./keybinds";
import type { SettingsTextKey } from "./keybindCatalog";
import { settingsText as t } from "../../i18n/settings";

/** The catalog key of each action's label. */
const ACTION_LABEL_KEYS: Readonly<Record<ActionId, SettingsTextKey>> = {
  toggleMute: "keybinds.action.toggleMute",
  toggleDeafen: "keybinds.action.toggleDeafen",
  toggleCamera: "keybinds.action.toggleCamera",
  toggleScreenshare: "keybinds.action.toggleScreenshare",
  disconnect: "keybinds.action.disconnect",
  search: "keybinds.action.searchMessages",
  uploadFile: "keybinds.action.uploadFile",
  emojiPicker: "keybinds.action.emojiPicker",
  gifPicker: "keybinds.action.gifPicker",
};

/** The display name of an action. */
export function actionLabel(id: ActionId): string {
  return t(ACTION_LABEL_KEYS[id]);
}

/** A combo as text: "Ctrl + Shift + V". */
export function comboLabel(combo: KeyCombo): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push(t("keybinds.mod.ctrl"));
  if (combo.shift) parts.push(t("keybinds.mod.shift"));
  if (combo.alt) parts.push(t("keybinds.mod.alt"));
  parts.push(vkName(combo.vk));
  return parts.join(" + ");
}

/** A combo's text, or "Not set" for an unbound action. */
export function comboOrNotSet(combo: KeyCombo | null): string {
  return combo === null ? t("keybinds.notSet") : comboLabel(combo);
}

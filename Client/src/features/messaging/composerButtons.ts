/**
 * "Chat bar buttons" (Settings → Text & Images): each user can hide the
 * composer's emoji, sticker, GIF, Poll and voice-message buttons. A hidden
 * button still has its keyboard shortcut; only the icon leaves the bar.
 */

import { loadPref } from "../../lib/preferences";

export type ComposerButton = "emoji" | "sticker" | "gif" | "poll" | "voice";

export const COMPOSER_BUTTONS: readonly ComposerButton[] = [
  "emoji",
  "sticker",
  "gif",
  "poll",
  "voice",
];

const PREF_KEYS: Readonly<Record<ComposerButton, string>> = {
  emoji: "composerShowEmoji",
  sticker: "composerShowSticker",
  gif: "composerShowGif",
  poll: "composerShowPoll",
  voice: "composerShowVoice",
};

export function composerButtonPrefKey(button: ComposerButton): string {
  return PREF_KEYS[button];
}

export const COMPOSER_BUTTON_PREF_KEYS: readonly string[] =
  COMPOSER_BUTTONS.map(composerButtonPrefKey);

/** Whether the user wants `button` in the chat bar. On unless switched off. */
export function composerButtonShown(button: ComposerButton): boolean {
  return loadPref<boolean>(PREF_KEYS[button], true);
}

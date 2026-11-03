/**
 * The composer's idle hint: "Message #general", "Message @Ana" or "Message
 * Crew". The name is cut to a length that fits a phone row, ending in "…",
 * because a textarea placeholder clips without an ellipsis of its own.
 */

import { messagingText } from "../../i18n/messaging";

export type PlaceholderTarget = "channel" | "dm" | "group";

const MAX_NAME_CHARS = 24;

const KEYS = {
  channel: "composer.placeholder",
  dm: "composer.placeholderDm",
  group: "composer.placeholderGroup",
} as const;

function clipName(name: string): string {
  const chars = Array.from(name);
  return chars.length <= MAX_NAME_CHARS ? name : `${chars.slice(0, MAX_NAME_CHARS - 1).join("")}…`;
}

export function composerPlaceholder(target: PlaceholderTarget, name: string): string {
  const clipped = clipName(name);
  return target === "channel"
    ? messagingText(KEYS.channel, { channel: clipped })
    : messagingText(KEYS[target], { name: clipped });
}

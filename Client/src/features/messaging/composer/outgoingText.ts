/**
 * The text a send would put on the wire: slash commands rewritten, `:shortcodes:`
 * turned into emoji, picked mentions expanded. The send and the character
 * counter both measure this, so they agree on what is too long.
 */

import { replaceEmojiShortcodes } from "../shortcodes";
import { applyPickedMentions, type PickedMention } from "@lib/text/pickedMentions";
import { applySlashCommand } from "../slashCommands";

export type OutgoingText =
  { readonly content: string } | { readonly empty: true; readonly name: string };

export function composeOutgoing(raw: string, picks: readonly PickedMention[]): OutgoingText {
  const slash = applySlashCommand(raw);
  if (slash !== null && "empty" in slash) return { empty: true, name: slash.name };
  const typed = replaceEmojiShortcodes(slash === null ? raw.trim() : slash.text);
  return { content: applyPickedMentions(typed, picks) };
}

/**
 * Built-in slash commands (3A-10a, Discord parity C34). Pure and client-only:
 * the composer rewrites the text of a message that starts with `/shrug`,
 * `/tableflip`, `/unflip`, `/spoiler` or `/me` before it is sent, so the
 * server only ever sees ordinary message text. Any other `/word` is a normal
 * message. The names deliberately avoid the server's plugin `chat_command`
 * frame, which this module never touches.
 */

import type { messagingText } from "../../i18n/messaging";

type MessagingKey = Parameters<typeof messagingText>[0];

export interface SlashCommand {
  /** Lower-case name without the slash. */
  readonly name: string;
  /** Catalog key of the one-line description shown in the suggestion popup. */
  readonly descriptionKey: MessagingKey;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "shrug", descriptionKey: "slash.shrug" },
  { name: "tableflip", descriptionKey: "slash.tableflip" },
  { name: "unflip", descriptionKey: "slash.unflip" },
  { name: "spoiler", descriptionKey: "slash.spoiler" },
  { name: "me", descriptionKey: "slash.me" },
];

/**
 * `¯\_(ツ)_/¯` with the backslash and underscores escaped so the markdown
 * renderer (lib/markdown.ts ESCAPABLE) shows it literally, as Discord does.
 */
const SHRUG = "¯\\\\\\_(ツ)\\_/¯";
const TABLEFLIP = "(╯°□°)╯︵ ┻━┻";
const UNFLIP = "┬─┬ノ( º \\_ ºノ)";

/** The result of a command: the text to send, or "nothing to send". */
export type SlashResult = { readonly text: string } | { readonly empty: true };

const COMMAND_RE = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/;

/** `text` followed by an emoticon, or the emoticon alone when there is no text. */
function withSuffix(text: string, suffix: string): SlashResult {
  return { text: text === "" ? suffix : `${text} ${suffix}` };
}

/**
 * Rewrite `input` when it is one of the built-in commands, else null (not a
 * command: send as typed). The command must open the message and be followed
 * by whitespace or the end of the text; names match case-insensitively.
 * /spoiler and /me need text, so a bare one is `{ empty: true }`.
 */
export function applySlashCommand(input: string): SlashResult | null {
  const match = COMMAND_RE.exec(input.trimStart());
  if (match === null) return null;
  const name = (match[1] ?? "").toLowerCase();
  const text = (match[2] ?? "").trim();
  switch (name) {
    case "shrug":
      return withSuffix(text, SHRUG);
    case "tableflip":
      return withSuffix(text, TABLEFLIP);
    case "unflip":
      return withSuffix(text, UNFLIP);
    case "spoiler":
      return text === "" ? { empty: true } : { text: `||${text}||` };
    case "me":
      return text === "" ? { empty: true } : { text: `_${text}_` };
    default:
      return null;
  }
}

/** Commands whose name starts with `query` (case-insensitive), in list order. */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

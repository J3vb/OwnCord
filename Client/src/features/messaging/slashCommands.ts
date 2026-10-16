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
export type SlashResult =
  { readonly text: string } | { readonly empty: true; readonly name: string };

const COMMAND_RE = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/;

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9]/.test(ch);

/** Block openers markdown reads at the start of a line, escaped to stay prose. */
const LINE_LEAD = /^( *)(?:([-*+>#])|(\d{1,9})([.)]))/;

/**
 * Make `text` safe inside `||…||`: a `|` outside an inline code span is
 * escaped so it cannot close the spoiler early, a fence is escaped so its
 * code is not split out of the spoiler, and a block opener (`- `, `> `, `#`,
 * `1.`) at the start of a later line is escaped so the paragraph is not split.
 */
function escapeSpoiler(text: string): string {
  const noFence = text.replace(/`{3,}/g, (run) => "\\`".repeat(run.length));
  return noFence
    .split("\n")
    .map((line, i) => {
      let out = line
        .split(/(`[^`\n]*`)/)
        .map((part, j) => (j % 2 === 1 ? part : part.replace(/\|/g, "\\|")))
        .join("");
      if (i > 0) {
        out = out.replace(LINE_LEAD, (_m, sp: string, mark?: string, num?: string, dot?: string) =>
          mark !== undefined ? `${sp}\\${mark}` : `${sp}${num}\\${dot}`,
        );
      }
      return out;
    })
    .join("\n")
    .replace(/(\\+)$/, (run) => (run.length % 2 === 1 ? `${run}\\` : run));
}

/** Escape every `_` unless both neighbours are word characters (snake_case). */
function escapeUnderscores(text: string): string {
  return text.replace(/_/g, (m, offset: number) =>
    isWordChar(text[offset - 1]) && isWordChar(text[offset + 1]) ? m : "\\_",
  );
}

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
  const match = COMMAND_RE.exec(input);
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
      return text === "" ? { empty: true, name } : { text: `||${escapeSpoiler(text)}||` };
    case "me":
      return text === "" ? { empty: true, name } : { text: `_${escapeUnderscores(text)}_` };
    default:
      return null;
  }
}

/** Commands whose name starts with `query` (case-insensitive), in list order. */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

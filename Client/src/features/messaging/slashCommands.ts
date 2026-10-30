/**
 * Built-in slash commands (3A-10a, Discord parity C34). Pure and client-only:
 * the composer rewrites the text of a message that starts with `/shrug`,
 * `/tableflip`, `/unflip`, `/spoiler` or `/me` before it is sent, so the
 * server only ever sees ordinary message text. Any other `/word` is a normal
 * message. The names deliberately avoid the server's plugin `chat_command`
 * frame, which this module never touches.
 */

import { codeSpanEnd } from "../../lib/text/markdown";
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
 * renderer (lib/text/markdown.ts ESCAPABLE) shows it literally, as Discord does.
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

/** Stands in for a backtick of a fence while the text is split. */
const FENCE_MARK = "\uE000";
const URL_RUN = /https?:\/\/[^\s<>"']+/iy;
/** lib/text/mentions MENTION_TOKEN_REGEX's token, which Server/service/mentions.go shares. */
const MENTION_RUN = /@[\p{L}\p{N}_.-]{1,64}/uy;

interface Piece {
  readonly text: string;
  /** Code span, bare URL or @mention: sent exactly as typed. */
  readonly keep: boolean;
}

/**
 * Split `text` into runs the markdown and mention parsers read as units —
 * code spans (same-length backtick runs, as lib/text/markdown's codeSpanEnd), bare
 * URLs and, when `mentions` is set, `@name` tokens — and the prose between
 * them. Escaping goes in the prose only: a backslash inside a code span or a
 * URL shows, and `@\_bob` is no longer a mention.
 */
function splitPieces(text: string, mentions: boolean): Piece[] {
  const pieces: Piece[] = [];
  let start = 0;
  let i = 0;
  const take = (end: number): void => {
    if (i > start) pieces.push({ text: text.slice(start, i), keep: false });
    pieces.push({ text: text.slice(i, end), keep: true });
    i = end;
    start = end;
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === "`") {
      const end = codeSpanEnd(text, i);
      if (end > 0 && !text.slice(i, end).includes("\n")) {
        take(end);
        continue;
      }
      // An unclosed run is plain text; step over all of it.
      while (text[i + 1] === "`") i++;
    } else if ((c === "h" || c === "H") && !isWordChar(text[i - 1])) {
      URL_RUN.lastIndex = i;
      const m = URL_RUN.exec(text);
      if (m !== null) {
        take(i + m[0].length);
        continue;
      }
    } else if (mentions && c === "@" && !/[\p{L}\p{N}_@]/u.test(text[i - 1] ?? " ")) {
      MENTION_RUN.lastIndex = i;
      const m = MENTION_RUN.exec(text);
      if (m !== null) {
        take(i + m[0].length);
        continue;
      }
    }
    i++;
  }
  if (start < text.length) pieces.push({ text: text.slice(start), keep: false });
  return pieces;
}

/** Escape a block opener (`- `, `> `, `#`, `1.`) at the start of each later line. */
function escapeLineLeads(text: string): string {
  return text
    .split("\n")
    .map((line, i) =>
      i === 0
        ? line
        : line.replace(LINE_LEAD, (_m, sp: string, mark?: string, num?: string, dot?: string) =>
            mark !== undefined ? `${sp}\\${mark}` : `${sp}${num}\\${dot}`,
          ),
    )
    .join("\n");
}

/** An odd run of trailing backslashes would escape what is appended after it. */
function doubleTrailingBackslash(text: string): string {
  return text.replace(/(\\+)$/, (run) => (run.length % 2 === 1 ? `${run}\\` : run));
}

/**
 * Make `text` safe inside `||…||`: a `|` outside a code span or URL is
 * escaped so it cannot close the spoiler early, a fence is escaped so its
 * code is not split out of the spoiler, and a block opener at the start of a
 * later line is escaped so the paragraph is not split.
 */
function escapeSpoiler(text: string): string {
  // Fences become sentinels first so the code-span scan cannot pair them, and
  // turn into escaped backticks last, after backslashes have been doubled.
  const noFence = text.replace(/`{3,}/g, (run) => FENCE_MARK.repeat(run.length));
  const piped = splitPieces(noFence, false)
    .map((p) => (p.keep ? p.text : p.text.replace(/[\\|]/g, (c) => `\\${c}`)))
    .join("")
    .replaceAll(FENCE_MARK, "\\`");
  return doubleTrailingBackslash(escapeLineLeads(piped));
}

/**
 * Make `text` safe inside `_…_`: every `_` in the prose is escaped unless both
 * neighbours are word characters (snake_case), and the block-opener and
 * trailing-backslash rules apply. Known edge: a URL or @mention that ends in
 * `_` at the very end of the text keeps it, so the closing `_` is read as part
 * of a `__` run and the italics are lost (the link itself stays intact).
 */
function escapeItalic(text: string): string {
  let offset = 0;
  const escaped = splitPieces(text, true)
    .map((p) => {
      const at = offset;
      offset += p.text.length;
      if (p.keep) return p.text;
      // A backslash is doubled first, so a typed `\_` stays an escaped
      // backslash followed by an escaped underscore, never an unescaped one.
      return p.text.replace(/[\\_]/g, (c, k: number) =>
        c === "\\" || !(isWordChar(text[at + k - 1]) && isWordChar(text[at + k + 1]))
          ? `\\${c}`
          : c,
      );
    })
    .join("");
  return doubleTrailingBackslash(escapeLineLeads(escaped));
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
      return text === "" ? { empty: true, name } : { text: `_${escapeItalic(text)}_` };
    default:
      return null;
  }
}

/** Commands whose name starts with `query` (case-insensitive), in list order. */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

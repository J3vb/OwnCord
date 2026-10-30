/**
 * Typed `:joy:` shortcodes become their Unicode emoji when a message is sent,
 * as in Discord. Only a lowercase shortcode standing on its own is swapped: a
 * colon pair inside a word, a number or an address (`a:joy:b`, `00:1A:2B`,
 * `status:OK:done`) stays as typed, and so do code, links, a server's own
 * custom emoji (that is how they render) and a shortcode escaped with a
 * backslash. Before the emoji set has loaded, the text is sent as typed.
 */
import { codeSpanEnd } from "../../lib/text/markdown";
import { customEmojiLoaded, resolveEmoji } from "../../stores/emoji.store";
import { emojiCatalog, emojiForShortcode, skinTone, withSkinTone } from "./emojiCatalog";

/** Parts never touched besides code spans and masked links: code blocks,
 * `<https://…>` and bare URLs. */
const PROTECTED = /```[\s\S]*?```|<https?:\/\/[^\s<>]+>|https?:\/\/[^\s<>"']+/iy;
/** A shortcode with no letter, digit or `_` right before or after it, and not
 * escaped by an odd run of backslashes. */
const SHORTCODE =
  /(?<![\p{L}\p{N}_])(?<!(?:^|[^\\])\\(?:\\\\)*):([a-z0-9_+-]{2,32}):(?![\p{L}\p{N}_])/gu;

/** Characters whose opening role a backslash cancels here. */
const ESCAPED_OPENERS = "\\[`<";

/** Index of the `close` that balances the `open` at `start` on the same line,
 * skipping escaped characters as the markdown parser does, or -1. */
function balanced(s: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "\n") return -1;
    if (c === open) depth++;
    else if (c === close && depth > 0 && --depth === 0) return j;
  }
  return -1;
}

/** End of the protected part starting at `i`, or -1. A masked link's target
 * may hold balanced parentheses and must be non-empty with no whitespace, as
 * the markdown renderer reads it (lib/text/markdown parseLink). */
function protectedEnd(s: string, i: number): number {
  if (s[i] === "`" && !s.startsWith("```", i)) return codeSpanEnd(s, i);
  if (s[i] === "[") {
    const text = balanced(s, i, "[", "]");
    if (text > 0 && s[text + 1] === "(") {
      const target = balanced(s, text + 1, "(", ")");
      const url = target > 0 ? s.slice(text + 2, target).trim() : "";
      if (url !== "" && !/\s/.test(url)) return target + 1;
    }
  }
  PROTECTED.lastIndex = i;
  const m = PROTECTED.exec(s);
  return m === null ? -1 : i + m[0].length;
}

function replaceInProse(prose: string, tone: number): string {
  // A colon right before a shortcode only counts as a boundary when it closed
  // the previous one (`:joy::joy:`), never in `fe80::ab:cd`.
  let lastEnd = -1;
  return prose.replace(SHORTCODE, (whole, name: string, offset: number) => {
    if (offset > 0 && prose[offset - 1] === ":" && offset !== lastEnd) return whole;
    lastEnd = offset + whole.length;
    if (resolveEmoji(name) !== null) return whole;
    const e = emojiForShortcode(name);
    return e === null ? whole : withSkinTone(e, tone);
  });
}

export function replaceEmojiShortcodes(content: string): string {
  // Until the server's custom set is known, :joy: could be its own emoji.
  if (emojiCatalog() === null || !customEmojiLoaded() || !content.includes(":")) return content;
  const tone = skinTone();
  let out = "";
  let proseStart = 0;
  let i = 0;
  while (i < content.length) {
    // An escaped `[`, backtick, `<` or backslash opens nothing, as in the
    // parser; a code fence is found before escapes, and a backslash before
    // anything else (a bare URL's `h`) is kept as text.
    if (
      content[i] === "\\" &&
      ESCAPED_OPENERS.includes(content[i + 1] ?? "") &&
      !content.startsWith("```", i + 1)
    ) {
      i += 2;
      continue;
    }
    const end = protectedEnd(content, i);
    if (end < 0) {
      i++;
      continue;
    }
    out += replaceInProse(content.slice(proseStart, i), tone) + content.slice(i, end);
    i = proseStart = end;
  }
  return out + replaceInProse(content.slice(proseStart), tone);
}

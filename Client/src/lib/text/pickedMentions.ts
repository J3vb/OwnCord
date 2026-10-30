/**
 * Picked mention spans <-> id tokens, for the composer and the edit
 * box. Kept out of lib/text/mentions.ts, which the startup chunk carries, because
 * only the message list and the composer ever call it.
 */

/**
 * A mention the user picked from the popup: the text now in the draft
 * (`@alice`, `@Night Owls`) and the token the server stores for it.
 */
export interface PickedMention {
  readonly text: string;
  readonly token: string;
}

/** What may follow a picked span for it to still be that span, not a longer name. */
const AFTER_SPAN_CONTINUES = /(?:[\p{L}\p{N}_@]|[.-]+[\p{L}\p{N}_])/uy;
/** What may precede a span: start, or a rune the mention grammar allows before "@". */
const BEFORE_SPAN_WORD = /[\p{L}\p{N}_@]$/u;

/** Start offsets of `text` in `content` that stand alone as a whole span. */
function spanStarts(content: string, text: string): number[] {
  const starts: number[] = [];
  for (let at = content.indexOf(text); at !== -1; at = content.indexOf(text, at + 1)) {
    if (BEFORE_SPAN_WORD.test(content.slice(Math.max(0, at - 2), at))) continue;
    AFTER_SPAN_CONTINUES.lastIndex = at + text.length;
    if (AFTER_SPAN_CONTINUES.test(content)) continue;
    starts.push(at);
  }
  return starts;
}

/**
 * Rewrite the picked spans still intact in `content` to their id tokens. A span
 * the user edited after picking (`@alice` -> `@alicia`) no longer matches and
 * stays the plain text it now is, as does a spelling two picks share.
 */
export function applyPickedMentions(content: string, picks: readonly PickedMention[]): string {
  const tokenByText = new Map<string, string | null>();
  for (const pick of picks) {
    const known = tokenByText.get(pick.text);
    tokenByText.set(pick.text, known === undefined || known === pick.token ? pick.token : null);
  }
  const hits: { start: number; end: number; token: string }[] = [];
  for (const [text, token] of tokenByText) {
    if (token === null) continue;
    for (const start of spanStarts(content, text)) {
      hits.push({ start, end: start + text.length, token });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  let out = "";
  let last = 0;
  for (const hit of hits) {
    if (hit.start < last) continue;
    out += content.slice(last, hit.start) + hit.token;
    last = hit.end;
  }
  return out + content.slice(last);
}

/** How the edit box names an id: the member's or role's current name, or undefined. */
export interface MentionNames {
  readonly user: (id: number) => string | undefined;
  readonly role: (id: number) => string | undefined;
}

/**
 * The edit box's view of stored content: each `<@id>` and `<@&id>` the client
 * can name becomes `@name`, with the picks that turn it back on save. An id it
 * cannot name stays a raw token. When the names would not round-trip (a token
 * glued to a word, say) the raw content is shown instead, so a save can never
 * change what the user did not touch.
 */
export function tokensToPickedText(
  content: string,
  names: MentionNames,
): { readonly text: string; readonly picks: readonly PickedMention[] } {
  const picks: PickedMention[] = [];
  const text = content.replace(/<@(&?)(\d{1,15})>/g, (raw, role: string, digits: string) => {
    const id = Number(digits);
    const name = role === "" ? names.user(id) : names.role(id);
    if (name === undefined) return raw;
    const pick = { text: `@${name}`, token: raw };
    const clash = picks.some((p) => p.text === pick.text && p.token !== pick.token);
    if (clash) return raw;
    picks.push(pick);
    return pick.text;
  });
  if (picks.length === 0 || applyPickedMentions(text, picks) !== content) {
    return { text: content, picks: [] };
  }
  return { text, picks };
}

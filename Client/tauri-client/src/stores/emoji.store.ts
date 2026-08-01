/**
 * Emoji store — the server's custom-emoji set.
 *
 * Loaded once from GET /api/v1/emoji when the session goes ready, then
 * replaced wholesale on every `emoji_update` broadcast. The server sends the
 * full set rather than a delta for the same reason it does for roles: a
 * dropped intermediate event can never leave a deleted emoji rendering in
 * messages that name it.
 *
 * Everything downstream reads through `resolveEmoji`, which is the single
 * answer to "is `:name:` a real emoji here" — message rendering, the picker,
 * the composer autocomplete and reaction pills must all agree, and an
 * unresolved shortcode is plain text everywhere.
 */

import { createStore } from "@lib/store";

/** One custom emoji as the server describes it. */
export interface CustomEmoji {
  readonly id: number;
  /** Lowercase, colon-free, e.g. "wave". */
  readonly shortcode: string;
  /** Server-relative image path, e.g. "/api/v1/emoji/3/image". */
  readonly url: string;
}

export interface EmojiState {
  /** The set in server order (shortcode ascending). */
  readonly emoji: readonly CustomEmoji[];
  /** Lookup by lowercase shortcode. Rebuilt with the list, never mutated. */
  readonly byShortcode: ReadonlyMap<string, CustomEmoji>;
}

const INITIAL: EmojiState = {
  emoji: [],
  byShortcode: new Map(),
};

export const emojiStore = createStore<EmojiState>(INITIAL);

/**
 * The shortcode spelling the server accepts, mirrored here so the client never
 * treats `:not a code:` or `:x:` as a candidate. Deliberately identical to the
 * server's regexp: a token this rejects can never resolve, and a token this
 * accepts is one the server could have stored.
 */
export const SHORTCODE_PATTERN = /^[a-z0-9_]{2,32}$/;

/** Replace the whole set (from the REST list or an `emoji_update`). */
export function setCustomEmoji(list: readonly CustomEmoji[]): void {
  const next: CustomEmoji[] = [];
  const byShortcode = new Map<string, CustomEmoji>();
  for (const e of list) {
    // Defensive: a malformed entry must not poison the lookup map that
    // message rendering consults for every `:token:` in every message.
    if (typeof e?.shortcode !== "string" || typeof e.url !== "string") continue;
    const shortcode = e.shortcode.toLowerCase();
    if (!SHORTCODE_PATTERN.test(shortcode)) continue;
    const entry: CustomEmoji = { id: e.id, shortcode, url: e.url };
    next.push(entry);
    // First spelling wins, so a duplicate cannot silently shadow the earlier
    // one after the list has already been rendered.
    if (!byShortcode.has(shortcode)) byShortcode.set(shortcode, entry);
  }
  emojiStore.setState(() => ({ emoji: next, byShortcode }));
}

/** Drop every custom emoji (logout, or a switch to another server). */
export function clearCustomEmoji(): void {
  emojiStore.setState((prev) => (prev.emoji.length === 0 ? prev : INITIAL));
}

/**
 * The emoji owning `shortcode`, or null. Accepts the bare name or the `:name:`
 * spelling, so callers holding either form need no preprocessing.
 */
export function resolveEmoji(shortcode: string): CustomEmoji | null {
  if (typeof shortcode !== "string") return null;
  let name = shortcode.toLowerCase();
  if (name.startsWith(":") && name.endsWith(":") && name.length > 2) {
    name = name.slice(1, -1);
  }
  return emojiStore.getState().byShortcode.get(name) ?? null;
}

/** The whole set, for the picker and the composer autocomplete. */
export function listCustomEmoji(): readonly CustomEmoji[] {
  return emojiStore.getState().emoji;
}

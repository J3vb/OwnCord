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
  /**
   * Bumped by every `emoji_update`-sourced write (OC-0251). Optional —
   * absent/undefined reads as revision 0 — so state literals that predate
   * this field (tests, a full setState replace) do not need updating.
   *
   * Lets a ready-time GET /emoji snapshot the revision it observed just
   * before issuing the request and pass it back to setCustomEmoji: if an
   * `emoji_update` landed (bumping the revision) while that fetch was in
   * flight, the fetch's reply is a stale full-set snapshot answering a
   * question that is no longer current, and must not clobber the fresher
   * broadcast.
   */
  readonly rev?: number;
}

const INITIAL: EmojiState = {
  emoji: [],
  byShortcode: new Map(),
  rev: 0,
};

export const emojiStore = createStore<EmojiState>(INITIAL);

/**
 * The shortcode spelling the server accepts, mirrored here so the client never
 * treats `:not a code:` or `:x:` as a candidate. Deliberately identical to the
 * server's regexp: a token this rejects can never resolve, and a token this
 * accepts is one the server could have stored.
 */
export const SHORTCODE_PATTERN = /^[a-z0-9_]{2,32}$/;

/**
 * Replace the whole set (from the REST list or an `emoji_update`).
 *
 * `rev`, when given, must match the store's current `rev` — the revision the
 * caller observed right before starting the fetch this reply answers
 * (OC-0251, mirroring the blocksStore blockedByMeRev guard). A mismatch
 * means a fresher `emoji_update` landed after the fetch was issued, so this
 * reply is stale and is skipped rather than reverting that broadcast. Omit
 * `rev` to always apply — the `emoji_update` handler's unconditional call is
 * exactly what bumps the revision an in-flight GET's `rev` would then fail
 * to match.
 */
export function setCustomEmoji(list: readonly CustomEmoji[], rev?: number): void {
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
  emojiStore.setState((prev) => {
    if (rev !== undefined && rev !== (prev.rev ?? 0)) return prev;
    return { emoji: next, byShortcode, rev: (prev.rev ?? 0) + 1 };
  });
}

/**
 * Drop every custom emoji (logout, or a switch to another server).
 *
 * Bumps `rev` rather than resetting it to 0 (OC-0362): a reset would let a
 * still-in-flight GET /emoji from the session being torn down match the
 * next session's ready-time snapshot (both 0) and clobber it with the
 * previous server's emoji.
 */
export function clearCustomEmoji(): void {
  emojiStore.setState((prev) => ({ ...INITIAL, rev: (prev.rev ?? 0) + 1 }));
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

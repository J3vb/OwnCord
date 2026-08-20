/**
 * Mention token parsing and resolution, shared by message rendering, the
 * unread/mention badges, and the notification gate so all three agree on what
 * counts as a mention.
 *
 * The server is the authority: `mentions` / `mentions_everyone` on the wire
 * decide the outcome whenever they are present. The local token parse only
 * stands in for servers that predate those fields.
 */

import { authStore } from "@stores/auth.store";
import { membersStore } from "@stores/members.store";

/**
 * An @token that stands alone as a word. Group 1 is the preceding character,
 * which must be start-of-string or a non-word non-`@` rune, so "mail@example"
 * and "@@name" never match; group 3 captures a trailing "@" so address-shaped
 * text like "@bob@example.com" is rejected whole. Mirrors the server's
 * mentionTokenRe — a token the server would not resolve must not be
 * highlighted here either.
 */
export const MENTION_TOKEN_REGEX = /(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_.-]{1,64})(@?)/gu;

/** A `#name` channel token. Same word-boundary rule as @tokens. */
export const CHANNEL_TOKEN_REGEX = /(^|[^\p{L}\p{N}_#])#([\p{L}\p{N}_-]{1,64})/gu;

/** Reserved: a user literally named "everyone" is not reachable via @everyone. */
export const EVERYONE_TOKEN = "everyone";
export const HERE_TOKEN = "here";

/** Server-resolved mention state of one message, as carried on the wire. */
export interface MentionInfo {
  /** Mentioned user IDs. Undefined = the server did not send them. */
  readonly mentions?: readonly number[];
  /** Whether an @everyone/@here cleared the sender's MENTION_EVERYONE gate. */
  readonly mentionsEveryone?: boolean;
}

/** Whether `token` (without the leading @) is @everyone or @here. */
export function isEveryoneToken(token: string): boolean {
  const lower = token.toLowerCase();
  return lower === EVERYONE_TOKEN || lower === HERE_TOKEN;
}

/**
 * Username spellings a token may resolve to, in preference order. The trailing
 * `.`/`-` are dropped in the second spelling so "@bob." resolves to bob when no
 * user is literally named "bob." — same fallback the server applies.
 */
export function mentionSpellings(token: string): readonly string[] {
  const lower = token.toLowerCase();
  const trimmed = lower.replace(/[.-]+$/, "");
  return trimmed !== "" && trimmed !== lower ? [lower, trimmed] : [lower];
}

/**
 * Resolve an @token to a user ID, or null when nothing owns that name.
 * Unresolvable tokens stay plain text — "@ hey" and "@nobody" must not read as
 * mentions.
 *
 * Two sources, in order: the user IDs the server resolved for this message
 * (preferred, so an ambiguous spelling lands on the user the server actually
 * notified), then the member list by username. A server-listed ID that the
 * member list cannot name — a user who has since left — stays unresolved and
 * therefore unhighlighted; nothing else can spell it.
 */
export function resolveMentionUserId(token: string, info?: MentionInfo): number | null {
  if (isEveryoneToken(token)) return null;
  const spellings = mentionSpellings(token);
  const members = membersStore.getState().members;
  const matches = (username: string): boolean => spellings.includes(username.toLowerCase());

  for (const id of info?.mentions ?? []) {
    const member = members.get(id);
    if (member !== undefined && matches(member.username)) return id;
  }
  // The server is authoritative once it has spoken: a token it did not list
  // must not be resolved locally either, or the row-level gate (which trusts
  // info.mentions outright) and this token-level pill disagree on the same
  // message. Only fall back to the member-list/self scan when the server
  // sent no list at all (predates mentions, or a purely local render).
  if (info?.mentions !== undefined) return null;
  for (const member of members.values()) {
    if (matches(member.username)) return member.id;
  }
  // The signed-in user is not always in the member map (DM-only views), but a
  // mention of oneself must still highlight.
  const me = authStore.getState().user;
  if (me != null && matches(me.username)) return me.id;
  return null;
}

/** IDs of every @token in `content` that resolves to a known user. */
export function resolveMentionsFromContent(content: string): number[] {
  const ids: number[] = [];
  for (const match of content.matchAll(MENTION_TOKEN_REGEX)) {
    if (match[3] === "@") continue;
    const token = match[2];
    if (token === undefined || isEveryoneToken(token)) continue;
    const id = resolveMentionUserId(token);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Whether this message mentions the signed-in user by name. @everyone/@here is
 * deliberately excluded — callers that treat it as a mention say so explicitly,
 * because the two are suppressed independently.
 */
export function mentionsCurrentUser(content: string, info?: MentionInfo): boolean {
  const me = authStore.getState().user;
  if (me == null) return false;
  if (info?.mentions !== undefined) return info.mentions.includes(me.id);
  return resolveMentionsFromContent(content).includes(me.id);
}

/**
 * Whether this message should highlight for the signed-in user: a direct
 * mention, or an @everyone/@here the server honoured. An @everyone token from
 * a sender without MENTION_EVERYONE carries no mention semantics, so it never
 * highlights.
 */
export function highlightsCurrentUser(content: string, info?: MentionInfo): boolean {
  if (info?.mentionsEveryone === true) return true;
  return mentionsCurrentUser(content, info);
}

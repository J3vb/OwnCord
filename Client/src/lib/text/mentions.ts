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
import { roleIdByName } from "../roleLookup";

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

/**
 * `<@123>`: a user mention by id. Group 1 is the id. Ids stay below
 * 2^53 so `Number()` is exact; a longer digit run is not a token.
 */
export const ID_MENTION_REGEX = /<@(\d{1,15})>/g;

/** `<@&5>`: a role mention by id. Group 1 is the role id. */
export const ROLE_MENTION_REGEX = /<@&(\d{1,15})>/g;

/** Reserved: a user literally named "everyone" is not reachable via @everyone. */
export const EVERYONE_TOKEN = "everyone";
export const HERE_TOKEN = "here";

/** Server-resolved mention state of one message, as carried on the wire. */
export interface MentionInfo {
  /** Mentioned user IDs. Undefined = the server did not send them. */
  readonly mentions?: readonly number[];
  /** Whether an @everyone/@here cleared the sender's MENTION_EVERYONE gate. */
  readonly mentionsEveryone?: boolean;
  /**
   * Role IDs the server resolved and let through the sender's gate.
   * Undefined = the server did not send them, so the `<@&id>` tokens in the
   * content stand in.
   */
  readonly mentionRoles?: readonly number[];
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

/**
 * IDs of every user `content` mentions: each `<@id>` token (by id, so a rename
 * changes nothing) and each @token that resolves to a known user.
 */
export function resolveMentionsFromContent(content: string): number[] {
  const ids: number[] = [];
  for (const match of content.matchAll(ID_MENTION_REGEX)) {
    const id = Number(match[1]);
    if (!ids.includes(id)) ids.push(id);
  }
  for (const match of content.matchAll(MENTION_TOKEN_REGEX)) {
    if (match[3] === "@") continue;
    // `<@5>` is an id token (counted above), not the name "5".
    if (match[1] === "<") continue;
    const token = match[2];
    if (token === undefined || isEveryoneToken(token)) continue;
    const id = resolveMentionUserId(token);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Role IDs the server says this message mentions. Only its list counts: it has
 * dropped the roles the sender could not ping, whereas a `<@&id>` typed into a
 * message is just text until the server honours it. Absent = none.
 */
export function mentionedRoleIds(info?: MentionInfo): readonly number[] {
  return info?.mentionRoles ?? [];
}

/**
 * Ids of every role the signed-in user holds: the server's `role_ids` as sent,
 * else (an older server) the id of the single role name, else none.
 */
export function currentUserHeldRoleIds(): readonly number[] {
  const me = authStore.getState().user;
  if (me?.role_ids !== undefined) return me.role_ids;
  const id = me?.role == null ? undefined : roleIdByName(me.role);
  return id === undefined ? [] : [id];
}

/** Whether the server lists a role the signed-in user holds. */
function mentionsHeldRole(info?: MentionInfo): boolean {
  const mentioned = mentionedRoleIds(info);
  if (mentioned.length === 0) return false;
  const held = currentUserHeldRoleIds();
  return mentioned.some((id) => held.includes(id));
}

/**
 * Whether this message mentions the signed-in user: by name or id, or through
 * a role they hold. @everyone/@here is deliberately excluded — callers that
 * treat it as a mention say so explicitly, because the two are suppressed
 * independently.
 */
export function mentionsCurrentUser(content: string, info?: MentionInfo): boolean {
  const me = authStore.getState().user;
  if (me == null) return false;
  const direct =
    info?.mentions !== undefined
      ? info.mentions.includes(me.id)
      : resolveMentionsFromContent(content).includes(me.id);
  return direct || mentionsHeldRole(info);
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

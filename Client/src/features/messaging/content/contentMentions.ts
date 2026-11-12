/**
 * Mention rendering: `@user`, `<@id>`, `<@&id>` pills, the token scan that
 * turns a prose segment into DOM, and the resync that keeps rendered pills in
 * step with the member and role stores.
 */

import { createElement, setText } from "@lib/dom";
import { authStore } from "@stores/auth.store";
import { channelsStore, type ChannelsState } from "@stores/channels.store";
import { memberDisplayName, membersStore } from "@stores/members.store";
import {
  ID_MENTION_REGEX,
  currentUserHeldRoleIds,
  ROLE_MENTION_REGEX,
  CHANNEL_TOKEN_REGEX,
  MENTION_TOKEN_REGEX,
  isEveryoneToken,
  resolveMentionUserId,
  type MentionInfo,
} from "@lib/text/mentions";
import { EMOJI_TOKEN_REGEX, buildCustomEmojiNode } from "./customEmoji";
import { UNICODE_EMOJI_REGEX, buildEmojiImage, showsAsImage } from "./emojiImage";
import { messagingText } from "../../../i18n/messaging";
import { INVITE_LINK_REGEX, MESSAGE_LINK_REGEX } from "./contentRegex";
import { buildChannelNode, buildInviteLinkNode, buildMessageLinkNode } from "./contentLinkChips";

/** Make a mention chip plain link content: no role, tab stop or profile target. */
export function stripMentionControl(chip: HTMLElement): void {
  chip.removeAttribute("role");
  chip.removeAttribute("tabindex");
  chip.removeAttribute("data-user-id");
}

/** One recognised token in a prose segment, with the span it renders to. */
interface TokenMatch {
  readonly start: number;
  readonly end: number;
  readonly node: Node;
}

/** Build the highlight span for a resolved @token, or null to leave it as text. */
function buildMentionNode(raw: string, token: string, info?: MentionInfo): HTMLSpanElement | null {
  if (isEveryoneToken(token)) {
    // A token the sender lacked MENTION_EVERYONE for carries no mention
    // semantics at all — the server says so, and it must not read as one.
    if (info?.mentionsEveryone !== true) return null;
    const span = createElement("span", { class: "mention mention-everyone mention-self" });
    setText(span, raw);
    return span;
  }
  const userId = resolveMentionUserId(token, info);
  if (userId === null) return null;
  const isSelf = authStore.getState().user?.id === userId;
  const span = createElement("span", {
    class: isSelf ? "mention mention-self" : "mention",
    // Clicking or activating the chip opens that user's profile (delegated in
    // MessageList), so it is a button for the keyboard and assistive tech.
    role: "button",
    tabindex: "0",
    "data-user-id": String(userId),
    // The typed token, so a resync re-resolves it though the text is a name.
    "data-mention": raw,
  });
  // Show the display name when the member has one; the typed @username stays
  // as the title. Trailing punctuation the token matched through is kept.
  const member = membersStore.getState().members.get(userId);
  const name = member === undefined ? null : memberDisplayName(member);
  if (member !== undefined && name !== member.username) {
    const tail = token.toLowerCase().startsWith(member.username.toLowerCase())
      ? token.slice(member.username.length)
      : "";
    setText(span, `@${name}${tail}`);
    span.title = raw;
  } else {
    setText(span, raw);
  }
  return span;
}

/** `<@5>` / `<@&5>` in full: group 1 is the role marker, group 2 the id. */
const ID_TOKEN_FULL = /^<@(&?)(\d{1,15})>$/;

/** The only role colours a pill applies: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

type RosterRole = ChannelsState["roles"][number];

/** Roles by id, built once per roster snapshot: a token is then a map read. */
const rolesById = new WeakMap<ChannelsState["roles"], ReadonlyMap<number, RosterRole>>();

function rosterRole(id: number): RosterRole | undefined {
  const roles = channelsStore.getState().roles;
  let byId = rolesById.get(roles);
  if (byId === undefined) {
    byId = new Map(roles.map((r) => [r.id, r]));
    rolesById.set(roles, byId);
  }
  return byId.get(id);
}

/** A mention the reader sees as plain text: nothing to click, nothing to ping. */
function buildPlainMention(raw: string, text: string): HTMLSpanElement {
  const span = createElement("span", { class: "mention-plain", "data-mention": raw });
  setText(span, text);
  return span;
}

/** `<@id>`: the member's current name, or `@unknown-user` for one nobody can name. */
function buildUserIdNode(raw: string, userId: number, info?: MentionInfo): HTMLSpanElement {
  const me = authStore.getState().user;
  const member = membersStore.getState().members.get(userId);
  // The signed-in user is not always in the member map (DM-only views).
  const named =
    member ??
    (me?.id === userId
      ? { username: me.username, displayName: me.display_name ?? undefined }
      : undefined);
  if (named === undefined) return buildPlainMention(raw, messagingText("mention.unknownUser"));
  const span = createElement("span", {
    class:
      me?.id === userId && (info?.mentions === undefined || info.mentions.includes(userId))
        ? "mention mention-self"
        : "mention",
    role: "button",
    tabindex: "0",
    "data-user-id": String(userId),
    "data-mention": raw,
    title: `@${named.username}`,
  });
  setText(span, `@${memberDisplayName(named)}`);
  return span;
}

/** `<@&id>`: the role's name in its colour, `@deleted-role` once it is gone. */
function buildRoleIdNode(raw: string, roleId: number, info?: MentionInfo): HTMLSpanElement {
  const role = rosterRole(roleId);
  if (role === undefined) return buildPlainMention(raw, messagingText("mention.deletedRole"));
  // The server dropped this ping (the sender could not mention the role): it
  // reads as the text it is, never as a mention.
  if (info?.mentionRoles !== undefined && !info.mentionRoles.includes(roleId)) {
    return buildPlainMention(raw, `@${role.name}`);
  }
  const span = createElement("span", {
    class:
      info?.mentionRoles?.includes(roleId) === true && currentUserHeldRoleIds().includes(roleId)
        ? "mention mention-role mention-self"
        : "mention mention-role",
    "data-role-id": String(roleId),
    "data-mention": raw,
  });
  setText(span, `@${role.name}`);
  // Only a hex literal reaches the style; anything else leaves the default pill.
  if (role.color != null && HEX_COLOR.test(role.color)) {
    span.dataset["roleColor"] = role.color;
    span.style.setProperty("--role-pill", role.color);
  }
  return span;
}

/** Build the pill (or plain stand-in) for a `<@id>` / `<@&id>` token, or null if `raw` is neither. */
function buildIdMentionNode(raw: string, info?: MentionInfo): HTMLSpanElement | null {
  const match = ID_TOKEN_FULL.exec(raw);
  if (match === null) return null;
  const id = Number(match[2]);
  return match[1] === "&" ? buildRoleIdNode(raw, id, info) : buildUserIdNode(raw, id, info);
}

/** Add a token for every match of `regex` that `build` turns into a node. */
function collectTokens(
  text: string,
  regex: RegExp,
  build: (match: RegExpMatchArray) => Node | null,
  out: TokenMatch[],
): void {
  for (const match of text.matchAll(regex)) {
    const idx = match.index;
    if (idx === undefined) continue;
    const node = build(match);
    if (node !== null) out.push({ start: idx, end: idx + match[0].length, node });
  }
}

/** Add a token for each `@name` that resolves; the leading character the
 *  regex matched through is not part of the token. */
function collectMentionTokens(text: string, info: MentionInfo | undefined, out: TokenMatch[]) {
  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const idx = match.index;
    const lead = match[1];
    const token = match[2];
    if (idx === undefined || lead === undefined || token === undefined) continue;
    if (match[3] === "@") continue; // address-shaped, e.g. "@bob@example.com"
    const start = idx + lead.length;
    const node = buildMentionNode(`@${token}`, token, info);
    if (node !== null) out.push({ start, end: start + token.length + 1, node });
  }
}

/** Add a chip for each `#channel` that exists. */
function collectChannelTokens(text: string, out: TokenMatch[]): void {
  for (const match of text.matchAll(CHANNEL_TOKEN_REGEX)) {
    const idx = match.index;
    const lead = match[1];
    const name = match[2];
    if (idx === undefined || lead === undefined || name === undefined) continue;
    const start = idx + lead.length;
    const node = buildChannelNode(name);
    if (node !== null) out.push({ start, end: start + name.length + 1, node });
  }
}

/** The text with each token's node in place of its span, in source order. */
function fragmentFromTokens(text: string, matches: TokenMatch[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  matches.sort((a, b) => a.start - b.start);
  let lastIndex = 0;
  for (const m of matches) {
    if (m.start < lastIndex) continue; // overlapping token, keep the first
    if (m.start > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, m.start)));
    }
    fragment.appendChild(m.node);
    lastIndex = m.end;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
  return fragment;
}

/**
 * Render @mentions, #channel links and message permalinks within a text
 * segment (no http URLs). Tokens that resolve to nothing are left as plain text.
 */
export function renderMentionSegment(text: string, info?: MentionInfo): DocumentFragment {
  const matches: TokenMatch[] = [];
  collectTokens(text, MESSAGE_LINK_REGEX, (m) => buildMessageLinkNode(m[0]), matches);
  collectTokens(text, INVITE_LINK_REGEX, (m) => buildInviteLinkNode(m[0]), matches);
  for (const regex of [ID_MENTION_REGEX, ROLE_MENTION_REGEX]) {
    collectTokens(text, regex, (m) => buildIdMentionNode(m[0], info), matches);
  }
  collectMentionTokens(text, info, matches);
  collectChannelTokens(text, matches);
  // `:shortcode:` custom emoji. This runs on prose segments only — code spans
  // never reach here (appendInline renders them verbatim) and fenced blocks are
  // split off before any of this, so a shortcode inside code stays code.
  collectTokens(
    text,
    EMOJI_TOKEN_REGEX,
    (m) => (m[1] === undefined ? null : buildCustomEmojiNode(m[1])),
    matches,
  );
  // Unicode emoji as Twemoji images, on the same prose-only path.
  collectTokens(
    text,
    UNICODE_EMOJI_REGEX,
    (m) => (showsAsImage(m[0]) ? buildEmojiImage(m[0]) : null),
    matches,
  );
  return fragmentFromTokens(text, matches);
}

/** Elements whose text is never mention-highlighted at render time, so the
 *  mention resync must leave them alone: code spans/blocks, existing pills and
 *  chips, a rejected masked link left as raw text, and autolinked URLs (whose
 *  text is the URL itself, which may contain an `/@token` path). A masked
 *  `[text](url)` link does get mentions rendered inside it, so `.masked` links
 *  stay transparent. */
const MENTION_OPAQUE_SELECTOR =
  "code, .msg-codeblock, .mention, .mention-plain, .channel-mention, .message-link-chip, .msg-link-raw, .msg-link:not(.masked)";

/** Whether a rebuilt pill is identical to the one already in the DOM. */
function sameMention(a: HTMLElement, b: HTMLElement): boolean {
  return (
    a.className === b.className &&
    (a.dataset["userId"] ?? "") === (b.dataset["userId"] ?? "") &&
    (a.dataset["roleId"] ?? "") === (b.dataset["roleId"] ?? "") &&
    (a.dataset["roleColor"] ?? "") === (b.dataset["roleColor"] ?? "")
  );
}

/**
 * Wrap the @tokens in one plain prose run that resolve against the live member
 * store, leaving every other token (`#channel`, `:emoji:`, unresolved @) as the
 * text it already is. Returns null when nothing in the run resolves.
 */
function wrapResolvedMentions(text: string, info?: MentionInfo): DocumentFragment | null {
  const matches: TokenMatch[] = [];
  collectMentionTokens(text, info, matches);
  return matches.length === 0 ? null : fragmentFromTokens(text, matches);
}

/**
 * Re-resolve the @mention spans already rendered under `root` against the live
 * member store, and wrap plain @tokens inside it that now resolve. Called when
 * a membership/role/profile change bumps roleRevision, so the pills track a
 * rename without re-parsing or rebuilding the row — in both directions:
 * a token that stopped resolving is unwrapped to plain text, one that started
 * resolving becomes a pill. Scoped to the two regions mentions are rendered
 * into (.msg-text and .sm-text), so an author's display name or a reply
 * preview, where render never highlights a mention, is left alone.
 */
export function resyncMentions(root: ParentNode, info?: MentionInfo): void {
  for (const content of root.querySelectorAll(".msg-text, .sm-text")) {
    // querySelectorAll returns a static list, so replacing a span as we go does
    // not disturb the walk.
    for (const span of content.querySelectorAll<HTMLElement>(".mention, .mention-plain")) {
      refreshMentionSpan(span, info);
    }
    for (const textNode of proseTextNodes(content)) wrapTextNodeMentions(textNode, info);
  }
}

/** Rebuild one rendered mention against the live stores: keep it when it is
 *  unchanged (refreshing its text and title), else swap it for the new pill or
 *  the plain text it now reads as. */
function refreshMentionSpan(span: HTMLElement, info?: MentionInfo): void {
  // The typed token lives in data-mention; the text may be a display name.
  const raw = span.dataset["mention"] ?? span.textContent ?? "";
  const token = raw.startsWith("@") ? raw.slice(1) : raw;
  // An id token always rebuilds to a pill or its plain stand-in, so a
  // rename, a role rename, recolour or deletion, or a member leaving or
  // returning shows at once (MessageList resyncs on member and role changes).
  const replacement = buildIdMentionNode(raw, info) ?? buildMentionNode(raw, token, info);
  if (replacement === null) {
    span.replaceWith(document.createTextNode(raw));
    return;
  }
  // A mention that labels a masked link stays plain link content when it is
  // rebuilt, as at first render (buildMaskedLink).
  if (span.closest("a.msg-link.masked") !== null) stripMentionControl(replacement);
  if (!sameMention(span, replacement)) {
    span.replaceWith(replacement);
    return;
  }
  if (span.textContent !== replacement.textContent) {
    setText(span, replacement.textContent ?? raw);
  }
  if (replacement.title === "") span.removeAttribute("title");
  else span.title = replacement.title;
}

/** Every text node under `content`, collected up front so wrapping one does
 *  not disturb the walk. */
function proseTextNodes(content: Element): Text[] {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    textNodes.push(n as Text);
  }
  return textNodes;
}

/** Wrap the @tokens in a plain text node that resolve now. */
function wrapTextNodeMentions(textNode: Text, info?: MentionInfo): void {
  if (textNode.nodeValue?.includes("@") !== true) return;
  const parent = textNode.parentElement;
  if (parent === null || parent.closest(MENTION_OPAQUE_SELECTOR) !== null) return;
  const wrapped = wrapResolvedMentions(textNode.nodeValue ?? "", info);
  if (wrapped === null) return;
  // A token in a masked link's label that resolves only now stays plain
  // link content too, or a click on it would open a profile, not the link.
  if (parent.closest("a.msg-link.masked") !== null) {
    for (const chip of wrapped.querySelectorAll<HTMLElement>(".mention")) {
      stripMentionControl(chip);
    }
  }
  textNode.replaceWith(wrapped);
}

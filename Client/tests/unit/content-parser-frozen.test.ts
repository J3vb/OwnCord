/**
 * Pins the message content renderer (contentParser.ts and the files it was
 * split into) to a frozen copy of the single-file implementation it had before
 * the split. The copy below is deliberately verbatim and must not be edited to
 * follow the live code: a change to how untrusted message text becomes DOM has
 * to show up here as a failing comparison.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  relabelInlineTimestamps as liveRelabel,
  renderInlineContent as liveInline,
  renderMentionSegment as liveSegment,
  renderMentions as liveMentions,
  renderMessageContent as liveMessage,
  resyncMentions as liveResync,
  clearContentParseCache as liveClear,
  stripUrlTrailingPunctuation as liveStrip,
} from "../../src/features/messaging/content/contentParser";
import { setRoles } from "../../src/stores/channels.store";
import { seedMembersAndChannels } from "../helpers/contentRenderHarness";
import { createElement, setText } from "@lib/dom";
import { navigateToChannel, findChannelByName, findChannelById } from "@lib/nav/channelNavigation";
import { parseInviteLink, parseMessageLink } from "@lib/nav/deepLink";
import { getChannelMutesHost } from "@lib/prefs/channelMutes";
import { normalizeHostForCertCompare } from "@lib/net/hostNormalize";
import { requestInviteJoin } from "@lib/nav/inviteNavigation";
import { jumpToMessage } from "@lib/nav/messageNavigation";
import { showToast } from "@lib/ui/toast";
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
import { isSafeUrl } from "../../src/features/messaging/content/attachments";
import {
  EMOJI_TOKEN_REGEX,
  buildCustomEmojiNode,
  isEmojiOnlyMessage,
} from "../../src/features/messaging/content/customEmoji";
import { formatDiscordTimestamp, type TimestampStyle } from "@lib/text/discordTimestamp";
import { messagingText } from "../../src/i18n/messaging";
import { desktop } from "../../src/platform/desktop";
import {
  parseInline,
  parseBlocks,
  splitCodeFences,
  type InlineNode,
  type InlineStyle,
} from "@lib/text/markdown";
import {
  highlightCode,
  resolveLanguage,
  type CodeToken,
} from "../../src/features/messaging/content/syntaxHighlight";
import { copyThenRelabel } from "@lib/ui/clipboard";

// ---- Frozen copy -------------------------------------------------------------

// -- Regex constants ----------------------------------------------------------

const URL_REGEX = /https?:\/\/[^\s<>"']+/g;
/** `owncord://message/<channelId>/<messageId>` pasted into a message. */
const MESSAGE_LINK_REGEX = /owncord:\/\/message\/\d+\/\d+/g;
/** `owncord://invite/<code>` (optionally `?host=…`) pasted into a message. */
const INVITE_LINK_REGEX = /owncord:\/\/invite\/[\w%-]+(?:\?host=[\w.:%[\]-]*[\w%\]-])?/g;

/**
 * Strip trailing punctuation that is likely sentence-level, not part of the
 * URL — e.g. the period after "https://example.com." in "Check this out.".
 *
 * Gives back one trailing ")" if it balances an unmatched "(" earlier in the
 * URL, since `https://en.wikipedia.org/wiki/Rust_(programming_language)` is a
 * real address, not prose wrapped in parens.
 *
 * This is the single source of truth for "what counts as part of the URL vs.
 * surrounding prose" — every consumer of a raw URL_REGEX match (linkifying
 * anchors, extracting URLs for the embed pipeline) must strip through this
 * function so they agree on the same URL.
 */
function stripUrlTrailingPunctuation(rawUrl: string): string {
  let stripped = rawUrl.replace(/[.,;:!?)]+$/, "");
  if (rawUrl.length > stripped.length && rawUrl[stripped.length] === ")") {
    const opens = (stripped.match(/\(/g) ?? []).length;
    const closes = (stripped.match(/\)/g) ?? []).length;
    if (opens > closes) stripped = stripped + ")";
  }
  return stripped || rawUrl; // fallback if stripping emptied it
}

/** Quotes may contain blocks, but a quote inside a quote inside a quote is a
 * fight the renderer does not need to have. */
const MAX_BLOCK_DEPTH = 2;

// -- Inline rendering ---------------------------------------------------------

const STYLE_TAGS = {
  strong: "strong",
  em: "em",
  underline: "u",
  strike: "s",
} as const satisfies Record<Exclude<InlineStyle, "spoiler">, keyof HTMLElementTagNameMap>;

const STYLE_CLASSES = {
  strong: "md-bold",
  em: "md-italic",
  underline: "md-underline",
  strike: "md-strike",
} as const;

/** A spoiler: obscured until the reader asks for it, one span at a time. */
function buildSpoiler(
  node: { readonly children: readonly InlineNode[] },
  info?: MentionInfo,
): HTMLSpanElement {
  const span = createElement("span", {
    class: "msg-spoiler",
    role: "button",
    tabindex: "0",
    "aria-pressed": "false",
    "aria-label": messagingText("spoiler.reveal"),
  });
  appendInline(span, node.children, info);

  const reveal = (e: Event): void => {
    if (span.classList.contains("revealed")) return;
    // Swallow the activation that revealed the text: a link hiding under a
    // spoiler must not open on the same click that uncovers it.
    e.preventDefault();
    e.stopPropagation();
    span.classList.add("revealed");
    span.setAttribute("aria-pressed", "true");
    span.setAttribute("aria-label", messagingText("spoiler.revealed"));
  };
  span.addEventListener("click", reveal);
  span.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") reveal(e);
  });
  return span;
}

/** A `[text](url)` anchor, or null when the URL is not a safe http(s) one. */
/** Make a mention chip plain link content: no role, tab stop or profile target. */
function stripMentionControl(chip: HTMLElement): void {
  chip.removeAttribute("role");
  chip.removeAttribute("tabindex");
  chip.removeAttribute("data-user-id");
}

function buildMaskedLink(
  node: { readonly url: string; readonly children: readonly InlineNode[] },
  info?: MentionInfo,
): HTMLAnchorElement | null {
  // Absolute http(s) only: isSafeUrl resolves relatives against the app
  // origin, which is not something a message author gets to link to.
  if (!/^https?:\/\//i.test(node.url) || !isSafeUrl(node.url)) return null;
  const link = createElement("a", {
    class: "msg-link masked",
    href: node.url,
    title: node.url,
    target: "_blank",
    rel: "noopener noreferrer",
  });
  appendInline(link, node.children, info);
  // A mention that labels a link is part of the link: a nested button would
  // give Tab and screen readers two controls with one label, one opening the
  // URL and one a profile.
  for (const chip of link.querySelectorAll<HTMLElement>(".mention[data-user-id]")) {
    stripMentionControl(chip);
  }
  // An invite chip is a control too, and a click would also follow the link:
  // inside a masked link it stays the text it was typed as.
  for (const chip of link.querySelectorAll<HTMLElement>(".message-link-chip[data-raw]")) {
    chip.replaceWith(document.createTextNode(chip.dataset["raw"] ?? ""));
  }
  return link;
}

/** `<https://…>`: the link without its brackets, and (in extractUrls) no embed. */
function buildAngleUrl(node: { readonly url: string; readonly raw: string }): HTMLElement {
  if (!isSafeUrl(node.url)) {
    const raw = createElement("span", { class: "msg-link-raw" });
    setText(raw, node.raw);
    return raw;
  }
  const link = createElement("a", {
    class: "msg-link",
    href: node.url,
    target: "_blank",
    rel: "noopener noreferrer",
  });
  setText(link, node.url);
  return link;
}

/** Turn inline nodes into DOM under `parent`. */
function appendInline(parent: Node, nodes: readonly InlineNode[], info?: MentionInfo): void {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        // Plain runs are where mentions, #channels and bare URLs live.
        parent.appendChild(renderMentions(node.value, info));
        break;
      case "code": {
        const code = createElement("code", {});
        setText(code, node.value);
        parent.appendChild(code);
        break;
      }
      case "link": {
        const link = buildMaskedLink(node, info);
        if (link !== null) parent.appendChild(link);
        else {
          const raw = createElement("span", { class: "msg-link-raw" });
          setText(raw, node.raw);
          parent.appendChild(raw);
        }
        break;
      }
      case "url":
        parent.appendChild(buildAngleUrl(node));
        break;
      case "timestamp": {
        const { text, title } = formatDiscordTimestamp(node.unix, node.style);
        const time = createElement("time", {
          class: "md-timestamp",
          datetime: new Date(node.unix * 1000).toISOString(),
          title,
          "data-style": node.style,
        });
        setText(time, text);
        parent.appendChild(time);
        break;
      }
      case "spoiler":
        parent.appendChild(buildSpoiler(node, info));
        break;
      default: {
        const el = createElement(STYLE_TAGS[node.type], { class: STYLE_CLASSES[node.type] });
        appendInline(el, node.children, info);
        parent.appendChild(el);
      }
    }
  }
}

/**
 * Render one run of inline text: markdown styles, code spans, masked links,
 * mentions and autolinked URLs.
 */
function renderInlineContent(text: string, info?: MentionInfo): DocumentFragment {
  const fragment = document.createDocumentFragment();
  appendInline(fragment, parseInline(text), info);
  return fragment;
}

function renderMentions(text: string, info?: MentionInfo): DocumentFragment {
  // First pass: split by URLs, then handle mentions in non-URL segments
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of text.matchAll(URL_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    if (idx > lastIndex) {
      fragment.appendChild(renderMentionSegment(text.slice(lastIndex, idx), info));
    }
    // Strip trailing punctuation that is likely sentence-level, not part of the URL
    const rawUrl = match[0];
    const stripped = stripUrlTrailingPunctuation(rawUrl);
    const trailing = rawUrl.slice(stripped.length);
    const url = stripped;
    if (isSafeUrl(url)) {
      const link = createElement("a", {
        class: "msg-link",
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
      });
      setText(link, url);
      fragment.appendChild(link);
      if (trailing) {
        fragment.appendChild(document.createTextNode(trailing));
      }
    } else {
      const raw = createElement("span", { class: "msg-link-raw" });
      setText(raw, rawUrl);
      fragment.appendChild(raw);
    }
    lastIndex = idx + rawUrl.length;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(renderMentionSegment(text.slice(lastIndex), info));
  }
  return fragment;
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

/** Build the clickable chip for a `#name` that resolves, or null. */
function buildChannelNode(name: string): HTMLSpanElement | null {
  const channel = findChannelByName(name);
  if (channel === null) return null;
  const chip = createElement("span", {
    class: "channel-mention",
    role: "link",
    tabindex: "0",
    "data-channel-id": String(channel.id),
    title: messagingText("channel.goTo", { channel: channel.name }),
  });
  setText(chip, `#${channel.name}`);
  // Listeners are attached per node with no signal, matching the code-block
  // copy button above: these spans live and die with the message row.
  chip.addEventListener("click", () => navigateToChannel(channel.id));
  chip.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      navigateToChannel(channel.id);
    }
  });
  return chip;
}

/**
 * Build the compact chip for a pasted `owncord://message/…` permalink, or null
 * when the link does not parse or points at a channel this user cannot see —
 * an unreachable jump reads better as the raw text it was typed as.
 */
function buildMessageLinkNode(url: string): HTMLSpanElement | null {
  const link = parseMessageLink(url);
  if (link === null) return null;
  const channel = findChannelById(link.channelId);
  if (channel === null) return null;

  // A DM channel has no user-visible #name; every other DM-labelling surface
  // uses '@', so the chip must too (F15).
  const channelLabel = `${channel.isDm ? "@" : "#"}${channel.name}`;
  const chip = createElement("span", {
    class: "message-link-chip",
    role: "link",
    tabindex: "0",
    "data-channel-id": String(link.channelId),
    "data-message-id": String(link.messageId),
    title: messagingText("message.jumpIn", { channel: channelLabel }),
  });
  const label = createElement("span", { class: "mlc-channel" });
  setText(label, channelLabel);
  const action = createElement("span", { class: "mlc-action" });
  setText(action, messagingText("message.jump"));
  chip.appendChild(label);
  chip.appendChild(action);

  const go = (): void => jumpToMessage(link.channelId, link.messageId);
  // Per-node listeners with no signal, like the #channel chip above: these
  // spans live and die with the message row.
  chip.addEventListener("click", go);
  chip.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  });
  return chip;
}

/** Same server, ignoring case, whitespace, a default :443 and IPv6 brackets. */
function sameHost(a: string, b: string): boolean {
  return normalizeHostForCertCompare(a.trim()) === normalizeHostForCertCompare(b.trim());
}

/**
 * The web client is bound to the server that served it, so it cannot switch to
 * another one: an invite for another server opens that server's own page in a
 * new tab, where its browser client (if it hosts one) takes the code.
 */
function openInviteOnItsServer(code: string, host: string): void {
  let url: URL;
  try {
    url = new URL(`https://${host}/`);
  } catch {
    showToast(messagingText("invite.openTabFailed"), "error");
    return;
  }
  url.searchParams.set("invite", code);
  desktop.urlOpener
    .open(url.href)
    .catch(() => showToast(messagingText("invite.openTabFailed"), "error"));
}

/**
 * Build the chip for a pasted `owncord://invite/…` link, or null when it does
 * not parse. Joining signs out of the current server, so a chip for another
 * server confirms first, and one for the server already open just says so.
 */
function buildInviteLinkNode(url: string): HTMLSpanElement | null {
  const invite = parseInviteLink(url);
  if (invite === null) return null;
  const current = getChannelMutesHost();
  const alreadyIn = invite.host !== undefined && current !== null && sameHost(invite.host, current);
  const target = invite.host ?? messagingText("invite.thisServer");

  const chip = createElement("span", {
    class: alreadyIn ? "message-link-chip invite-chip-here" : "message-link-chip",
    "data-invite-code": invite.code,
    "data-raw": url,
    title: alreadyIn
      ? messagingText("invite.alreadyIn")
      : messagingText("invite.joinTitle", { server: target }),
  });
  const label = createElement("span", { class: "mlc-channel" });
  setText(label, target);
  const action = createElement("span", { class: "mlc-action" });
  setText(action, alreadyIn ? messagingText("invite.alreadyIn") : messagingText("invite.join"));
  chip.appendChild(label);
  chip.appendChild(action);
  if (alreadyIn) return chip;

  chip.setAttribute("role", "link");
  chip.setAttribute("tabindex", "0");
  const go = (): void => {
    if (__OWNCORD_WEB__ && invite.host !== undefined) {
      openInviteOnItsServer(invite.code, invite.host);
      return;
    }
    const name = authStore.getState().serverName ?? current ?? "";
    const body =
      invite.host === undefined
        ? messagingText("invite.confirmBodyNoHost", { current: name })
        : messagingText("invite.confirmBody", { current: name, target });
    // On demand, like the masked-link guard: keeps the modal off the startup chunk.
    void import("../../src/features/invites/InviteJoinConfirm").then((m) =>
      m.confirmInviteJoin(body, () => requestInviteJoin(invite.code, invite.host)),
    );
  };
  chip.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    go();
  });
  chip.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      go();
    }
  });
  return chip;
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
function renderMentionSegment(text: string, info?: MentionInfo): DocumentFragment {
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
function resyncMentions(root: ParentNode, info?: MentionInfo): void {
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

// -- Parsed content (the parse cache's payload) -------------------------------
//
// Parsing (splitCodeFences + parseBlocks + parseInline + highlightCode) is the
// expensive half of rendering a message; building the DOM from it is cheap.
// renderMessageContent caches the parse under a key the caller derives from the
// message's identity (id + editedAt), so a row re-materialised by virtual
// scrolling — or one of many rows repainted for a connection or role change —
// does not re-tokenise content that has not changed. Mention resolution and
// emoji lookup stay at render time, because they depend on live stores, not on
// the parse.

interface ParsedListItem {
  readonly inline: readonly InlineNode[];
  readonly level: 0 | 1;
  readonly ordered: boolean;
}

type ParsedBlock =
  | { readonly type: "paragraph"; readonly inline: readonly InlineNode[] }
  | { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly inline: readonly InlineNode[] }
  | { readonly type: "subtext"; readonly inline: readonly InlineNode[] }
  | { readonly type: "quote"; readonly blocks: readonly ParsedBlock[] }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly ParsedListItem[];
    };

type ParsedSegment =
  | { readonly kind: "prose"; readonly blocks: readonly ParsedBlock[] }
  | {
      readonly kind: "code";
      readonly code: string;
      readonly lang: string | null;
      readonly canonical: string | null;
      readonly tokens: readonly CodeToken[];
    };

interface ParsedMessage {
  readonly segments: readonly ParsedSegment[];
}

function parseBlocksInto(text: string, depth: number): readonly ParsedBlock[] {
  const out: ParsedBlock[] = [];
  for (const block of parseBlocks(text)) {
    switch (block.type) {
      case "heading":
        out.push({ type: "heading", level: block.level, inline: parseInline(block.text) });
        break;
      case "subtext":
        out.push({ type: "subtext", inline: parseInline(block.text) });
        break;
      case "quote":
        if (depth + 1 >= MAX_BLOCK_DEPTH) {
          out.push({
            type: "quote",
            blocks: [{ type: "paragraph", inline: parseInline(block.text) }],
          });
        } else {
          out.push({ type: "quote", blocks: parseBlocksInto(block.text, depth + 1) });
        }
        break;
      case "list":
        out.push({
          type: "list",
          ordered: block.ordered,
          start: block.start,
          items: block.items.map((item) => ({
            inline: parseInline(item.text),
            level: item.level,
            ordered: item.ordered,
          })),
        });
        break;
      default:
        out.push({ type: "paragraph", inline: parseInline(block.text) });
        break;
    }
  }
  return out;
}

function parseMessageContent(content: string): ParsedMessage {
  const segments: ParsedSegment[] = [];
  for (const segment of splitCodeFences(content)) {
    if (segment.kind === "code") {
      const canonical = resolveLanguage(segment.lang);
      segments.push({
        kind: "code",
        code: segment.text,
        lang: segment.lang,
        canonical,
        tokens: highlightCode(segment.text, canonical),
      });
      continue;
    }
    // Blank lines hugging a fence are formatting, not content.
    const prose = segment.text.replace(/^\n+/, "").replace(/\n+$/, "");
    if (prose.trim().length === 0) continue;
    segments.push({ kind: "prose", blocks: parseBlocksInto(prose, 0) });
  }
  return { segments };
}

// -- Block rendering ----------------------------------------------------------

/** Render list items, folding indented ones into a single nested level. */
function renderParsedList(
  block: Extract<ParsedBlock, { type: "list" }>,
  info: MentionInfo | undefined,
): HTMLElement {
  const root = createElement(block.ordered ? "ol" : "ul", { class: "md-list" });
  if (block.ordered && block.start !== 1) root.setAttribute("start", String(block.start));
  let sublist: HTMLElement | null = null;

  for (const item of block.items) {
    const li = createElement("li", { class: "md-li" });
    appendInline(li, item.inline, info);

    const parentLi = root.lastElementChild;
    if (item.level === 1 && parentLi !== null) {
      if (sublist === null) {
        sublist = createElement(item.ordered ? "ol" : "ul", { class: "md-list md-list-nested" });
        parentLi.appendChild(sublist);
      }
      sublist.appendChild(li);
      continue;
    }
    sublist = null;
    root.appendChild(li);
  }
  return root;
}

/** Append a parsed block structure to `parent`. */
function renderParsedBlocks(
  parent: HTMLElement,
  blocks: readonly ParsedBlock[],
  info?: MentionInfo,
): void {
  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const heading = createElement(`h${block.level}`, {
          class: `md-heading md-h${block.level}`,
        });
        appendInline(heading, block.inline, info);
        parent.appendChild(heading);
        break;
      }
      case "subtext": {
        const sub = createElement("div", { class: "md-subtext" });
        appendInline(sub, block.inline, info);
        parent.appendChild(sub);
        break;
      }
      case "quote": {
        const quote = createElement("blockquote", { class: "md-quote" });
        renderParsedBlocks(quote, block.blocks, info);
        parent.appendChild(quote);
        break;
      }
      case "list":
        parent.appendChild(renderParsedList(block, info));
        break;
      default: {
        const para = createElement("div", { class: "md-p" });
        appendInline(para, block.inline, info);
        parent.appendChild(para);
      }
    }
  }
}

// -- Code fences --------------------------------------------------------------

/** A code block from its parsed form: language label, highlighted body, copy button. */
function renderParsedCodeBlock(segment: Extract<ParsedSegment, { kind: "code" }>): HTMLDivElement {
  const wrap = createElement("div", { class: "msg-codeblock-wrap" });
  const { code, lang } = segment;

  if (lang !== null) {
    const label = createElement("span", { class: "msg-codeblock-lang" });
    setText(label, lang);
    wrap.appendChild(label);
  }

  const block = createElement("div", { class: "msg-codeblock" });
  if (segment.canonical !== null) block.setAttribute("data-lang", segment.canonical);
  for (const token of segment.tokens) {
    if (token.cls === null && token.ansi === undefined) {
      block.appendChild(document.createTextNode(token.text));
      continue;
    }
    const span = createElement("span", {
      class: token.cls === null ? (token.ansi ?? "") : `tok-${token.cls}`,
    });
    setText(span, token.text);
    block.appendChild(span);
  }

  const copyBtn = createElement("button", { class: "msg-codeblock-copy" });
  setText(copyBtn, messagingText("code.copy"));
  copyBtn.addEventListener("click", () => {
    copyThenRelabel(
      code,
      copyBtn,
      {
        idle: messagingText("code.copy"),
        done: messagingText("code.copied"),
        failed: messagingText("code.copyFailed"),
      },
      { ms: 2000 },
    );
  });

  wrap.appendChild(block);
  wrap.appendChild(copyBtn);
  return wrap;
}

// -- Parse cache --------------------------------------------------------------

/** Bounded LRU of parsed message content, keyed by the caller's identity
 *  string (message id + editedAt). Bounded so a long session does not retain a
 *  parse per message ever scrolled past; the cap is well above the rendered
 *  window. Cleared on teardown (clearContentParseCache) and invalidated by the
 *  key whenever a message is edited. */
const PARSE_CACHE_MAX = 200;
const parseCache = new Map<string, ParsedMessage>();

/** Drop every cached parse. The message list calls this on destroy. */
function clearContentParseCache(): void {
  parseCache.clear();
}

function parsedFor(content: string, cacheKey: string | undefined): ParsedMessage {
  if (cacheKey === undefined) return parseMessageContent(content);
  // The content is part of the internal key, not just the caller's id/editedAt:
  // a row whose content changed without its identity key moving (an in-flight
  // edit, or a test) must never be served the previous parse.
  const key = `${cacheKey}\u0001${content}`;
  const hit = parseCache.get(key);
  if (hit !== undefined) {
    // Re-insert to keep the entry at the LRU tail.
    parseCache.delete(key);
    parseCache.set(key, hit);
    return hit;
  }
  const parsed = parseMessageContent(content);
  parseCache.set(key, parsed);
  if (parseCache.size > PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  return parsed;
}

/**
 * Render message content to DOM.
 *
 * `cacheKey` (the message id plus its editedAt) opts into the parse cache: an
 * unchanged key reuses the parse and only rebuilds DOM, an edit changes the key
 * and re-parses. Omitted, every call parses afresh (the behaviour callers that
 * render ad-hoc strings rely on).
 */
function renderMessageContent(
  content: string,
  info?: MentionInfo,
  cacheKey?: string,
): DocumentFragment {
  const parsed = parsedFor(content, cacheKey);
  const fragment = document.createDocumentFragment();
  const jumboClass = isEmojiOnlyMessage(content) ? "msg-text msg-text-jumbo" : "msg-text";

  for (const segment of parsed.segments) {
    if (segment.kind === "code") {
      fragment.appendChild(renderParsedCodeBlock(segment));
      continue;
    }
    const text = createElement("div", { class: jumboClass });
    renderParsedBlocks(text, segment.blocks, info);
    fragment.appendChild(text);
  }

  return fragment;
}

/**
 * Rewrite the `<t:…>` timestamps under `root` in the current clock preference
 * and relative to now, for a 12h/24h switch or a passing midnight.
 */
function relabelInlineTimestamps(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLTimeElement>("time.md-timestamp")) {
    const ms = Date.parse(el.dateTime);
    if (Number.isNaN(ms)) continue;
    const style = (el.dataset["style"] ?? "f") as TimestampStyle;
    const { text, title } = formatDiscordTimestamp(ms / 1000, style);
    el.textContent = text;
    el.title = title;
  }
}

// ---- Tests -------------------------------------------------------------------

const TOKENS = [
  "**",
  "*",
  "_",
  "__",
  "~~",
  "||",
  "|",
  "`",
  "``",
  "```",
  "```js\n",
  "```ansi\n\u001b[31m",
  "```\n",
  "\n",
  "\n\n",
  "> ",
  ">>> ",
  "# ",
  "## ",
  "### ",
  "#### ",
  "-# ",
  "- ",
  "  - ",
  "1. ",
  "3) ",
  "\\",
  "[a](https://x.test)",
  "[b](javascript:alert(1))",
  "[c](https://x.test/a_(b))",
  "[@alice](https://x.test)",
  "<https://a.test>",
  "<javascript:x>",
  "https://example.com/a_(b).",
  "http://[::1]/x",
  "https://x.test/a|b",
  "<t:1700000000:R>",
  "<t:1700000000>",
  "<t:1700000000:F>",
  "<t:abc>",
  "@alice",
  "@Bob",
  "@me",
  "@everyone",
  "@here",
  "@nobody",
  "@alice.",
  "a@b.c",
  "<@10>",
  "<@99>",
  "<@12>",
  "<@&5>",
  "<@&6>",
  "<@&77>",
  "#general",
  "#off-topic",
  "#nope",
  "#dm-3",
  "owncord://message/1/2",
  "owncord://message/3/4",
  "owncord://message/9/9",
  "owncord://invite/abc",
  "owncord://invite/abc?host=h.test",
  "owncord://invite/x?host=other.example:443",
  ":smile:",
  ":nope:",
  ":+1:",
  "\u{1F600}",
  "\u{1F600}\u{1F600}",
  "word",
  " ",
  ".",
  ",",
  "(",
  ")",
  "<",
  ">",
  "[",
  "]",
  "!",
];

const textArb = fc
  .array(
    fc.oneof(
      { weight: 5, arbitrary: fc.constantFrom(...TOKENS) },
      { weight: 1, arbitrary: fc.string({ maxLength: 8 }) },
    ),
    { maxLength: 26 },
  )
  .map((parts) => parts.join(""));

const infoArb = fc.option(
  fc.record(
    {
      mentions: fc.array(fc.constantFrom(10, 11, 12), { maxLength: 3 }),
      mentionRoles: fc.array(fc.constantFrom(5, 6, 77), { maxLength: 3 }),
      mentionsEveryone: fc.boolean(),
    },
    { requiredKeys: [] },
  ),
  { nil: undefined },
);

/** Generous: 500 runs of two full renders each, and a 2 s default would end the run early. */
const HEAVY_TIMEOUT_MS = 60_000;
const RUNS = 500;

function html(fragment: DocumentFragment): string {
  const div = document.createElement("div");
  div.appendChild(fragment);
  return div.innerHTML;
}

function seed(): void {
  seedMembersAndChannels(
    [
      [10, { id: 10, username: "alice", avatar: null, role: "member", status: "online" }],
      [11, { id: 11, username: "Bob", avatar: null, role: "admin", status: "online" }],
      [12, { id: 12, username: "me", avatar: null, role: "member", status: "online" }],
    ],
    [
      { id: 1, name: "general", type: "text", category: null, position: 0 },
      { id: 2, name: "off-topic", type: "text", category: null, position: 1 },
      { id: 3, name: "dm-3", type: "dm", category: null, position: 0 },
    ],
  );
  setRoles([
    { id: 5, name: "mods", color: "#ff0000", permissions: 0, position: 1 },
    { id: 6, name: "odd", color: "red; background: url(x)", permissions: 0, position: 2 },
  ]);
}

beforeEach(() => {
  seed();
  clearContentParseCache();
  liveClear();
});
afterEach(() => {
  setRoles([]);
});

describe("content parser equals its frozen single-file form", () => {
  it(
    "renders message content identically, with and without a parse cache key",
    () => {
      fc.assert(
        fc.property(
          textArb,
          infoArb,
          fc.option(fc.constantFrom("a", "b"), { nil: undefined }),
          (text, info, key) => {
            expect(html(liveMessage(text, info, key))).toBe(
              html(renderMessageContent(text, info, key)),
            );
          },
        ),
        { numRuns: RUNS },
      );
    },
    HEAVY_TIMEOUT_MS,
  );

  it(
    "serves and evicts the parse cache the same way over a run of keyed renders",
    () => {
      const step = fc.record({
        text: textArb,
        key: fc.integer({ min: 0, max: 230 }).map((n) => `k${n}`),
      });
      fc.assert(
        fc.property(fc.array(step, { minLength: 1, maxLength: 12 }), (steps) => {
          for (const { text, key } of steps) {
            expect(html(liveMessage(text, undefined, key))).toBe(
              html(renderMessageContent(text, undefined, key)),
            );
          }
        }),
        { numRuns: 100 },
      );
    },
    HEAVY_TIMEOUT_MS,
  );

  it(
    "renders inline runs, mention segments and URL runs identically",
    () => {
      fc.assert(
        fc.property(textArb, infoArb, (text, info) => {
          expect(html(liveInline(text, info))).toBe(html(renderInlineContent(text, info)));
          expect(html(liveSegment(text, info))).toBe(html(renderMentionSegment(text, info)));
          expect(html(liveMentions(text, info))).toBe(html(renderMentions(text, info)));
          expect(liveStrip(text)).toBe(stripUrlTrailingPunctuation(text));
        }),
        { numRuns: RUNS },
      );
    },
    HEAVY_TIMEOUT_MS,
  );

  it(
    "reveals spoilers and relabels timestamps identically",
    () => {
      fc.assert(
        fc.property(textArb, (text) => {
          const live = document.createElement("div");
          const frozen = document.createElement("div");
          live.appendChild(liveMessage(text));
          frozen.appendChild(renderMessageContent(text));
          for (const root of [live, frozen]) {
            for (const el of root.querySelectorAll<HTMLElement>(".msg-spoiler")) el.click();
          }
          liveRelabel(live);
          relabelInlineTimestamps(frozen);
          expect(live.innerHTML).toBe(frozen.innerHTML);
        }),
        { numRuns: 200 },
      );
    },
    HEAVY_TIMEOUT_MS,
  );

  it(
    "resyncs rendered mentions identically after the member and role stores change",
    () => {
      fc.assert(
        fc.property(textArb, infoArb, fc.boolean(), (text, info, rename) => {
          const live = document.createElement("div");
          const frozen = document.createElement("div");
          live.appendChild(liveMessage(text, info));
          frozen.appendChild(renderMessageContent(text, info));
          const before = membersStore.getState().members;
          membersStore.setState((s) => ({
            ...s,
            members: new Map(
              [...before].flatMap(([id, m]): Array<[number, typeof m]> =>
                id === 11 ? [] : [[id, rename ? { ...m, displayName: `nick${id}` } : m]],
              ),
            ),
          }));
          setRoles([{ id: 5, name: "renamed", color: "#00ff00", permissions: 0, position: 1 }]);
          try {
            liveResync(live, info);
            resyncMentions(frozen, info);
            expect(live.innerHTML).toBe(frozen.innerHTML);
          } finally {
            membersStore.setState((s) => ({ ...s, members: before }));
            seed();
          }
        }),
        { numRuns: 200 },
      );
    },
    HEAVY_TIMEOUT_MS,
  );
});

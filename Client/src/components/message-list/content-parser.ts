/**
 * Text content parsing — XSS-safe DOM builders for message text.
 *
 * This is the *only* renderer for message content: Discord-flavoured markdown
 * (inline styles, spoilers, quotes, headings, lists, masked links, fenced code
 * with language tags), plus @mentions, #channel links and URL linkification.
 *
 * Everything here builds DOM nodes — never innerHTML — and every href is
 * checked with isSafeUrl before it reaches an anchor.
 */

import { createElement, setText } from "@lib/dom";
import { navigateToChannel, findChannelByName, findChannelById } from "@lib/channel-navigation";
import { parseMessageLink } from "@lib/deep-link";
import { jumpToMessage } from "@lib/message-navigation";
import { authStore } from "@stores/auth.store";
import {
  CHANNEL_TOKEN_REGEX,
  MENTION_TOKEN_REGEX,
  isEveryoneToken,
  resolveMentionUserId,
  type MentionInfo,
} from "@lib/mentions";
import { isSafeUrl } from "./attachments";
import { EMOJI_TOKEN_REGEX, buildCustomEmojiNode, isEmojiOnlyMessage } from "./custom-emoji";
import { messagingText } from "../../i18n/messaging";
import {
  parseInline,
  parseBlocks,
  splitCodeFences,
  type InlineNode,
  type InlineStyle,
} from "@lib/markdown";
import { highlightCode, resolveLanguage, type CodeToken } from "./syntax-highlight";

// -- Regex constants ----------------------------------------------------------

export const CODE_BLOCK_REGEX = /```([\s\S]*?)```/g;
export const INLINE_CODE_REGEX = /`([^`]+)`/g;
export const URL_REGEX = /https?:\/\/[^\s<>"']+/g;
/** `[text](url)` — used to keep masked links from spawning link embeds. */
export const MASKED_LINK_REGEX = /\[[^\]\n]+\]\((?:[^()\s]|\([^()\s]*\))+\)/g;
/**
 * `||hidden||` — used to keep spoilered URLs from spawning embeds. Mirrors
 * the tokeniser in `@lib/markdown`: the span closes at the first `||` after
 * its opener, holds at least one character (so `||||` is not a spoiler), may
 * span lines but not a blank line (a paragraph break), a lone `|` is text, and
 * a backslash escape (`\|`) is content that never closes the span.
 */
export const SPOILER_REGEX = /\|\|(?!\|)(?:\\[\s\S]|(?!\|\|)(?!\n[^\S\n]*\n)[^\\])+\|\|/g;
/** `owncord://message/<channelId>/<messageId>` pasted into a message. */
export const MESSAGE_LINK_REGEX = /owncord:\/\/message\/\d+\/\d+/g;

export type { MentionInfo };

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
export function stripUrlTrailingPunctuation(rawUrl: string): string {
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
export function renderInlineContent(text: string, info?: MentionInfo): DocumentFragment {
  const fragment = document.createDocumentFragment();
  appendInline(fragment, parseInline(text), info);
  return fragment;
}

export function renderMentions(text: string, info?: MentionInfo): DocumentFragment {
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
    "data-user-id": String(userId),
  });
  setText(span, raw);
  return span;
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

/**
 * Render @mentions, #channel links and message permalinks within a text
 * segment (no http URLs). Tokens that resolve to nothing are left as plain text.
 */
export function renderMentionSegment(text: string, info?: MentionInfo): DocumentFragment {
  const matches: TokenMatch[] = [];

  for (const match of text.matchAll(MESSAGE_LINK_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    const node = buildMessageLinkNode(match[0]);
    if (node !== null) matches.push({ start: idx, end: idx + match[0].length, node });
  }

  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const idx = match.index;
    const lead = match[1];
    const token = match[2];
    if (idx === undefined || lead === undefined || token === undefined) continue;
    if (match[3] === "@") continue; // address-shaped, e.g. "@bob@example.com"
    const start = idx + lead.length;
    const node = buildMentionNode(`@${token}`, token, info);
    if (node !== null) matches.push({ start, end: start + token.length + 1, node });
  }

  for (const match of text.matchAll(CHANNEL_TOKEN_REGEX)) {
    const idx = match.index;
    const lead = match[1];
    const name = match[2];
    if (idx === undefined || lead === undefined || name === undefined) continue;
    const start = idx + lead.length;
    const node = buildChannelNode(name);
    if (node !== null) matches.push({ start, end: start + name.length + 1, node });
  }

  // `:shortcode:` custom emoji. This runs on prose segments only — code spans
  // never reach here (appendInline renders them verbatim) and fenced blocks are
  // split off before any of this, so a shortcode inside code stays code.
  for (const match of text.matchAll(EMOJI_TOKEN_REGEX)) {
    const idx = match.index;
    const shortcode = match[1];
    if (idx === undefined || shortcode === undefined) continue;
    const node = buildCustomEmojiNode(shortcode);
    if (node !== null) matches.push({ start: idx, end: idx + match[0].length, node });
  }

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

/** Elements whose text is never mention-highlighted at render time, so the
 *  mention resync must leave them alone: code spans/blocks, existing pills and
 *  chips, a rejected masked link left as raw text, and autolinked URLs (whose
 *  text is the URL itself, which may contain an `/@token` path). A masked
 *  `[text](url)` link does get mentions rendered inside it, so `.masked` links
 *  stay transparent. */
const MENTION_OPAQUE_SELECTOR =
  "code, .msg-codeblock, .mention, .channel-mention, .message-link-chip, .msg-link-raw, .msg-link:not(.masked)";

/** Whether a rebuilt pill is identical to the one already in the DOM. */
function sameMention(a: HTMLElement, b: HTMLElement): boolean {
  return a.className === b.className && (a.dataset["userId"] ?? "") === (b.dataset["userId"] ?? "");
}

/**
 * Wrap the @tokens in one plain prose run that resolve against the live member
 * store, leaving every other token (`#channel`, `:emoji:`, unresolved @) as the
 * text it already is. Returns null when nothing in the run resolves.
 */
function wrapResolvedMentions(text: string, info?: MentionInfo): DocumentFragment | null {
  const matches: TokenMatch[] = [];
  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const idx = match.index;
    const lead = match[1];
    const token = match[2];
    if (idx === undefined || lead === undefined || token === undefined) continue;
    if (match[3] === "@") continue;
    const start = idx + lead.length;
    const node = buildMentionNode(`@${token}`, token, info);
    if (node !== null) matches.push({ start, end: start + token.length + 1, node });
  }
  if (matches.length === 0) return null;
  const fragment = document.createDocumentFragment();
  let last = 0;
  for (const m of matches) {
    if (m.start < last) continue;
    if (m.start > last) fragment.appendChild(document.createTextNode(text.slice(last, m.start)));
    fragment.appendChild(m.node);
    last = m.end;
  }
  if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
  return fragment;
}

/**
 * Re-resolve the @mention spans already rendered under `root` against the live
 * member store, and wrap plain @tokens inside it that now resolve. Called when
 * a membership/role/profile change bumps roleRevision, so the pills track a
 * rename without re-parsing or rebuilding the row (P4-02) — in both directions:
 * a token that stopped resolving is unwrapped to plain text, one that started
 * resolving becomes a pill. Scoped to the two regions mentions are rendered
 * into (.msg-text and .sm-text), so an author's display name or a reply
 * preview, where render never highlights a mention, is left alone.
 */
export function resyncMentions(root: ParentNode, info?: MentionInfo): void {
  for (const content of root.querySelectorAll(".msg-text, .sm-text")) {
    // querySelectorAll returns a static list, so replacing a span as we go does
    // not disturb the walk.
    for (const span of content.querySelectorAll<HTMLElement>(".mention")) {
      const raw = span.textContent ?? "";
      const token = raw.startsWith("@") ? raw.slice(1) : raw;
      const replacement = buildMentionNode(raw, token, info);
      if (replacement !== null && sameMention(span, replacement)) continue;
      span.replaceWith(replacement ?? document.createTextNode(raw));
    }

    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      textNodes.push(n as Text);
    }
    for (const textNode of textNodes) {
      if (textNode.nodeValue?.includes("@") !== true) continue;
      const parent = textNode.parentElement;
      if (parent === null || parent.closest(MENTION_OPAQUE_SELECTOR) !== null) continue;
      const wrapped = wrapResolvedMentions(textNode.nodeValue ?? "", info);
      if (wrapped !== null) textNode.replaceWith(wrapped);
    }
  }
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
    if (token.cls === null) {
      block.appendChild(document.createTextNode(token.text));
      continue;
    }
    const span = createElement("span", { class: `tok-${token.cls}` });
    setText(span, token.text);
    block.appendChild(span);
  }

  const copyBtn = createElement("button", { class: "msg-codeblock-copy" });
  setText(copyBtn, messagingText("code.copy"));
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        setText(copyBtn, messagingText("code.copied"));
        setTimeout(() => setText(copyBtn, messagingText("code.copy")), 2000);
      })
      .catch(() => {
        setText(copyBtn, messagingText("code.copyFailed"));
        setTimeout(() => setText(copyBtn, messagingText("code.copy")), 2000);
      });
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
export function clearContentParseCache(): void {
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
export function renderMessageContent(
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

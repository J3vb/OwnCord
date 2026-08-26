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
import {
  parseInline,
  parseBlocks,
  type BlockNode,
  type InlineNode,
  type InlineStyle,
} from "./markdown";
import { highlightCode, resolveLanguage } from "./syntax-highlight";

// -- Regex constants ----------------------------------------------------------

export const CODE_BLOCK_REGEX = /```([\s\S]*?)```/g;
export const INLINE_CODE_REGEX = /`([^`]+)`/g;
export const URL_REGEX = /https?:\/\/[^\s<>"']+/g;
/** `[text](url)` — used to keep masked links from spawning link embeds. */
export const MASKED_LINK_REGEX = /\[[^\]\n]+\]\((?:[^()\s]|\([^()\s]*\))+\)/g;
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
    "aria-label": "Spoiler — click to reveal",
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
    span.setAttribute("aria-label", "Spoiler — revealed");
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
    class: "msg-link",
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
        else parent.appendChild(document.createTextNode(node.raw));
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
      fragment.appendChild(document.createTextNode(rawUrl));
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
    title: `Go to #${channel.name}`,
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

  const chip = createElement("span", {
    class: "message-link-chip",
    role: "link",
    tabindex: "0",
    "data-channel-id": String(link.channelId),
    "data-message-id": String(link.messageId),
    title: `Jump to message in #${channel.name}`,
  });
  const label = createElement("span", { class: "mlc-channel" });
  setText(label, `#${channel.name}`);
  const action = createElement("span", { class: "mlc-action" });
  setText(action, "Jump");
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

// -- Block rendering ----------------------------------------------------------

/** Render list items, folding indented ones into a single nested level. */
function buildList(
  block: Extract<BlockNode, { type: "list" }>,
  info: MentionInfo | undefined,
): HTMLElement {
  const root = createElement(block.ordered ? "ol" : "ul", { class: "md-list" });
  if (block.ordered && block.start !== 1) root.setAttribute("start", String(block.start));
  let sublist: HTMLElement | null = null;

  for (const item of block.items) {
    const li = createElement("li", { class: "md-li" });
    appendInline(li, parseInline(item.text), info);

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

/** Append the block structure of `text` to `parent`. */
function appendBlocks(parent: HTMLElement, text: string, info?: MentionInfo, depth = 0): void {
  for (const block of parseBlocks(text)) {
    switch (block.type) {
      case "heading": {
        const heading = createElement(`h${block.level}`, {
          class: `md-heading md-h${block.level}`,
        });
        appendInline(heading, parseInline(block.text), info);
        parent.appendChild(heading);
        break;
      }
      case "quote": {
        const quote = createElement("blockquote", { class: "md-quote" });
        if (depth + 1 >= MAX_BLOCK_DEPTH) {
          const para = createElement("div", { class: "md-p" });
          appendInline(para, parseInline(block.text), info);
          quote.appendChild(para);
        } else {
          appendBlocks(quote, block.text, info, depth + 1);
        }
        parent.appendChild(quote);
        break;
      }
      case "list":
        parent.appendChild(buildList(block, info));
        break;
      default: {
        const para = createElement("div", { class: "md-p" });
        appendInline(para, parseInline(block.text), info);
        parent.appendChild(para);
      }
    }
  }
}

// -- Code fences --------------------------------------------------------------

interface Segment {
  readonly kind: "prose" | "code";
  readonly text: string;
  /** Raw fence tag, e.g. "ts" — present only on code segments that had one. */
  readonly lang: string | null;
}

const FENCE = "```";
const LANG_TAG_REGEX = /^[A-Za-z][\w+#-]{0,19}$/;

/** Split a message into prose and fenced-code segments. */
export function splitCodeFences(content: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  while (i < content.length) {
    const open = content.indexOf(FENCE, i);
    const close = open < 0 ? -1 : content.indexOf(FENCE, open + FENCE.length);
    if (open < 0 || close < 0) break;

    if (open > i) segments.push({ kind: "prose", text: content.slice(i, open), lang: null });

    const inner = content.slice(open + FENCE.length, close);
    const newline = inner.indexOf("\n");
    const tag = newline > 0 ? inner.slice(0, newline).trim() : "";
    if (tag.length > 0 && LANG_TAG_REGEX.test(tag)) {
      segments.push({
        kind: "code",
        text: inner.slice(newline + 1).replace(/\s+$/, ""),
        lang: tag,
      });
    } else {
      segments.push({ kind: "code", text: inner.trim(), lang: null });
    }
    i = close + FENCE.length;
  }
  if (i < content.length) segments.push({ kind: "prose", text: content.slice(i), lang: null });
  return segments;
}

/** A code block: language label, highlighted body, copy button. */
function renderCodeBlock(code: string, lang: string | null): HTMLDivElement {
  const wrap = createElement("div", { class: "msg-codeblock-wrap" });

  if (lang !== null) {
    const label = createElement("span", { class: "msg-codeblock-lang" });
    setText(label, lang);
    wrap.appendChild(label);
  }

  const block = createElement("div", { class: "msg-codeblock" });
  const canonical = resolveLanguage(lang);
  if (canonical !== null) block.setAttribute("data-lang", canonical);
  for (const token of highlightCode(code, canonical)) {
    if (token.cls === null) {
      block.appendChild(document.createTextNode(token.text));
      continue;
    }
    const span = createElement("span", { class: `tok-${token.cls}` });
    setText(span, token.text);
    block.appendChild(span);
  }

  const copyBtn = createElement("button", { class: "msg-codeblock-copy" });
  setText(copyBtn, "Copy");
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        setText(copyBtn, "Copied!");
        setTimeout(() => setText(copyBtn, "Copy"), 2000);
      })
      .catch(() => {
        setText(copyBtn, "Failed");
        setTimeout(() => setText(copyBtn, "Copy"), 2000);
      });
  });

  wrap.appendChild(block);
  wrap.appendChild(copyBtn);
  return wrap;
}

export function renderMessageContent(content: string, info?: MentionInfo): DocumentFragment {
  const fragment = document.createDocumentFragment();

  // A message that is nothing but emoji renders them large, the way Discord
  // does. Decided once over the whole content — the class is what sizes both
  // the unicode glyphs and the custom-emoji images, so nothing downstream has
  // to be told about it.
  const jumboClass = isEmojiOnlyMessage(content) ? "msg-text msg-text-jumbo" : "msg-text";

  for (const segment of splitCodeFences(content)) {
    if (segment.kind === "code") {
      fragment.appendChild(renderCodeBlock(segment.text, segment.lang));
      continue;
    }
    // Blank lines hugging a fence are formatting, not content.
    const prose = segment.text.replace(/^\n+/, "").replace(/\n+$/, "");
    if (prose.trim().length === 0) continue;
    const text = createElement("div", { class: jumboClass });
    appendBlocks(text, prose, info);
    fragment.appendChild(text);
  }

  return fragment;
}

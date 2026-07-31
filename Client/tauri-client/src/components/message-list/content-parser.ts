/**
 * Text content parsing — XSS-safe DOM builders for message text including
 * inline code, code blocks, @mentions, #channel links, and URL linkification.
 */

import { createElement, setText } from "@lib/dom";
import { navigateToChannel, findChannelByName } from "@lib/channel-navigation";
import { authStore } from "@stores/auth.store";
import {
  CHANNEL_TOKEN_REGEX,
  MENTION_TOKEN_REGEX,
  isEveryoneToken,
  resolveMentionUserId,
  type MentionInfo,
} from "@lib/mentions";
import { isSafeUrl } from "./attachments";

// -- Regex constants ----------------------------------------------------------

export const CODE_BLOCK_REGEX = /```([\s\S]*?)```/g;
export const INLINE_CODE_REGEX = /`([^`]+)`/g;
export const URL_REGEX = /https?:\/\/[^\s<>"']+/g;

export type { MentionInfo };

// -- Content rendering --------------------------------------------------------

export function renderInlineContent(text: string, info?: MentionInfo): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_CODE_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    if (idx > lastIndex) {
      fragment.appendChild(renderMentions(text.slice(lastIndex, idx), info));
    }
    const code = createElement("code", {});
    setText(code, match[1]!);
    fragment.appendChild(code);
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(renderMentions(text.slice(lastIndex), info));
  }
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
    const stripped = rawUrl.replace(/[.,;:!?)]+$/, "");
    const trailing = rawUrl.slice(stripped.length);
    const url = stripped || rawUrl; // fallback if stripping emptied it
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
 * Render @mentions and #channel links within a text segment (no URLs).
 * Tokens that resolve to nothing are left as plain text.
 */
export function renderMentionSegment(text: string, info?: MentionInfo): DocumentFragment {
  const matches: TokenMatch[] = [];

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

export function renderMessageContent(content: string, info?: MentionInfo): DocumentFragment {
  const fragment = document.createDocumentFragment();

  // Split on triple-backtick boundaries to avoid ReDoS from greedy regex.
  // Odd-indexed segments are code block contents; even-indexed are prose.
  const parts = content.split("```");

  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i]!;
    if (i % 2 === 0) {
      // Prose segment
      const trimmed = i === 0 ? segment : i === parts.length - 1 ? segment.trim() : segment;
      if (trimmed.length > 0) {
        const text = createElement("div", { class: "msg-text" });
        text.appendChild(renderInlineContent(trimmed, info));
        fragment.appendChild(text);
      }
    } else {
      // Code block segment
      const codeContent = segment.trim();
      const codeWrap = createElement("div", { class: "msg-codeblock-wrap" });
      const codeBlock = createElement("div", { class: "msg-codeblock" });
      setText(codeBlock, codeContent);
      const copyBtn = createElement("button", { class: "msg-codeblock-copy" });
      setText(copyBtn, "Copy");
      copyBtn.addEventListener("click", () => {
        void navigator.clipboard
          .writeText(codeContent)
          .then(() => {
            setText(copyBtn, "Copied!");
            setTimeout(() => setText(copyBtn, "Copy"), 2000);
          })
          .catch(() => {
            setText(copyBtn, "Failed");
            setTimeout(() => setText(copyBtn, "Copy"), 2000);
          });
      });
      codeWrap.appendChild(codeBlock);
      codeWrap.appendChild(copyBtn);
      fragment.appendChild(codeWrap);
    }
  }

  // If there were no code blocks at all, ensure at least one text node
  if (parts.length === 1) {
    const text = createElement("div", { class: "msg-text" });
    text.appendChild(renderInlineContent(content, info));
    // Replace the fragment content (it already has the same, but handle empty edge case)
    if (fragment.childNodes.length === 0) {
      fragment.appendChild(text);
    }
  }

  return fragment;
}

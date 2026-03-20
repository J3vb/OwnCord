/**
 * Text content parsing — XSS-safe DOM builders for message text including
 * inline code, code blocks, @mentions, and URL linkification.
 */

import {
  createElement,
  setText,
} from "@lib/dom";
import { isSafeUrl } from "./attachments";

// -- Regex constants ----------------------------------------------------------

export const MENTION_REGEX = /@(\w+)/g;
export const CODE_BLOCK_REGEX = /```([\s\S]*?)```/g;
export const INLINE_CODE_REGEX = /`([^`]+)`/g;
export const URL_REGEX = /https?:\/\/[^\s<>"']+/g;

// -- Content rendering --------------------------------------------------------

export function renderInlineContent(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_CODE_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    if (idx > lastIndex) {
      fragment.appendChild(renderMentions(text.slice(lastIndex, idx)));
    }
    const code = createElement("code", {});
    setText(code, match[1]!);
    fragment.appendChild(code);
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(renderMentions(text.slice(lastIndex)));
  }
  return fragment;
}

export function renderMentions(text: string): DocumentFragment {
  // First pass: split by URLs, then handle mentions in non-URL segments
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of text.matchAll(URL_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    if (idx > lastIndex) {
      fragment.appendChild(renderMentionSegment(text.slice(lastIndex, idx)));
    }
    const url = match[0];
    if (isSafeUrl(url)) {
      const link = createElement("a", {
        class: "msg-link",
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
      });
      setText(link, url);
      fragment.appendChild(link);
    } else {
      fragment.appendChild(document.createTextNode(url));
    }
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(renderMentionSegment(text.slice(lastIndex)));
  }
  return fragment;
}

/** Render @mentions within a text segment (no URLs). */
export function renderMentionSegment(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of text.matchAll(MENTION_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    if (idx > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
    }
    const span = createElement("span", { class: "mention" });
    setText(span, match[0]);
    fragment.appendChild(span);
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
  return fragment;
}

export function renderMessageContent(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of content.matchAll(CODE_BLOCK_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    if (idx > lastIndex) {
      const text = createElement("div", { class: "msg-text" });
      text.appendChild(renderInlineContent(content.slice(lastIndex, idx)));
      fragment.appendChild(text);
    }
    const codeBlock = createElement("div", { class: "msg-codeblock" });
    setText(codeBlock, match[1]!.trim());
    fragment.appendChild(codeBlock);
    lastIndex = idx + match[0].length;
  }
  if (lastIndex === 0) {
    const text = createElement("div", { class: "msg-text" });
    text.appendChild(renderInlineContent(content));
    fragment.appendChild(text);
  } else if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex).trim();
    if (remaining.length > 0) {
      const text = createElement("div", { class: "msg-text" });
      text.appendChild(renderInlineContent(remaining));
      fragment.appendChild(text);
    }
  }
  return fragment;
}

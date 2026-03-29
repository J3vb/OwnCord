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

  // Split on triple-backtick boundaries to avoid ReDoS from greedy regex.
  // Odd-indexed segments are code block contents; even-indexed are prose.
  const parts = content.split("```");

  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i]!;
    if (i % 2 === 0) {
      // Prose segment
      const trimmed = i === 0 ? segment : (i === parts.length - 1 ? segment.trim() : segment);
      if (trimmed.length > 0) {
        const text = createElement("div", { class: "msg-text" });
        text.appendChild(renderInlineContent(trimmed));
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
        void navigator.clipboard.writeText(codeContent).then(() => {
          setText(copyBtn, "Copied!");
          setTimeout(() => setText(copyBtn, "Copy"), 2000);
        }).catch(() => {
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
    text.appendChild(renderInlineContent(content));
    // Replace the fragment content (it already has the same, but handle empty edge case)
    if (fragment.childNodes.length === 0) {
      fragment.appendChild(text);
    }
  }

  return fragment;
}

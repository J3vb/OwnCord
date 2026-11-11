/**
 * Inline rendering: markdown styles, code spans, spoilers, masked and angle
 * links, timestamps, and the URL autolinking of plain text runs.
 */

import { createElement, setText } from "@lib/dom";
import type { MentionInfo } from "@lib/text/mentions";
import { formatDiscordTimestamp } from "@lib/text/discordTimestamp";
import { parseInline, type InlineNode, type InlineStyle } from "@lib/text/markdown";
import { isSafeUrl } from "./attachments";
import { messagingText } from "../../../i18n/messaging";
import { URL_REGEX, stripUrlTrailingPunctuation } from "./contentRegex";
import { renderMentionSegment, stripMentionControl } from "./contentMentions";

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
export function appendInline(parent: Node, nodes: readonly InlineNode[], info?: MentionInfo): void {
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

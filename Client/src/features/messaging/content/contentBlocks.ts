/**
 * Block rendering: headings, quotes, lists, paragraphs and fenced code blocks
 * built as DOM from the parsed form.
 */

import { createElement, setText } from "@lib/dom";
import type { MentionInfo } from "@lib/text/mentions";
import { copyThenRelabel } from "@lib/ui/clipboard";
import { messagingText } from "../../../i18n/messaging";
import { appendInline } from "./contentInline";
import type { ParsedBlock, ParsedSegment } from "./contentParse";

// -- Block rendering ----------------------------------------------------------

/** Render list items, folding indented ones into a single nested level. */
export function renderParsedList(
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
export function renderParsedBlocks(
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
export function renderParsedCodeBlock(
  segment: Extract<ParsedSegment, { kind: "code" }>,
): HTMLDivElement {
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

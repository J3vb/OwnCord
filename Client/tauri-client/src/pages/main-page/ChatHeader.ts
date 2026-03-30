/**
 * ChatHeader — builds the channel header bar with name, topic, pins, and search.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatHeaderRefs {
  readonly hashEl: HTMLSpanElement;
  readonly nameEl: HTMLSpanElement;
  readonly topicEl: HTMLSpanElement;
}

export interface ChatHeaderOptions {
  readonly onTogglePins: () => void;
  readonly onSearchFocus?: () => void;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildChatHeader(
  opts: ChatHeaderOptions,
): { element: HTMLDivElement; refs: ChatHeaderRefs } {
  const header = createElement("div", { class: "chat-header", "data-testid": "chat-header" });
  const hash = createElement("span", { class: "ch-hash" }, "#");
  const nameEl = createElement("span", { class: "ch-name", "data-testid": "chat-header-name" }, "general");
  const divider = createElement("div", { class: "ch-divider" });
  const topicEl = createElement("span", { class: "ch-topic" }, "");

  const tools = createElement("div", { class: "ch-tools" });
  const pinBtn = createElement("button", {
    type: "button",
    class: "pin-btn",
    title: "Pins",
    "aria-label": "Pins",
    "data-testid": "pin-btn",
  });
  pinBtn.appendChild(createIcon("pin", 18));
  pinBtn.addEventListener("click", () => { opts.onTogglePins(); });
  const searchInput = createElement("input", {
    class: "search-input",
    type: "text",
    placeholder: "Search...",
    "data-testid": "search-input",
  });
  if (opts.onSearchFocus !== undefined) {
    const onFocus = opts.onSearchFocus;
    searchInput.addEventListener("focus", () => {
      onFocus();
      (searchInput).blur();
    });
  }
  appendChildren(tools, searchInput, pinBtn);

  appendChildren(header, hash, nameEl, divider, topicEl, tools);
  return { element: header, refs: { hashEl: hash, nameEl, topicEl } };
}

// ---------------------------------------------------------------------------
// DM mode helper
// ---------------------------------------------------------------------------

export function updateChatHeaderForDm(
  refs: ChatHeaderRefs,
  recipient: { username: string; status: string } | null,
): void {
  if (recipient !== null) {
    setText(refs.hashEl, "@");
    setText(refs.nameEl, recipient.username);
    setText(refs.topicEl, recipient.status);
  } else {
    setText(refs.hashEl, "#");
  }
}

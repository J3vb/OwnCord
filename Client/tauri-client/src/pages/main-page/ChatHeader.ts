/**
 * ChatHeader — builds the channel header bar with name, topic, pins, search,
 * and member-list toggle.
 */

import { createElement, appendChildren } from "@lib/dom";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatHeaderRefs {
  readonly nameEl: HTMLSpanElement;
  readonly topicEl: HTMLSpanElement;
}

export interface ChatHeaderOptions {
  readonly onTogglePins: () => void;
  readonly onToggleMembers: () => void;
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
  }, "\uD83D\uDCCC");
  pinBtn.addEventListener("click", () => { opts.onTogglePins(); });
  const searchInput = createElement("input", {
    class: "search-input",
    type: "text",
    placeholder: "Search...",
  });
  const membersToggle = createElement("button", {
    type: "button",
    "aria-label": "Toggle member list",
    "data-testid": "members-toggle",
  }, "\uD83D\uDC65");
  membersToggle.addEventListener("click", () => opts.onToggleMembers());
  appendChildren(tools, searchInput, pinBtn, membersToggle);

  appendChildren(header, hash, nameEl, divider, topicEl, tools);
  return { element: header, refs: { nameEl, topicEl } };
}

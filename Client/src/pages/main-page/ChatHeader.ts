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
  /** The DM call button. Hidden outside DMs — a guild voice channel is joined
   *  from the sidebar, and a text channel has nobody in particular to call. */
  readonly callBtn: HTMLButtonElement;
}

export interface ChatHeaderOptions {
  readonly onTogglePins: () => void;
  readonly onSearchFocus?: () => void;
  readonly onToggleDmProfile?: () => void;
  /** Start a call in the current DM: join its voice channel and ring. */
  readonly onStartCall?: () => void;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildChatHeader(opts: ChatHeaderOptions): {
  element: HTMLDivElement;
  refs: ChatHeaderRefs;
} {
  const header = createElement("div", { class: "chat-header", "data-testid": "chat-header" });
  const hash = createElement("span", { class: "ch-hash" }, "#");
  const nameEl = createElement(
    "span",
    { class: "ch-name", "data-testid": "chat-header-name" },
    "general",
  );

  // Wrap hash+name in a clickable region for DM profile toggle
  const nameGroup = createElement("div", {
    class: "ch-name-group",
    "data-testid": "ch-name-group",
  });
  nameGroup.style.display = "flex";
  nameGroup.style.alignItems = "center";
  nameGroup.style.gap = "0";
  if (opts.onToggleDmProfile !== undefined) {
    const toggle = opts.onToggleDmProfile;
    nameGroup.style.cursor = "pointer";
    nameGroup.addEventListener("click", () => {
      toggle();
    });
  }
  appendChildren(nameGroup, hash, nameEl);

  const divider = createElement("div", { class: "ch-divider" });
  const topicEl = createElement("span", { class: "ch-topic" }, "");

  const tools = createElement("div", { class: "ch-tools" });
  const callBtn = createElement("button", {
    type: "button",
    class: "call-btn",
    title: "Start a call",
    "aria-label": "Start a call",
    "data-testid": "call-btn",
  });
  callBtn.appendChild(createIcon("phone", 18));
  callBtn.style.display = "none";
  if (opts.onStartCall !== undefined) {
    const start = opts.onStartCall;
    callBtn.addEventListener("click", () => start());
  }
  const pinBtn = createElement("button", {
    type: "button",
    class: "pin-btn",
    title: "Pins",
    "aria-label": "Pins",
    "data-testid": "pin-btn",
  });
  pinBtn.appendChild(createIcon("pin", 18));
  pinBtn.addEventListener("click", () => {
    opts.onTogglePins();
  });
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
      searchInput.blur();
    });
  }
  appendChildren(tools, searchInput, callBtn, pinBtn);

  appendChildren(header, nameGroup, divider, topicEl, tools);
  return { element: header, refs: { hashEl: hash, nameEl, topicEl, callBtn } };
}

// ---------------------------------------------------------------------------
// DM mode helper
// ---------------------------------------------------------------------------

/**
 * Put the header into DM mode (or, with null, back into channel mode).
 *
 * `subtitle` is what sits where a channel topic would: the other party's
 * presence for a 1:1 DM, and the member list for a group — a group has no
 * single status to show, and "who is in here" is the fact that matters.
 */
export function updateChatHeaderForDm(
  refs: ChatHeaderRefs,
  recipient: { username: string; status: string } | null,
): void {
  if (recipient !== null) {
    setText(refs.hashEl, "@");
    setText(refs.nameEl, recipient.username);
    setText(refs.topicEl, recipient.status);
    refs.callBtn.style.display = "";
  } else {
    setText(refs.hashEl, "#");
    refs.callBtn.style.display = "none";
  }
}

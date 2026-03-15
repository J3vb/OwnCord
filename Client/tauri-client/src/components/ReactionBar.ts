/**
 * Step 5.44 — ReactionBar factory.
 * Creates a row of reaction pills for a single message.
 * Returns an HTMLDivElement (not a MountableComponent).
 */

import { createElement, appendChildren, setText } from "@lib/dom";

export interface ReactionDisplay {
  readonly emoji: string;
  readonly count: number;
  readonly me: boolean;
}

export interface ReactionBarOptions {
  readonly reactions: readonly ReactionDisplay[];
  readonly onToggle: (emoji: string) => void;
}

function createReactionPill(
  reaction: ReactionDisplay,
  onToggle: (emoji: string) => void,
  signal: AbortSignal,
): HTMLButtonElement {
  const classes = reaction.me
    ? "reaction-chip me"
    : "reaction-chip";

  const btn = createElement("button", { class: classes });

  const emojiSpan = createElement(
    "span",
    {},
    reaction.emoji,
  );
  const countSpan = createElement(
    "span",
    { class: "rc-count" },
    String(reaction.count),
  );

  appendChildren(btn, emojiSpan, countSpan);

  btn.addEventListener(
    "click",
    () => {
      onToggle(reaction.emoji);
    },
    { signal },
  );

  return btn;
}

export function createReactionBar(
  options: ReactionBarOptions,
): HTMLDivElement {
  const ac = new AbortController();
  const bar = createElement("div", { class: "msg-reactions" });

  for (const reaction of options.reactions) {
    const pill = createReactionPill(reaction, options.onToggle, ac.signal);
    bar.appendChild(pill);
  }

  const addBtn = createElement(
    "button",
    { class: "reaction-chip add-reaction", "aria-label": "Add reaction" },
    "+",
  );

  addBtn.addEventListener(
    "click",
    () => {
      bar.dispatchEvent(
        new CustomEvent("add-reaction", { bubbles: true }),
      );
    },
    { signal: ac.signal },
  );

  bar.appendChild(addBtn);

  return bar;
}

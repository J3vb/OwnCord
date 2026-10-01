/**
 * Reaction pill rendering — emoji reaction chips with counts and toggle behavior.
 */

import { createElement } from "@lib/dom";
import type { Message } from "@stores/messages.store";
import { safetyStore } from "../../features/safety/store";
import { formatUntil, safetyText } from "../../i18n/safety";
import type { MessageListOptions } from "../MessageList";
import { attachReactionTooltip } from "./reaction-tooltip";
import { buildCustomEmojiNode } from "./custom-emoji";

// -- Reaction rendering -------------------------------------------------------

/** While timed out (B9-15, Q4): why reacting is disabled, with the server's expiry; else null. */
export function reactionLockReason(): string | null {
  const timeout = safetyStore.getState().timeout;
  return timeout === null
    ? null
    : safetyText("timeout.react", { time: formatUntil(timeout.expiresAt) });
}

export function renderReactions(
  msg: Message,
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const container = createElement("div", { class: "msg-reactions" });
  const locked = reactionLockReason();
  for (const reaction of msg.reactions) {
    const chip = createElement("span", {
      class: reaction.me ? "reaction-chip me" : "reaction-chip",
      // Focusable so the who-reacted tooltip is reachable without a pointer.
      tabindex: "0",
      role: "button",
      "data-emoji": reaction.emoji,
    });
    // Reaction strings are free-form, so a custom reaction is stored as the
    // literal ":shortcode:" text. Render the image when that resolves; when it
    // does not (the emoji was deleted, or the reaction predates it) the plain
    // text is exactly what the reaction is, and toggling it still works.
    const emoji: Node =
      buildCustomEmojiNode(reaction.emoji) ?? document.createTextNode(reaction.emoji);
    const count = createElement("span", { class: "rc-count" }, String(reaction.count));
    chip.appendChild(emoji);
    chip.appendChild(count);
    wireReactionControl(chip, () => opts.onReactionClick(msg.id, reaction.emoji), locked, signal);
    attachReactionTooltip(
      chip,
      {
        channelId: msg.channelId,
        messageId: msg.id,
        emoji: reaction.emoji,
        count: reaction.count,
      },
      signal,
    );
    container.appendChild(chip);
  }
  const addBtn = createElement(
    "span",
    { class: "reaction-chip add-reaction", tabindex: "0", role: "button" },
    "+",
  );
  wireReactionControl(addBtn, () => opts.onReactionClick(msg.id, ""), locked, signal);
  container.appendChild(addBtn);
  return container;
}

/** Each wired control's unlocked title, so refreshReactionLocks can lift a
 *  timeout's lock back to it without a row rebuild (P4-02). */
const defaultTitles = new WeakMap<HTMLElement, string>();

/** Wire a reaction control: attach its activation listener once, then apply
 *  the current lock. The listener stays attached across a timeout; the lock is
 *  read at activation time so it can be toggled in place (P4-02). */
export function wireReactionControl(
  el: HTMLElement,
  onActivate: () => void,
  locked: string | null,
  signal: AbortSignal,
): void {
  // Remember the unlocked title the caller set (the action label, or none for
  // a chip) so a timeout's lock can be lifted back to it in place.
  const defaultTitle = el.title;
  defaultTitles.set(el, defaultTitle);
  const lockedNow = (): boolean => el.getAttribute("aria-disabled") === "true";
  el.addEventListener(
    "click",
    () => {
      if (!lockedNow()) onActivate();
    },
    { signal },
  );
  // A bare <span role="button"> gets no native key activation, unlike a real
  // <button>. Mirror Enter/Space onto the same handler so a chip is usable
  // from the keyboard once it is reachable (QuickSwitchOverlay's pattern).
  if (el.tagName !== "BUTTON") {
    el.addEventListener(
      "keydown",
      (e) => {
        if (lockedNow()) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      },
      { signal },
    );
  }
  applyReactionLock(el, locked, defaultTitle);
}

/** Toggle a control's disabled state in place. `locked` is the reason from
 *  {@link reactionLockReason}, or null to enable it back to `defaultTitle`. */
export function applyReactionLock(el: HTMLElement, locked: string | null, defaultTitle = ""): void {
  if (locked === null) {
    el.removeAttribute("aria-disabled");
    el.title = defaultTitle;
    return;
  }
  el.setAttribute("aria-disabled", "true");
  el.title = locked;
}

/** Apply the current timeout lock to every reaction control under `root`.
 *  Called when the timeout changes; no row is rebuilt. */
export function refreshReactionLocks(root: ParentNode): void {
  const locked = reactionLockReason();
  for (const el of root.querySelectorAll<HTMLElement>(
    ".reaction-chip, [data-testid^='msg-react-']",
  )) {
    applyReactionLock(el, locked, defaultTitles.get(el) ?? "");
  }
}

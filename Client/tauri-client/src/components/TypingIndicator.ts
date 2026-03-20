/**
 * Step 5.43 — TypingIndicator component.
 * Subscribes to membersStore and displays who is typing in a channel.
 * Uses mockup's .typing-bar and .typing-dots classes.
 */

import { createElement, appendChildren, setText, clearChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { membersStore, getTypingUsers } from "@stores/members.store";
import type { Member } from "@stores/members.store";

export interface TypingIndicatorOptions {
  readonly channelId: number;
  readonly currentUserId: number;
}

function formatTypingText(users: readonly Member[]): string {
  if (users.length === 1) {
    return `${users[0]?.username ?? "Someone"} is typing...`;
  }
  if (users.length === 2) {
    return `${users[0]?.username ?? "Someone"} and ${users[1]?.username ?? "Someone"} are typing...`;
  }
  return "Several people are typing...";
}

export function createTypingIndicator(
  options: TypingIndicatorOptions,
): MountableComponent {
  let root: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;

  function updateFromState(): void {
    if (root === null) return;

    const allTyping = getTypingUsers(options.channelId);
    const filtered = allTyping.filter((u) => u.id !== options.currentUserId);

    clearChildren(root);

    if (filtered.length > 0) {
      // Animated dots
      const dots = createElement("span", { class: "typing-dots" });
      appendChildren(
        dots,
        createElement("span", {}),
        createElement("span", {}),
        createElement("span", {}),
      );
      root.appendChild(dots);

      // Text
      const textNode = document.createTextNode(` ${formatTypingText(filtered)}`);
      root.appendChild(textNode);
    }
    // When empty, .typing-bar:empty CSS rule hides it (height: 0)
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "typing-bar" });

    updateFromState();

    unsubscribe = membersStore.subscribeSelector(
      (s) => s.typingUsers,
      () => { updateFromState(); },
    );

    container.appendChild(root);
  }

  function destroy(): void {
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy };
}

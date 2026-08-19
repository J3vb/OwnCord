/**
 * Step 5.43 — TypingIndicator component.
 * Subscribes to membersStore and displays who is typing in a channel.
 * Uses mockup's .typing-bar and .typing-dots classes.
 */

import { createElement, appendChildren, clearChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { Disposable } from "@lib/disposable";
import { membersStore, getTypingUsers, memberDisplayName } from "@stores/members.store";
import type { Member } from "@stores/members.store";

export interface TypingIndicatorOptions {
  readonly channelId: number;
  readonly currentUserId: number;
}

function formatTypingText(users: readonly Member[]): string {
  const name0 = users[0] ? memberDisplayName(users[0]) : undefined;
  const name1 = users[1] ? memberDisplayName(users[1]) : undefined;
  if (users.length === 1) {
    return `${name0 ?? "Someone"} is typing...`;
  }
  if (users.length === 2) {
    return `${name0 ?? "Someone"} and ${name1 ?? "Someone"} are typing...`;
  }
  return "Several people are typing...";
}

export function createTypingIndicator(options: TypingIndicatorOptions): MountableComponent {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;

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
    // Polite live region (DC-13): "X is typing" changes are announced without
    // interrupting whatever the screen reader is currently speaking.
    root = createElement("div", {
      class: "typing-bar",
      role: "status",
      "aria-live": "polite",
    });

    updateFromState();

    disposable.onStoreChange(
      membersStore,
      (s) => s.typingUsers,
      () => {
        updateFromState();
      },
    );

    container.appendChild(root);
  }

  function destroy(): void {
    disposable.destroy();
    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy };
}

/**
 * Step 5.43 — TypingIndicator component.
 * Subscribes to membersStore and displays who is typing in a channel.
 * Uses mockup's .typing-bar and .typing-dots classes.
 */

import { createElement, appendChildren, clearChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/text/safeRender";
import { Disposable } from "@lib/disposable";
import { membersStore, getTypingUsers, memberDisplayName } from "@stores/members.store";
import type { Member } from "@stores/members.store";
import { shellText } from "../i18n/shell";

export interface TypingIndicatorOptions {
  readonly channelId: number;
  readonly currentUserId: number;
}

/** Placeholder markers: the catalog text is resolved with these in place of
 *  each name, then split on them so every name becomes its own <strong> node
 *  (names are user data, so they are only ever set as text). */
const NAME_OPEN = "\uE000";
const NAME_CLOSE = "\uE001";

const marker = (i: number): string => `${NAME_OPEN}${i}${NAME_CLOSE}`;

function formatTypingText(count: number): string {
  if (count === 1) return shellText("typing.one", { name: marker(0) });
  if (count === 2) return shellText("typing.two", { first: marker(0), second: marker(1) });
  if (count === 3) {
    return shellText("typing.three", { first: marker(0), second: marker(1), third: marker(2) });
  }
  return shellText("typing.many");
}

function appendTypingText(root: HTMLElement, users: readonly Member[]): void {
  const names = users.map((u) => memberDisplayName(u));
  const template = formatTypingText(users.length);
  const pattern = new RegExp(`${NAME_OPEN}(\\d+)${NAME_CLOSE}`, "g");
  let last = 0;
  let text = " ";
  for (const m of template.matchAll(pattern)) {
    text += template.slice(last, m.index);
    root.appendChild(document.createTextNode(text));
    text = "";
    const name = names[Number(m[1])] ?? shellText("typing.someone");
    root.appendChild(createElement("strong", {}, name));
    last = m.index + m[0].length;
  }
  root.appendChild(document.createTextNode(text + template.slice(last)));
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
      appendTypingText(root, filtered);
    }
    // When empty the bar stays in place as a reserved 24px row, so
    // typing start/stop does not shift the message list.
  }

  function mount(container: Element): void {
    // Polite live region: "X is typing" changes are announced without
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

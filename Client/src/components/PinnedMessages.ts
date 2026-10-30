/**
 * PinnedMessages component — Discord-style pinned messages panel
 * with avatars, hover actions, and entry animation.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/text/safeRender";
import { parseTimestamp } from "@lib/text/formatting";
import { messagingText } from "../i18n/messaging";
import { createAvatarElement } from "./message-list/avatar";
import { renderMessageContent } from "./message-list/contentParser";
import type { ImportedAuthor } from "@lib/types";
import {
  createImportedAvatar,
  createImportedName,
  createImportedTag,
} from "./message-list/importedAuthor";

export interface PinnedMessage {
  readonly id: number;
  readonly content: string;
  readonly author: string;
  /** Author's avatar URL; the letter on `avatarColor` shows when absent or until it loads. */
  readonly avatar: string | null;
  readonly timestamp: string;
  readonly avatarColor: string;
  /** Server-resolved mentioned user ids; absent from an older server. */
  readonly mentions?: readonly number[];
  readonly mentionsEveryone?: boolean;
  readonly mentionRoles?: readonly number[];
  /** Set on an imported message: shown in place of `author` and `avatar`. */
  readonly importedAuthor?: ImportedAuthor;
}

export interface PinnedMessagesOptions {
  readonly channelId: number;
  readonly pinnedMessages: readonly PinnedMessage[];
  /**
   * Unpin a message. Omitted for a reader without MANAGE_MESSAGES (or DM
   * membership), so the panel is read-only rather than offering an action the
   * server refuses (F1).
   */
  readonly onUnpin?: (messageId: number) => void;
  readonly onJumpToMessage: (messageId: number) => void;
  readonly onClose: () => void;
}

/** The mounted panel, plus the handles the live controller drives. */
export interface PinnedMessagesPanel extends MountableComponent {
  destroy(): void;
  /** Replace the list (a refetch after a pin change). */
  setPins(pins: readonly PinnedMessage[]): void;
  /** Drop one card in place and update the count; the empty state shows at zero. */
  removePin(messageId: number): void;
  /** Offer (a handler) or withdraw (undefined) Unpin as the viewer's permission changes. */
  setOnUnpin(onUnpin: ((messageId: number) => void) | undefined): void;
}

function formatPinTime(iso: string): string {
  const d = parseTimestamp(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function renderPinnedItem(msg: PinnedMessage, canUnpin: boolean): HTMLDivElement {
  const card = createElement("div", { class: "pinned-msg" });
  card.dataset.messageId = String(msg.id);

  // Row: avatar + body
  const row = createElement("div", { class: "pinned-msg__row" });

  const imported = msg.importedAuthor;
  const avatar =
    imported === undefined
      ? createAvatarElement(
          { username: msg.author, avatar: msg.avatar },
          { className: "pinned-msg__avatar", background: msg.avatarColor },
        )
      : createImportedAvatar(imported, "pinned-msg__avatar");

  const body = createElement("div", { class: "pinned-msg__body" });

  const head = createElement("div", { class: "pinned-msg__head" });
  const authorEl =
    imported === undefined
      ? createElement("span", { class: "pinned-msg__author" }, msg.author)
      : createImportedName(imported, "pinned-msg__author");
  const timeEl = createElement("span", { class: "pinned-msg__time" }, formatPinTime(msg.timestamp));
  appendChildren(head, authorEl);
  if (imported !== undefined) head.appendChild(createImportedTag());
  head.appendChild(timeEl);

  // Rendered like the message list (markdown, mentions, emoji, spoilers); the
  // card's CSS clamps it, so a long pin cannot outgrow the panel.
  const content = createElement("div", { class: "pinned-msg__content" });
  content.appendChild(
    renderMessageContent(msg.content, {
      ...(msg.mentions !== undefined ? { mentions: msg.mentions } : {}),
      ...(msg.mentionsEveryone !== undefined ? { mentionsEveryone: msg.mentionsEveryone } : {}),
      ...(msg.mentionRoles !== undefined ? { mentionRoles: msg.mentionRoles } : {}),
    }),
  );
  // The panel opens no profiles, so mention chips are plain text here.
  for (const chip of content.querySelectorAll<HTMLElement>(".mention")) {
    chip.removeAttribute("role");
    chip.removeAttribute("tabindex");
  }
  appendChildren(body, head, content);
  appendChildren(row, avatar, body);

  // Hover actions
  const actions = createElement("div", { class: "pinned-msg__actions" });
  // Icon-only buttons: title= only tooltips for mouse users, so mirror it as
  // an aria-label for screen readers.
  const jumpBtn = createElement("button", {
    class: "pinned-msg__jump",
    title: messagingText("pins.jump"),
    "aria-label": messagingText("pins.jump"),
  });
  jumpBtn.appendChild(createIcon("external-link", 14));
  actions.appendChild(jumpBtn);

  // Unpin only when the viewer may act; a reader without MANAGE_MESSAGES (or
  // DM membership) gets a read-only panel instead of a button that always
  // fails (F1).
  if (canUnpin) {
    const unpinBtn = createElement("button", {
      class: "pinned-msg__unpin",
      title: messagingText("pins.unpin"),
      "aria-label": messagingText("pins.unpin"),
    });
    unpinBtn.appendChild(createIcon("x", 14));
    actions.appendChild(unpinBtn);
  }

  appendChildren(card, row, actions);

  return card;
}

function renderEmptyState(): HTMLDivElement {
  const empty = createElement("div", { class: "pinned-panel__empty" });
  const icon = createElement("div", { class: "pinned-panel__empty-icon" });
  icon.textContent = "";
  icon.appendChild(createIcon("pin", 20));
  const text = createElement("div", { class: "pinned-panel__empty-text" });
  text.textContent = messagingText("pins.empty");
  appendChildren(empty, icon, text);
  return empty;
}

export function createPinnedMessages(options: PinnedMessagesOptions): PinnedMessagesPanel {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;
  let list: HTMLDivElement | null = null;
  let emptyEl: HTMLDivElement | null = null;
  let countEl: HTMLSpanElement | null = null;
  let pins: readonly PinnedMessage[] = options.pinnedMessages;
  let onUnpin: ((messageId: number) => void) | undefined = options.onUnpin;

  /** Rebuild the list (or swap in the empty state) and the count from `pins`. */
  function renderBody(): void {
    if (root === null || list === null || countEl === null) return;
    countEl.textContent = String(pins.length);
    if (pins.length === 0) {
      list.remove();
      list.textContent = "";
      if (emptyEl === null) {
        emptyEl = renderEmptyState();
        root.appendChild(emptyEl);
      }
      return;
    }
    if (emptyEl !== null) {
      emptyEl.remove();
      emptyEl = null;
    }
    list.textContent = "";
    const canUnpin = onUnpin !== undefined;
    for (const msg of pins) {
      list.appendChild(renderPinnedItem(msg, canUnpin));
    }
    if (list.parentElement === null) root.appendChild(list);
  }

  function mount(container: Element): void {
    // A side panel, not a modal: complementary landmark (no aria-modal, no
    // focus trap), matching DmProfileSidebar.
    root = createElement("div", {
      class: "pinned-panel",
      role: "complementary",
      "aria-label": messagingText("pins.label"),
    });

    // Header
    const header = createElement("div", { class: "pinned-panel__header" });
    const title = createElement("h3", {});
    title.textContent = "";
    title.appendChild(createIcon("pin", 16));
    title.appendChild(document.createTextNode(messagingText("pins.title")));

    countEl = createElement("span", { class: "pinned-panel__count" });

    const closeBtn = createElement("button", {
      class: "pinned-panel__close",
      "aria-label": messagingText("pins.close"),
    });
    closeBtn.appendChild(createIcon("x", 16));
    closeBtn.addEventListener("click", () => options.onClose(), { signal: disposable.signal });

    const titleGroup = createElement("div", {
      class: "pinned-panel__title-group",
    });
    appendChildren(titleGroup, title, countEl);
    appendChildren(header, titleGroup, closeBtn);

    // Body — list or empty state. One delegated listener serves every card, so
    // re-rendering the list never stacks listeners.
    list = createElement("div", { class: "pinned-panel__list" });
    list.addEventListener(
      "click",
      (e) => {
        if (!(e.target instanceof Element)) return;
        const button = e.target.closest("button");
        const card = button?.closest<HTMLElement>(".pinned-msg");
        const id = Number(card?.dataset.messageId);
        if (button === null || button === undefined || Number.isNaN(id)) return;
        if (button.classList.contains("pinned-msg__jump")) options.onJumpToMessage(id);
        else if (button.classList.contains("pinned-msg__unpin")) onUnpin?.(id);
      },
      { signal: disposable.signal },
    );
    root.appendChild(header);
    renderBody();

    container.appendChild(root);
  }

  function destroy(): void {
    disposable.destroy();
    if (root !== null) {
      root.remove();
      root = null;
    }
    list = null;
    emptyEl = null;
    countEl = null;
  }

  return {
    mount,
    destroy,
    setPins(next) {
      pins = next;
      renderBody();
    },
    removePin(messageId) {
      pins = pins.filter((p) => p.id !== messageId);
      renderBody();
    },
    setOnUnpin(next) {
      if (next === onUnpin) return;
      onUnpin = next;
      renderBody();
    },
  };
}

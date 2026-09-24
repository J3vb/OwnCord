/**
 * DmSidebar component — direct messages sidebar showing conversations
 * sorted by most recent, with unread indicators.
 *
 * Uses the `channel-sidebar` container class (shared with channel sidebar)
 * and DM-specific classes from app.css: dm-sidebar-header, dm-search,
 * dm-section-label, dm-add, dm-item, dm-avatar, dm-status,
 * dm-name, dm-close, dm-unread.
 *
 * Rows are keyed on the DM *channel*, not on a recipient user: a group DM has
 * no single recipient, and the same person can be in both a 1:1 and a group
 * with you, so a user id no longer identifies a conversation.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { reconcileChildren } from "@lib/reconcile";
import { enableRovingNavigation, setRovingTabindex } from "@lib/a11y";
import { createIcon } from "@lib/icons";
import { showContextMenu } from "@lib/context-menu";
import type { MountableComponent } from "@lib/safe-render";
import { isRenderableAvatar } from "@lib/avatar";
import {
  fetchImageAsDataUrl,
  recoverEvictedImage,
  resolveServerUrl,
} from "./message-list/attachments";
import { requestsText } from "../i18n/requests";

/** One member of a group DM, as far as the sidebar needs to draw them. */
export interface DmParticipant {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
}

export interface DmConversation {
  /** The DM channel. The row's identity — see the module comment. */
  readonly channelId: number;
  /** The other party of a 1:1 DM; for a group, the first participant. */
  readonly userId: number;
  /** What the row is labelled: a group's name or joined members, else a user. */
  readonly username: string;
  readonly avatar: string | null;
  readonly avatarColor?: string;
  readonly status?: "online" | "idle" | "dnd" | "offline";
  /** True for a group DM: draws stacked avatars and a participant count. */
  readonly isGroup?: boolean;
  /** Everyone but the current user. Drives the stack and the count. */
  readonly participants?: readonly DmParticipant[];
  readonly lastMessage: string;
  readonly timestamp: string;
  readonly unread: boolean;
  /** Unread message count. Drives the numeric badge; a conversation marked
   *  `unread` with no count still shows the plain dot (older payloads). */
  readonly unreadCount?: number;
  /** Unread messages here that mention the current user. Outranks the unread
   *  badge, exactly as it does in the channel list. */
  readonly mentionCount?: number;
  /** Muted: the unread badge renders dimmed. The mention badge does not —
   *  a mute silences chatter, never something addressed to you. */
  readonly muted?: boolean;
  readonly active?: boolean;
}

export interface DmSidebarOptions {
  readonly conversations: readonly DmConversation[];
  readonly onSelectConversation: (channelId: number) => void;
  readonly onNewDm: () => void;
  /** Close a 1:1 DM / leave a group. The component does not distinguish —
   *  which one it is is the server's call, and the label says so. */
  readonly onCloseDm?: (channelId: number) => void;
  readonly onToggleMute?: (channelId: number) => void;
  readonly onRenameGroup?: (channelId: number) => void;
  readonly onBack?: () => void;
  readonly serverName?: string;
}

const STATUS_COLORS: Record<string, string> = {
  online: "var(--green)",
  idle: "var(--yellow)",
  dnd: "var(--red)",
  offline: "var(--text-micro)",
};

/**
 * Fill one avatar circle: the letter immediately, the picture swapped in once
 * fetched. `<img src>` cannot carry the bearer token an authenticated
 * `/api/v1/files/{id}` avatar needs, so the URL is always fetched through the
 * same cert-pinned path attachments and custom emoji use rather than assigned
 * directly.
 */
function paintAvatar(el: HTMLElement, avatar: string | null, label: string): void {
  // The letter lives in its own node so the swap below can remove just it —
  // anything else in the circle (the 1:1 presence dot) must survive the image.
  const letter = document.createTextNode(label.charAt(0).toUpperCase());
  el.appendChild(letter);
  if (!isRenderableAvatar(avatar)) return;
  const resolved = resolveServerUrl(avatar);
  void fetchImageAsDataUrl(resolved).then((dataUrl) => {
    if (dataUrl === null || !el.isConnected) return;
    const img = createElement("img", { src: dataUrl, alt: label });
    recoverEvictedImage(img, { url: resolved });
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.borderRadius = "50%";
    letter.remove();
    el.insertBefore(img, el.firstChild);
  });
}

/**
 * The avatar block for a row: one circle for a 1:1 DM with a presence dot, or
 * two overlapping circles for a group.
 *
 * A group deliberately gets no presence dot — "is this group online" has no
 * answer, and showing the first member's would be a fact about one person
 * presented as a fact about the conversation.
 */
function buildAvatar(convo: DmConversation): HTMLDivElement {
  const avatarBg = convo.avatarColor ?? "#5865F2";

  if (convo.isGroup === true) {
    const stack = createElement("div", {
      class: "dm-avatar dm-avatar-stack",
      "data-testid": `dm-avatar-stack-${convo.channelId}`,
    });
    const shown = (convo.participants ?? []).slice(0, 2);
    // An empty group (every other member has left) still needs a mark, so fall
    // back to the row's own label rather than rendering an empty circle.
    const faces = shown.length > 0 ? shown : [{ id: 0, username: convo.username, avatar: null }];
    faces.forEach((p, i) => {
      const face = createElement("div", { class: `dm-avatar-face dm-avatar-face-${i}` });
      face.style.background = avatarBg;
      paintAvatar(face, p.avatar, p.username);
      stack.appendChild(face);
    });
    return stack;
  }

  const avatar = createElement("div", { class: "dm-avatar" });
  avatar.style.background = avatarBg;
  paintAvatar(avatar, convo.avatar, convo.username);

  const statusKey = convo.status ?? "offline";
  const statusDot = createElement("span", { class: "dm-status" });
  statusDot.style.background = STATUS_COLORS[statusKey] ?? "var(--text-micro)";
  avatar.appendChild(statusDot);
  return avatar;
}

function renderDmItem(
  convo: DmConversation,
  options: DmSidebarOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const item = createElement("div", {
    class: "dm-item",
    // Roving list item: reachable by Tab once, then arrow-stepped (B9-21).
    role: "button",
    tabindex: "-1",
  });
  if (convo.active === true) {
    item.classList.add("active");
  }
  if (convo.muted === true) {
    item.classList.add("muted");
  }
  item.dataset.channelId = String(convo.channelId);
  item.dataset.userId = String(convo.userId);

  const avatar = buildAvatar(convo);

  const name = createElement("span", { class: "dm-name" }, convo.username);

  appendChildren(item, avatar, name);

  // Participant count, groups only: the label may be a name that says nothing
  // about size, and "who else is in here" is the first thing you want to know.
  if (convo.isGroup === true) {
    const count = (convo.participants ?? []).length + 1;
    const countEl = createElement(
      "span",
      { class: "dm-member-count", "data-testid": `dm-members-${convo.channelId}` },
      String(count),
    );
    countEl.title = requestsText("members.count", { count });
    item.appendChild(countEl);
  }

  // Close / leave button (hidden by default, shown on hover via CSS)
  const closeBtn = createElement("button", {
    class: "dm-close",
    title: convo.isGroup === true ? requestsText("dm.leaveShort") : requestsText("dm.closeShort"),
  });
  closeBtn.appendChild(createIcon("x", 14));
  closeBtn.addEventListener(
    "click",
    (e: Event) => {
      e.stopPropagation();
      options.onCloseDm?.(convo.channelId);
    },
    { signal },
  );
  item.appendChild(closeBtn);

  // A mention badge outranks the unread badge, which in turn outranks the bare
  // dot — the dot is only what is left when the payload carries no counts.
  //
  // A muted conversation dims the unread badge but NOT the mention badge: the
  // whole point of Discord's mute is that things addressed to you still get
  // through, so dimming both would make a mute unsafe to use.
  const mentionCount = convo.mentionCount ?? 0;
  const unreadCount = convo.unreadCount ?? 0;
  if (mentionCount > 0) {
    const badge = createElement(
      "span",
      { class: "dm-mention-badge", "data-testid": `dm-mentions-${convo.channelId}` },
      String(mentionCount),
    );
    badge.title = requestsText("mention.count", { count: mentionCount, n: String(mentionCount) });
    item.appendChild(badge);
  } else if (unreadCount > 0) {
    const badge = createElement(
      "span",
      {
        class: convo.muted === true ? "dm-unread-badge muted" : "dm-unread-badge",
        "data-testid": `dm-unread-${convo.channelId}`,
      },
      String(unreadCount),
    );
    badge.title = requestsText("unread.count", { count: unreadCount, n: String(unreadCount) });
    item.appendChild(badge);
  } else if (convo.unread) {
    const unreadDot = createElement("span", { class: "dm-unread" });
    item.appendChild(unreadDot);
  }

  item.addEventListener(
    "click",
    () => {
      const parent = item.parentElement;
      if (parent !== null) {
        for (const sibling of parent.querySelectorAll(".dm-item.active")) {
          sibling.classList.remove("active");
        }
      }
      item.classList.add("active");
      options.onSelectConversation(convo.channelId);
    },
    { signal },
  );

  item.addEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      e.preventDefault();
      const items = [];
      if (options.onToggleMute !== undefined) {
        const toggle = options.onToggleMute;
        items.push({
          label: convo.muted === true ? requestsText("dm.unmute") : requestsText("dm.mute"),
          testId: `dm-mute-${convo.channelId}`,
          onClick: () => toggle(convo.channelId),
        });
      }
      if (convo.isGroup === true && options.onRenameGroup !== undefined) {
        const rename = options.onRenameGroup;
        items.push({
          label: requestsText("dm.renameGroup"),
          testId: `dm-rename-${convo.channelId}`,
          onClick: () => rename(convo.channelId),
        });
      }
      if (options.onCloseDm !== undefined) {
        const close = options.onCloseDm;
        items.push({
          label: convo.isGroup === true ? requestsText("dm.leaveGroup") : requestsText("dm.close"),
          danger: true,
          testId: `dm-close-${convo.channelId}`,
          onClick: () => close(convo.channelId),
        });
      }
      if (items.length === 0) return;
      showContextMenu({ x: e.clientX, y: e.clientY, items, signal, className: "dm-context-menu" });
    },
    { signal },
  );

  return item;
}

/**
 * SidebarArea refreshes the DM list on every dmStore change (a presence flip,
 * a message, an unread clear). Rebuilding the whole subtree would lose the
 * "Find a conversation" filter, its focus and the scroll position; the keyed
 * list keeps every unchanged row, so those all survive an unrelated update
 * (B9-21).
 */
export interface DmSidebar extends MountableComponent {
  /** Re-render the conversation rows from a fresh list, in place. */
  update(conversations: readonly DmConversation[]): void;
}

/** A row the search filter has not hidden: the only rows the keyboard visits. */
const VISIBLE_ROW = ".dm-item:not([hidden])";

/** The unread-first order the conversation list renders in. */
function sortConversations(conversations: readonly DmConversation[]): DmConversation[] {
  return [...conversations].toSorted((a, b) => (b.unread ? 1 : 0) - (a.unread ? 1 : 0));
}

/** Everything a row draws. A changed value rebuilds just that row. */
function convoSignature(convo: DmConversation): string {
  return [
    convo.username,
    convo.avatar ?? "",
    convo.avatarColor ?? "",
    convo.status ?? "",
    convo.isGroup === true ? "g" : "",
    (convo.participants ?? []).length,
    convo.active === true ? "a" : "",
    convo.muted === true ? "m" : "",
    convo.unread === true ? "u" : "",
    convo.unreadCount ?? 0,
    convo.mentionCount ?? 0,
  ].join("|");
}

export function createDmSidebar(options: DmSidebarOptions): DmSidebar {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;
  let list: HTMLDivElement | null = null;
  let searchInput: HTMLInputElement | null = null;
  // The sorted list the current filter runs over, kept in sync with the DOM.
  let rendered: readonly DmConversation[] = [];
  // Rows the search filter has hidden, so a later update can re-apply it.
  let query = "";
  // Each row's listeners die with the row, not with the sidebar (OC-0229).
  const rowOwners = new Map<Element, Disposable>();

  /** Apply the current search query to the current rows. */
  function applyFilter(): void {
    if (list === null) return;
    const q = query.trim().toLowerCase();
    const rows = list.children;
    rendered.forEach((convo, i) => {
      const el = rows[i] as HTMLElement | undefined;
      if (el === undefined) return;
      const match = q === "" || convo.username.toLowerCase().includes(q);
      el.hidden = !match;
    });
    setRovingTabindex(list, VISIBLE_ROW);
  }

  function update(conversations: readonly DmConversation[]): void {
    if (list === null) return;
    rendered = sortConversations(conversations);
    reconcileChildren(list, rendered, {
      key: (c) => String(c.channelId),
      signature: convoSignature,
      create: (convo) => {
        const owner = new Disposable();
        const el = renderDmItem(convo, options, owner.signal);
        rowOwners.set(el, owner);
        return el;
      },
      dispose: (el) => {
        rowOwners.get(el)?.destroy();
        rowOwners.delete(el);
      },
    });
    applyFilter();
  }

  function mount(container: Element): void {
    // Reuse channel-sidebar container class per mockup
    root = createElement("div", { class: "channel-sidebar" });

    // Back to server header (optional)
    if (options.onBack !== undefined) {
      const backFn = options.onBack;
      const backHeader = createElement("div", {
        class: "dm-back-header",
        "data-testid": "dm-back-header",
      });
      backHeader.tabIndex = 0;
      backHeader.setAttribute("role", "button");
      // Named by the visible title rather than a second copy of its text.
      const backTitleId = "dm-back-title";
      backHeader.setAttribute("aria-labelledby", backTitleId);
      const arrow = createElement("span", { class: "dm-back-arrow", "aria-hidden": "true" }, "←");
      const backInfo = createElement("div", { class: "dm-back-info" });
      const backTitle = createElement(
        "div",
        { class: "dm-back-title", id: backTitleId },
        requestsText("dm.backTo", {
          server: options.serverName ?? requestsText("dm.serverFallback"),
        }),
      );
      const backSub = createElement(
        "div",
        { class: "dm-back-subtitle" },
        requestsText("dm.returnToChannels"),
      );
      appendChildren(backInfo, backTitle, backSub);
      appendChildren(backHeader, arrow, backInfo);
      backHeader.addEventListener("click", () => backFn(), { signal: disposable.signal });
      backHeader.addEventListener(
        "keydown",
        (e: KeyboardEvent) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          backFn();
        },
        { signal: disposable.signal },
      );
      root.appendChild(backHeader);
    }

    // Search header
    const header = createElement("div", { class: "dm-sidebar-header" });
    searchInput = createElement("input", {
      class: "dm-search",
      placeholder: requestsText("dm.find"),
    });
    header.appendChild(searchInput);

    // Section label with + button
    const sectionLabel = createElement("div", { class: "dm-section-label" });
    setText(sectionLabel, requestsText("dm.heading"));
    const addBtn = createElement("button", {
      class: "dm-add",
      title: requestsText("dm.new"),
    });
    setText(addBtn, "+");
    addBtn.addEventListener("click", () => options.onNewDm(), { signal: disposable.signal });
    sectionLabel.appendChild(addBtn);

    // Conversation list
    list = createElement("div", { class: "dm-conversation-list" });

    searchInput.addEventListener(
      "input",
      () => {
        query = searchInput?.value ?? "";
        applyFilter();
      },
      { signal: disposable.signal },
    );

    // One Tab stop for the list; ArrowUp/Down step, Enter/Space open.
    enableRovingNavigation(list, VISIBLE_ROW, disposable.signal, "vertical");

    appendChildren(root, header, sectionLabel, list);
    container.appendChild(root);

    update(options.conversations);
  }

  function destroy(): void {
    disposable.destroy();
    for (const owner of rowOwners.values()) owner.destroy();
    rowOwners.clear();
    if (root !== null) {
      root.remove();
      root = null;
    }
    list = null;
    searchInput = null;
    rendered = [];
  }

  return { mount, update, destroy };
}

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
import { atEachMidnight, formatBadgeCount, formatDmRowTime } from "@lib/text/formatting";
import { reconcileChildren } from "@lib/reconcile";
import { enableRovingNavigation, setRovingTabindex } from "@lib/a11y";
import { createIcon, type IconName } from "@lib/icons";
import type { ModalInstance } from "@lib/modalFactory";
import { openMenuOnKeyboard } from "@lib/context-menu";
import type { MountableComponent } from "@lib/text/safeRender";
import { avatarAnimationMode, isRenderableAvatar, setAvatarSource } from "./message-list/avatar";
import {
  fetchImageAsObjectUrl,
  recoverEvictedImage,
  resolveServerUrl,
} from "./message-list/attachments";
import { requestsText } from "../i18n/requests";
import { voiceText } from "../i18n/voice";
import { getChannelMute } from "@lib/prefs/channelMutes";
import { openDmContextMenu, openLeaveConfirm, type DmMenuConvo } from "./dmContextMenu";
import { onPrefChange } from "@lib/prefs/preferences";

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
  /** The game the other party of a 1:1 DM is playing, or else the
   *  music they listen to; never set for a group. Drawn as "Playing
   *  <game>" or "Listening to <player>" under the name. */
  readonly activity?: string | null;
  /** The icon for `activity`; the controller when absent. */
  readonly activityIcon?: IconName;
  /** True for a group DM: draws stacked avatars and a participant count. */
  readonly isGroup?: boolean;
  /** A group whose server reports an owner; drives the leave copy. */
  readonly hasOwner?: boolean;
  /** The group's uploaded icon: a server file path; absent for none. */
  readonly icon?: string;
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
  /** When a timed mute ends (epoch ms); absent or null for an untimed mute. */
  readonly mutedUntil?: number | null;
  readonly active?: boolean;
  /** Someone is in this DM's call: the row shows a phone glyph. */
  readonly inCall?: boolean;
}

export interface DmSidebarOptions {
  readonly conversations: readonly DmConversation[];
  readonly onSelectConversation: (channelId: number) => void;
  readonly onNewDm: () => void;
  /** Close a 1:1 DM / leave a group. The component does not distinguish —
   *  which one it is is the server's call, and the label says so. */
  readonly onCloseDm?: (channelId: number) => void;
  readonly onToggleMute?: (channelId: number) => void;
  /** Row menu: set the mute outright (see `DmMenuActions.onSetMute`). */
  readonly onSetMute?: (channelId: number, muted: boolean) => void;
  /** Row menu: mute for a fixed time. */
  readonly onMuteFor?: (channelId: number, durationMs: number) => void;
  /** Row menu: mark the conversation read. Offered only while it is unread. */
  readonly onMarkRead?: (channelId: number) => void;
  /** Row menu, 1:1 only: open this person's profile panel. */
  readonly onOpenProfile?: (channelId: number) => void;
  /** Row menu, 1:1 only: start a call in this DM. */
  readonly onCall?: (channelId: number) => void;
  /** Row menu, 1:1 only: Block (`block` true) or Unblock the other person. The
   *  owner confirms a Block. */
  readonly onToggleBlock?: (userId: number, username: string, block: boolean) => void;
  readonly onRenameGroup?: (channelId: number) => void;
  /** Row menu, groups on a 3B-10 server: pick and upload a new group icon. */
  readonly onChangeGroupIcon?: (channelId: number) => void;
  /** Row menu: remove the group icon. Offered only while one is set. */
  readonly onRemoveGroupIcon?: (channelId: number) => void;
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
  void fetchImageAsObjectUrl(resolved).then(async (objectUrl) => {
    if (objectUrl === null || !el.isConnected) return;
    const img = createElement("img", { alt: label });
    recoverEvictedImage(img, { url: resolved });
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.borderRadius = "50%";
    const current = (): boolean => el.isConnected;
    if (!(await setAvatarSource(img, objectUrl, () => avatarAnimationMode(el), current))) return;
    letter.remove();
    el.insertBefore(img, el.firstChild);
  });
}

/**
 * The two overlapping faces of a group DM. Shared by the DM row and the chat
 * header so a group looks the same in both.
 *
 * A group with an uploaded icon shows that picture instead of the
 * faces. The faces are drawn first, so a group is never an empty circle; the
 * icon is fetched like any avatar and replaces them when it arrives, even if
 * the stack has been detached meanwhile (the image cache owns the object URL,
 * so it is not revoked here). If the picture then fails to decode the faces
 * are drawn again.
 */
export function buildGroupAvatarStack(
  channelId: number,
  participants: readonly DmParticipant[],
  fallbackLabel: string,
  background: string,
  testId = `dm-avatar-stack-${channelId}`,
  icon: string | null = null,
): HTMLDivElement {
  const stack = createElement("div", {
    class: "dm-avatar dm-avatar-stack",
    "data-testid": testId,
  });
  const drawFaces = (): void => {
    const shown = participants.slice(0, 2);
    // An empty group (every other member has left) still needs a mark, so fall
    // back to the row's own label rather than rendering an empty circle.
    const faces = shown.length > 0 ? shown : [{ id: 0, username: fallbackLabel, avatar: null }];
    faces.forEach((p, i) => {
      const face = createElement("div", { class: `dm-avatar-face dm-avatar-face-${i}` });
      face.style.background = background;
      paintAvatar(face, p.avatar, p.username);
      stack.appendChild(face);
    });
  };
  drawFaces();
  if (!isRenderableAvatar(icon)) return stack;
  const resolved = resolveServerUrl(icon);
  void fetchImageAsObjectUrl(resolved).then((objectUrl) => {
    if (objectUrl === null) return;
    const img = createElement("img", {
      src: objectUrl,
      alt: "",
      class: "dm-avatar-icon-img",
      "data-testid": `${testId}-icon`,
    });
    recoverEvictedImage(img, { url: resolved });
    img.addEventListener(
      "error",
      () => {
        stack.replaceChildren();
        drawFaces();
      },
      { once: true },
    );
    stack.replaceChildren(img);
  });
  return stack;
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
    return buildGroupAvatarStack(
      convo.channelId,
      convo.participants ?? [],
      convo.username,
      avatarBg,
      undefined,
      convo.icon ?? null,
    );
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

function menuConvo(convo: DmConversation): DmMenuConvo {
  // Read the store as the menu opens: the list may have been drawn before a
  // timed mute ended (or was set elsewhere). An untimed `muted` flag from the
  // list still stands when the store has no entry.
  const live = getChannelMute(convo.channelId);
  const muted = live !== null || (convo.muted === true && convo.mutedUntil == null);
  return {
    channelId: convo.channelId,
    userId: convo.userId,
    username: convo.username,
    isGroup: convo.isGroup === true,
    hasOwner: convo.hasOwner === true,
    hasIcon: convo.icon !== undefined && convo.icon !== "",
    unread: convo.unread,
    muted,
    mutedUntil: live?.until ?? null,
  };
}

function renderDmItem(
  convo: DmConversation,
  options: DmSidebarOptions,
  signal: AbortSignal,
  confirmLeave: (convo: DmMenuConvo, onClose: (channelId: number) => void) => void,
): HTMLDivElement {
  const item = createElement("div", {
    class: "dm-item",
    // Roving list item: reachable by Tab once, then arrow-stepped.
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
  // The last-message preview and its time: Discord's DM list always shows the
  // last line, and the data was already computed onto DmConversation. An empty
  // timestamp means the DM was never messaged (lastMessage carries the "No
  // messages yet" fallback), so there is no time to show.
  const preview = createElement("span", { class: "dm-preview" }, convo.lastMessage);
  const body = createElement("div", { class: "dm-item-body" });
  if (convo.activity != null && convo.isGroup !== true) {
    const activity = createElement("span", {
      class: "dm-activity",
      "data-testid": `dm-activity-${convo.channelId}`,
    });
    const icon = createIcon(convo.activityIcon ?? "gamepad-2", 12);
    icon.setAttribute("aria-hidden", "true");
    icon.classList.add("dm-activity-icon");
    const text = createElement("span", { class: "dm-activity-text" });
    setText(text, convo.activity);
    appendChildren(activity, icon, text);
    appendChildren(body, name, activity, preview);
  } else {
    appendChildren(body, name, preview);
  }
  const time = createElement(
    "span",
    { class: "dm-preview-time" },
    formatDmRowTime(convo.timestamp),
  );

  appendChildren(item, avatar, body, time);

  // Participant count, groups only: the label may be a name that says nothing
  // about size, and "who else is in here" is the first thing you want to know.
  if (convo.isGroup === true) {
    const count = (convo.participants ?? []).length + 1;
    const countEl = createElement(
      "span",
      { class: "dm-member-count", "data-testid": `dm-members-${convo.channelId}` },
      String(count),
    );
    countEl.title = requestsText("members.count", { count: String(count) });
    item.appendChild(countEl);
  }

  // A live call is visible without opening the DM. The glyph has a name so
  // it is not colour or shape alone.
  if (convo.inCall === true) {
    const glyph = createElement("span", {
      class: "dm-in-call",
      role: "img",
      "aria-label": voiceText("call.inProgress"),
      title: voiceText("call.inProgress"),
      "data-testid": `dm-in-call-${convo.channelId}`,
    });
    glyph.appendChild(createIcon("phone", 14));
    item.appendChild(glyph);
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
      const close = options.onCloseDm;
      if (close === undefined) return;
      // A group leave is destructive and asks first. Shift-click skips
      // the prompt, as Discord's delete confirm does. A 1:1 close is only a
      // hide, so it stays one click.
      if (convo.isGroup === true && !(e instanceof MouseEvent && e.shiftKey)) {
        confirmLeave(menuConvo(convo), close);
        return;
      }
      close(convo.channelId);
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
      formatBadgeCount(unreadCount),
    );
    badge.title = requestsText("unread.count", {
      count: unreadCount,
      n: formatBadgeCount(unreadCount),
    });
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

  const openDmMenu = (x: number, y: number): void => {
    openDmContextMenu({
      convo: menuConvo(convo),
      actions: options,
      confirmLeave,
      x,
      y,
      signal,
    });
  };
  item.addEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      e.preventDefault();
      openDmMenu(e.clientX, e.clientY);
    },
    { signal },
  );
  // Keyboard entry point (A11Y-01): Shift+F10 / Menu key on the focused row.
  openMenuOnKeyboard(item, openDmMenu, signal);

  return item;
}

/**
 * SidebarArea refreshes the DM list on every dmStore change (a presence flip,
 * a message, an unread clear). Rebuilding the whole subtree would lose the
 * "Find a conversation" filter, its focus and the scroll position; the keyed
 * list keeps every unchanged row, so those all survive an unrelated update.
 */
export interface DmSidebar extends MountableComponent {
  /** Re-render the conversation rows from a fresh list, in place. */
  update(conversations: readonly DmConversation[]): void;
}

/** A row the search filter has not hidden: the only rows the keyboard visits. */
const VISIBLE_ROW = ".dm-item:not([hidden])";

/**
 * The order the conversation list renders in: pure recency, which is the order
 * the store already carries (the server lists DMs by last message time, and
 * every store mutator moves a touched DM to the front). The old unread-first
 * sort contradicted this component's own header — and unread is not
 * what a DM list is for; the badge already marks what is unread.
 */
function sortConversations(conversations: readonly DmConversation[]): DmConversation[] {
  return [...conversations];
}

/** Everything a row draws. A changed value rebuilds just that row. */
function convoSignature(convo: DmConversation): string {
  return [
    convo.username,
    convo.avatar ?? "",
    convo.avatarColor ?? "",
    convo.status ?? "",
    convo.isGroup === true ? "" : `${convo.activityIcon ?? ""}|${convo.activity ?? ""}`,
    convo.isGroup === true ? "g" : "",
    convo.icon ?? "",
    (convo.participants ?? []).length,
    convo.active === true ? "a" : "",
    convo.muted === true ? "m" : "",
    convo.unread === true ? "u" : "",
    convo.unreadCount ?? 0,
    convo.mentionCount ?? 0,
    convo.inCall === true ? "c" : "",
    convo.lastMessage,
    formatDmRowTime(convo.timestamp),
  ].join("|");
}

export function createDmSidebar(options: DmSidebarOptions): DmSidebar {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;
  let list: HTMLDivElement | null = null;
  let emptyState: HTMLDivElement | null = null;
  let searchInput: HTMLInputElement | null = null;
  // The sorted list the current filter runs over, kept in sync with the DOM.
  let rendered: readonly DmConversation[] = [];
  // Rows the search filter has hidden, so a later update can re-apply it.
  let query = "";
  // Each row's listeners die with the row, not with the sidebar.
  const rowOwners = new Map<Element, Disposable>();
  let leavePrompt: { channelId: number; modal: ModalInstance } | null = null;

  function confirmLeave(convo: DmMenuConvo, onClose: (channelId: number) => void): void {
    leavePrompt = {
      channelId: convo.channelId,
      modal: openLeaveConfirm(convo, onClose, disposable.signal),
    };
  }

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
        const el = renderDmItem(convo, options, owner.signal, confirmLeave);
        rowOwners.set(el, owner);
        return el;
      },
      dispose: (el) => {
        rowOwners.get(el)?.destroy();
        rowOwners.delete(el);
      },
    });
    if (leavePrompt !== null && !rendered.some((c) => c.channelId === leavePrompt?.channelId)) {
      leavePrompt.modal.close();
      leavePrompt = null;
    }
    applyFilter();
    if (emptyState !== null) emptyState.hidden = rendered.length > 0;
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
    // A row's time is "3:04 PM" today and "Sep 29" after midnight.
    atEachMidnight(disposable.signal, () => update(rendered));
    // A clock-format change relabels the row times in place.
    onPrefChange(["timeFormat"], () => update(rendered), disposable.signal);

    // Nothing to list: say so, with the way to start (Discord's DM list does).
    emptyState = createElement("div", {
      class: "dm-empty",
      "data-testid": "dm-empty-state",
    });
    emptyState.hidden = true;
    const startBtn = createElement(
      "button",
      { type: "button", class: "dm-empty-start", "data-testid": "dm-empty-start" },
      requestsText("dm.emptyStart"),
    );
    startBtn.addEventListener("click", () => options.onNewDm(), { signal: disposable.signal });
    appendChildren(
      emptyState,
      createElement("p", { class: "dm-empty-text" }, requestsText("dm.empty")),
      startBtn,
    );

    appendChildren(root, header, sectionLabel, list, emptyState);
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
    emptyState = null;
    searchInput = null;
    rendered = [];
  }

  return { mount, update, destroy };
}

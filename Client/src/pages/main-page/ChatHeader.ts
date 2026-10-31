/**
 * ChatHeader — builds the channel header bar with name, topic, pins, and search.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createModal } from "@lib/ui/modalFactory";
import type { ChannelType } from "@lib/types";
import { messagingText } from "../../i18n/messaging";
import { requestsText } from "../../i18n/requests";
import { shellText } from "../../i18n/shell";

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
  /** The DM video call button: the same call, with the camera on once joined. */
  readonly videoCallBtn: HTMLButtonElement;
  /** The "Show User Profile" toggle for the DM profile panel. Shown only in a
   *  1:1 DM (a group has no profile); the page owns its `aria-pressed`. */
  readonly profileBtn: HTMLButtonElement;
  /** The "Show Member List" toggle for the group member panel. Shown only in a
   *  group DM; the page owns its `aria-pressed`. */
  readonly membersBtn: HTMLButtonElement;
  /** The "Member List" toggle for the guild member column. Shown only for a
   *  guild channel in the right-hand layout; `MemberColumn` is the only writer
   *  of its `hidden` and `aria-pressed`. */
  readonly memberListBtn: HTMLButtonElement;
  /** The "Hide chat"/"Show chat" toggle of the call view. Hidden
   *  unless the active channel is the joined voice channel with the grid open;
   *  `setChatHeaderCallChat` is its only writer and the page wires the click. */
  readonly callChatBtn: HTMLButtonElement;
  /** The channel's Threads list. Shown only for a text channel on a
   *  server with threads; `setChatHeaderThreads` is its only writer. */
  readonly threadsBtn?: HTMLButtonElement;
  /** The channel's media gallery. Shown only for a text channel on a server
   *  with `channel_media`; `setChatHeaderMedia` is its only writer. */
  readonly mediaBtn?: HTMLButtonElement;
  /** Holds the DM partner's avatar (or a group's stack) in place of the "@". */
  readonly avatarEl: HTMLSpanElement;
  /**
   * The narrow-width sidebar toggle. Hidden above 800px; visible below it,
   * where the sidebar collapses. The drawer owns its `aria-expanded`.
   */
  readonly sidebarToggle: HTMLButtonElement;
  /** The hash+name region. Its pointer cursor is only honest when the DM
   *  profile panel can actually open (1:1 DMs, not groups) — F24. */
  readonly nameGroupEl: HTMLDivElement;
}

export interface ChatHeaderOptions {
  readonly onTogglePins: () => void;
  /** Open or close the channel's thread list, anchored to the button. */
  readonly onToggleThreads?: (anchor: HTMLButtonElement) => void;
  /** Open or close the channel's media gallery. */
  readonly onToggleMedia?: () => void;
  readonly onSearchFocus?: () => void;
  readonly onToggleDmProfile?: () => void;
  /** Show or hide the group DM member panel. */
  readonly onToggleMemberList?: () => void;
  /** Show or hide the guild member column. */
  readonly onToggleGuildMemberList?: () => void;
  /** Start a call in the current DM: join its voice channel and ring. */
  readonly onStartCall?: () => void;
  /** Start a call in the current DM with the camera on. */
  readonly onStartVideoCall?: () => void;
  /** Rename the open group DM. Reached by clicking the group's name. */
  readonly onRenameGroup?: () => void;
}

/** What the header shows for a DM. `avatar` is built by the caller (it owns the
 *  data); `isGroup` makes a click on the name rename instead of open a profile. */
export interface ChatHeaderDm {
  readonly username: string;
  readonly status: string;
  readonly avatar?: HTMLElement | null;
  readonly isGroup?: boolean;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildChatHeader(opts: ChatHeaderOptions): {
  element: HTMLDivElement;
  refs: ChatHeaderRefs;
} {
  const header = createElement("div", { class: "chat-header", "data-testid": "chat-header" });

  // The narrow-width navigation toggle. Always in the DOM (the drawer owns the
  // open state), but hidden by default and revealed by the <=800px media rule
  // in responsive.css, together with the rule that collapses the sidebar.
  const sidebarToggle = createElement("button", {
    type: "button",
    class: "ch-sidebar-toggle",
    title: shellText("sidebar.open"),
    "aria-label": shellText("sidebar.open"),
    "aria-expanded": "false",
    "aria-controls": "unified-sidebar",
    "data-testid": "sidebar-toggle",
  });
  sidebarToggle.appendChild(createIcon("menu", 18));

  const hash = createElement("span", { class: "ch-hash" }, "#");
  const nameEl = createElement(
    "span",
    { class: "ch-name", "data-testid": "chat-header-name" },
    messagingText("header.channelFallback"),
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
      // A group has no profile panel; its name is the rename affordance.
      if (nameGroup.dataset["dmGroup"] === "true") {
        opts.onRenameGroup?.();
        return;
      }
      toggle();
    });
  }
  const avatarEl = createElement("span", { class: "ch-avatar", "data-testid": "ch-avatar" });
  avatarEl.style.display = "none";
  appendChildren(nameGroup, hash, avatarEl, nameEl);

  const divider = createElement("div", { class: "ch-divider" });
  const topicEl = createElement(
    "span",
    { class: "ch-topic", "data-testid": "chat-header-topic" },
    "",
  );
  // A long topic is ellipsised in one line; clicking it (or Enter/Space on the
  // focused topic) opens the full text. Only armed while a channel topic is
  // shown: a DM's status line carries no `data-topic`.
  const openTopic = (): void => {
    const topic = topicEl.dataset["topic"];
    if (topic === undefined || topic === "") return;
    openTopicModal(nameEl.textContent ?? "", topic);
  };
  topicEl.addEventListener("click", openTopic);
  topicEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openTopic();
    }
  });

  const tools = createElement("div", { class: "ch-tools" });
  const callBtn = createElement("button", {
    type: "button",
    class: "call-btn",
    title: messagingText("header.startCall"),
    "aria-label": messagingText("header.startCall"),
    "data-testid": "call-btn",
  });
  callBtn.appendChild(createIcon("phone", 18));
  callBtn.style.display = "none";
  if (opts.onStartCall !== undefined) {
    const start = opts.onStartCall;
    callBtn.addEventListener("click", () => start());
  }
  const videoCallBtn = createElement("button", {
    type: "button",
    class: "call-btn",
    title: messagingText("header.startVideoCall"),
    "aria-label": messagingText("header.startVideoCall"),
    "data-testid": "video-call-btn",
  });
  videoCallBtn.appendChild(createIcon("camera", 18));
  videoCallBtn.style.display = "none";
  if (opts.onStartVideoCall !== undefined) {
    const start = opts.onStartVideoCall;
    videoCallBtn.addEventListener("click", () => start());
  }
  const profileBtn = createElement("button", {
    type: "button",
    class: "profile-btn",
    title: requestsText("dm.showProfile"),
    "aria-label": requestsText("dm.showProfile"),
    "aria-pressed": "false",
    "data-testid": "dm-profile-btn",
  });
  profileBtn.appendChild(createIcon("user", 18));
  profileBtn.style.display = "none";
  if (opts.onToggleDmProfile !== undefined) {
    const toggle = opts.onToggleDmProfile;
    profileBtn.addEventListener("click", () => toggle());
  }
  const membersBtn = createElement("button", {
    type: "button",
    class: "profile-btn members-btn",
    title: requestsText("group.showMembers"),
    "aria-label": requestsText("group.showMembers"),
    "aria-pressed": "false",
    "data-testid": "dm-members-btn",
  });
  membersBtn.appendChild(createIcon("user", 18));
  membersBtn.style.display = "none";
  if (opts.onToggleMemberList !== undefined) {
    const toggle = opts.onToggleMemberList;
    membersBtn.addEventListener("click", () => toggle());
  }
  const memberListBtn = createElement("button", {
    type: "button",
    class: "profile-btn member-list-btn",
    title: shellText("members.toggle"),
    "aria-label": shellText("members.toggle"),
    "aria-pressed": "false",
    "aria-controls": "member-column",
    "data-testid": "member-list-toggle",
  });
  memberListBtn.appendChild(createIcon("users", 18));
  memberListBtn.hidden = true;
  if (opts.onToggleGuildMemberList !== undefined) {
    const toggle = opts.onToggleGuildMemberList;
    memberListBtn.addEventListener("click", () => toggle());
  }
  const callChatBtn = createElement("button", {
    type: "button",
    class: "profile-btn call-chat-btn",
    title: shellText("callChat.hide"),
    "aria-label": shellText("callChat.hide"),
    "aria-pressed": "true",
    "data-testid": "call-chat-toggle",
  });
  callChatBtn.appendChild(createIcon("message-square", 18));
  callChatBtn.hidden = true;
  const threadsBtn = createElement("button", {
    type: "button",
    class: "pin-btn threads-btn",
    title: messagingText("header.threads"),
    "aria-label": messagingText("header.threads"),
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
    "data-testid": "threads-btn",
  });
  threadsBtn.appendChild(createIcon("message-square", 18));
  threadsBtn.hidden = true;
  if (opts.onToggleThreads !== undefined) {
    const toggle = opts.onToggleThreads;
    threadsBtn.addEventListener("click", () => toggle(threadsBtn));
  }
  const mediaBtn = createElement("button", {
    type: "button",
    class: "pin-btn media-btn",
    title: messagingText("header.media"),
    "aria-label": messagingText("header.media"),
    "data-testid": "media-btn",
  });
  mediaBtn.appendChild(createIcon("image", 18));
  mediaBtn.hidden = true;
  if (opts.onToggleMedia !== undefined) {
    const toggle = opts.onToggleMedia;
    mediaBtn.addEventListener("click", () => toggle());
  }
  const pinBtn = createElement("button", {
    type: "button",
    class: "pin-btn pins-btn",
    title: messagingText("header.pins"),
    "aria-label": messagingText("header.pins"),
    "data-testid": "pin-btn",
  });
  pinBtn.appendChild(createIcon("pin", 18));
  pinBtn.addEventListener("click", () => {
    opts.onTogglePins();
  });
  const searchInput = createElement("input", {
    class: "search-input",
    type: "text",
    placeholder: messagingText("header.search"),
    "data-testid": "search-input",
  });
  // On a phone the box gives way to an icon; CSS shows one or the other.
  const searchBtn = createElement("button", {
    type: "button",
    class: "search-btn",
    title: messagingText("header.search"),
    "aria-label": messagingText("header.search"),
    "data-testid": "search-btn",
  });
  searchBtn.appendChild(createIcon("search", 18));
  if (opts.onSearchFocus !== undefined) {
    const onFocus = opts.onSearchFocus;
    searchInput.addEventListener("focus", () => {
      onFocus();
      searchInput.blur();
    });
    searchBtn.addEventListener("click", () => onFocus());
  }
  appendChildren(
    tools,
    searchInput,
    searchBtn,
    callBtn,
    videoCallBtn,
    callChatBtn,
    profileBtn,
    membersBtn,
    memberListBtn,
    pinBtn,
    threadsBtn,
    mediaBtn,
  );

  appendChildren(header, sidebarToggle, nameGroup, divider, topicEl, tools);
  return {
    element: header,
    refs: {
      hashEl: hash,
      nameEl,
      topicEl,
      callBtn,
      videoCallBtn,
      profileBtn,
      membersBtn,
      memberListBtn,
      callChatBtn,
      threadsBtn,
      mediaBtn,
      avatarEl,
      sidebarToggle,
      nameGroupEl: nameGroup,
    },
  };
}

// ---------------------------------------------------------------------------
// Channel-mode helpers
// ---------------------------------------------------------------------------

/**
 * The header glyph for a channel type: the sidebar's megaphone for an
 * announcement channel, its speaker for a voice channel, "#" for every other text-style channel. Mirrors
 * `renderTextChannelItem` so the two cannot disagree.
 */
export function setChatHeaderChannelType(
  refs: ChatHeaderRefs,
  type: ChannelType | undefined,
): void {
  if (type === "announcement" || type === "voice" || type === "forum") {
    refs.hashEl.dataset["channelType"] = type;
    refs.hashEl.replaceChildren(
      createIcon(
        type === "voice" ? "volume-2" : type === "forum" ? "messages-square" : "megaphone",
        18,
      ),
    );
  } else {
    delete refs.hashEl.dataset["channelType"];
    setText(refs.hashEl, "#");
  }
}

/** Show the Threads button for a text channel on a server that has threads. */
export function setChatHeaderThreads(refs: ChatHeaderRefs, visible: boolean): void {
  if (refs.threadsBtn === undefined) return;
  refs.threadsBtn.hidden = !visible;
  if (!visible) refs.threadsBtn.setAttribute("aria-expanded", "false");
}

/** Show the Media button for a text channel on a server with the gallery. */
export function setChatHeaderMedia(refs: ChatHeaderRefs, visible: boolean): void {
  if (refs.mediaBtn === undefined) return;
  refs.mediaBtn.hidden = !visible;
}

/**
 * The call view's chat toggle: shown only while the chat can sit beside the
 * grid (`capable`); `open` is the user's choice, mirrored in `aria-pressed`.
 */
export function setChatHeaderCallChat(
  refs: ChatHeaderRefs,
  state: { readonly capable: boolean; readonly open: boolean },
): void {
  const label = shellText(state.open ? "callChat.hide" : "callChat.show");
  refs.callChatBtn.hidden = !state.capable;
  refs.callChatBtn.setAttribute("aria-pressed", String(state.open));
  refs.callChatBtn.title = label;
  refs.callChatBtn.setAttribute("aria-label", label);
}

/** Show a channel topic in the header and arm the click-to-read-in-full. */
export function setChatHeaderTopic(refs: ChatHeaderRefs, topic: string): void {
  setText(refs.topicEl, topic);
  if (topic === "") {
    delete refs.topicEl.dataset["topic"];
    refs.topicEl.removeAttribute("role");
    refs.topicEl.removeAttribute("tabindex");
    refs.topicEl.removeAttribute("title");
    return;
  }
  refs.topicEl.dataset["topic"] = topic;
  refs.topicEl.setAttribute("role", "button");
  refs.topicEl.setAttribute("tabindex", "0");
  refs.topicEl.title = messagingText("header.topicOpen");
}

/**
 * A small modal with the whole topic. The topic is user text, so it goes in
 * through `textContent` only, never as markup; Escape, the backdrop and the
 * close button all dismiss it.
 */
export function openTopicModal(channelName: string, topic: string): void {
  const title = createElement("h3", { id: "channel-topic-title" });
  title.textContent = messagingText("header.topicTitle", { channel: channelName });
  const closeBtn = createElement("button", {
    class: "modal-close",
    type: "button",
    "aria-label": shellText("common.close"),
    "data-testid": "channel-topic-close",
  });
  closeBtn.appendChild(createIcon("x", 14));
  const header = createElement("div", { class: "modal-header" });
  appendChildren(header, title, closeBtn);

  const body = createElement("div", { class: "modal-body" });
  const text = createElement("p", {
    class: "channel-topic-full",
    "data-testid": "channel-topic-text",
  });
  text.textContent = topic;
  body.appendChild(text);

  const instance = createModal({
    content: header,
    overlayAttrs: { "data-testid": "channel-topic-modal" },
    ariaLabelledBy: "channel-topic-title",
  });
  instance.modal.appendChild(body);
  closeBtn.addEventListener("click", () => instance.close());
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
export function updateChatHeaderForDm(refs: ChatHeaderRefs, recipient: ChatHeaderDm | null): void {
  if (recipient !== null) {
    const avatar = recipient.avatar ?? null;
    delete refs.hashEl.dataset["channelType"];
    setText(refs.hashEl, "@");
    // With an avatar the "@" would only repeat what the picture says.
    refs.hashEl.style.display = avatar !== null ? "none" : "";
    refs.avatarEl.replaceChildren(...(avatar !== null ? [avatar] : []));
    refs.avatarEl.style.display = avatar !== null ? "" : "none";
    refs.nameGroupEl.dataset["dmGroup"] = recipient.isGroup === true ? "true" : "false";
    setText(refs.nameEl, recipient.username);
    setChatHeaderTopic(refs, "");
    setText(refs.topicEl, recipient.status);
    refs.callBtn.style.display = "";
    refs.videoCallBtn.style.display = "";
    if (refs.threadsBtn !== undefined) refs.threadsBtn.hidden = true;
    refs.profileBtn.style.display = recipient.isGroup === true ? "none" : "";
    refs.membersBtn.style.display = recipient.isGroup === true ? "" : "none";
  } else {
    setChatHeaderChannelType(refs, undefined);
    refs.hashEl.style.display = "";
    refs.avatarEl.replaceChildren();
    refs.avatarEl.style.display = "none";
    delete refs.nameGroupEl.dataset["dmGroup"];
    refs.callBtn.style.display = "none";
    refs.videoCallBtn.style.display = "none";
    refs.profileBtn.style.display = "none";
    refs.membersBtn.style.display = "none";
  }
}

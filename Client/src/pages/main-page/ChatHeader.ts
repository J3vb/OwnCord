/**
 * ChatHeader — builds the channel header bar with name, topic, pins, and search.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
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
  readonly onSearchFocus?: () => void;
  readonly onToggleDmProfile?: () => void;
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
  const topicEl = createElement("span", { class: "ch-topic" }, "");

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
  const pinBtn = createElement("button", {
    type: "button",
    class: "pin-btn",
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
  if (opts.onSearchFocus !== undefined) {
    const onFocus = opts.onSearchFocus;
    searchInput.addEventListener("focus", () => {
      onFocus();
      searchInput.blur();
    });
  }
  appendChildren(tools, searchInput, callBtn, videoCallBtn, profileBtn, pinBtn);

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
      avatarEl,
      sidebarToggle,
      nameGroupEl: nameGroup,
    },
  };
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
    setText(refs.hashEl, "@");
    // With an avatar the "@" would only repeat what the picture says.
    refs.hashEl.style.display = avatar !== null ? "none" : "";
    refs.avatarEl.replaceChildren(...(avatar !== null ? [avatar] : []));
    refs.avatarEl.style.display = avatar !== null ? "" : "none";
    refs.nameGroupEl.dataset["dmGroup"] = recipient.isGroup === true ? "true" : "false";
    setText(refs.nameEl, recipient.username);
    setText(refs.topicEl, recipient.status);
    refs.callBtn.style.display = "";
    refs.videoCallBtn.style.display = "";
    refs.profileBtn.style.display = recipient.isGroup === true ? "none" : "";
  } else {
    setText(refs.hashEl, "#");
    refs.hashEl.style.display = "";
    refs.avatarEl.replaceChildren();
    refs.avatarEl.style.display = "none";
    delete refs.nameGroupEl.dataset["dmGroup"];
    refs.callBtn.style.display = "none";
    refs.videoCallBtn.style.display = "none";
    refs.profileBtn.style.display = "none";
  }
}

/**
 * The static parts of the user profile popup card: where it sits on screen and
 * the avatar, identity lines, status line, about and join sections that are
 * built once from the member's data.
 */
import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { applyStatusIndicator, applyStatusLine } from "@lib/ui/statusIndicator";
import { requestsText } from "../../i18n/requests";
import { playingForLine } from "../members/gameActivityLine";
import { mountListeningCard } from "../members/listeningCard";
import { createAvatarElement, pickAvatarColor } from "./avatar";
import type { UserProfileData } from "./userProfileTypes";

export const POPUP_WIDTH = 300;
/** Keeps the card clear of the window edges on both axes. */
const VIEWPORT_MARGIN = 8;
/** Breathing room between the click point and the card. */
const ANCHOR_GAP = 8;

/**
 * Place the card beside the anchor, flipping and clamping so it always lands
 * fully on screen — Discord opens its popout away from whichever edge the
 * clicked row is nearest.
 *
 * The height is measured rather than assumed. The previous version guessed
 * 300px and only clamped the top edge, so a member clicked low in the list
 * opened a card that ran off the bottom of the window.
 */
export function position(el: HTMLElement, anchorX: number, anchorY: number): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const height = el.offsetHeight;

  // Prefer the right of the anchor and flip left when there is no room. The
  // member list sits against the right edge, so flipping is the usual case.
  let left = anchorX + ANCHOR_GAP;
  if (left + POPUP_WIDTH > vw - VIEWPORT_MARGIN) {
    left = anchorX - POPUP_WIDTH - ANCHOR_GAP;
  }
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - POPUP_WIDTH - VIEWPORT_MARGIN));

  // Align the top with the click, then lift the card just enough to fit.
  let top = anchorY;
  if (top + height > vh - VIEWPORT_MARGIN) {
    top = vh - height - VIEWPORT_MARGIN;
  }
  top = Math.max(VIEWPORT_MARGIN, top);

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

export function buildAvatar(user: UserProfileData): HTMLDivElement {
  // The shared helper is what makes uploaded avatars work here and in the
  // message rows and member list at the same time: it fetches the
  // authenticated file through the cert-pinned path and falls back to the
  // letter until (or unless) the bytes arrive.
  const wrapper = createAvatarElement(
    {
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar,
      isDeleted: user.isDeleted,
    },
    {
      className: "upp-avatar",
      animate: "always",
      background: user.isDeleted === true ? "#4e5058" : pickAvatarColor(user.username),
    },
  );

  // Status dot overlay
  const statusDot = createElement("div", { class: "upp-status-dot" });
  applyStatusIndicator(statusDot, user.status, user.mobile === true);
  wrapper.appendChild(statusDot);

  return wrapper;
}

export interface IdentityLines {
  readonly nameEl: HTMLDivElement;
  readonly handleEl: HTMLDivElement;
  readonly customStatusEl: HTMLDivElement;
  readonly activityEl: HTMLDivElement;
  readonly listeningEl: HTMLDivElement;
}

/** The name, @username, custom status, game and song lines under the avatar. */
export function buildIdentityLines(
  user: UserProfileData,
  displayName: string,
  disposable: Disposable,
): IdentityLines {
  // Username
  const nameEl = createElement("div", { class: "upp-username" }, displayName);
  if (user.isDeleted === true) {
    nameEl.style.color = "var(--text-faint, #80848e)";
  }

  // Username line, shown only when a display name is standing in for it.
  // @mentions still resolve by username, so the popup has to keep telling
  // you what to type.
  const handleEl = createElement("div", { class: "upp-username-handle" });
  if (user.isDeleted !== true && displayName !== user.username) {
    setText(handleEl, `@${user.username}`);
  }

  // Custom status line — the user's own words, under the name.
  const customStatusEl = createElement("div", { class: "upp-custom-status" });
  if (typeof user.customStatus === "string" && user.customStatus.length > 0) {
    setText(customStatusEl, user.customStatus);
  }

  // The game being played, under the custom status. Empty (and
  // hidden by CSS) when there is none.
  const activityEl = createElement("div", {
    class: "upp-activity",
    "data-testid": "upp-activity",
  });
  if (user.activity != null && user.isDeleted !== true) {
    const icon = createIcon("gamepad-2", 14);
    icon.setAttribute("aria-hidden", "true");
    icon.classList.add("upp-activity-icon");
    const text = createElement("span", { class: "upp-activity-text" });
    setText(text, playingForLine(user.activity, Date.now()));
    appendChildren(activityEl, icon, text);
  }

  // The song being listened to, under the game. Its clock stops
  // with the popup.
  const listeningEl = createElement("div", {
    class: "upp-listening",
    "data-testid": "upp-listening",
  });
  if (user.listening != null && user.isDeleted !== true) {
    disposable.addCleanup(mountListeningCard(listeningEl, user.listening, { prefix: "upp" }));
  }
  return { nameEl, handleEl, customStatusEl, activityEl, listeningEl };
}

export function buildStatusLine(user: UserProfileData): HTMLDivElement {
  const statusLine = createElement("div", { class: "upp-status-line" });
  const statusDotInline = createElement("span", { class: "upp-status-dot-inline" });
  const statusText = createElement(
    "span",
    {},
    applyStatusLine(statusDotInline, user.status, user.mobile === true),
  );
  appendChildren(statusLine, statusDotInline, statusText);
  return statusLine;
}

/** About section (2 lines max). */
export function buildAboutSection(user: UserProfileData): HTMLDivElement {
  const aboutSection = createElement("div", { class: "upp-about" });
  if (user.about !== undefined && user.about !== null && user.about.length > 0) {
    const aboutTitle = createElement(
      "div",
      { class: "upp-section-title" },
      requestsText("profile.about"),
    );
    const aboutText = createElement("div", { class: "upp-about-text" }, user.about);
    appendChildren(aboutSection, aboutTitle, aboutText);
  }
  return aboutSection;
}

export function buildJoinSection(user: UserProfileData): HTMLDivElement {
  const joinSection = createElement("div", { class: "upp-join-date" });
  if (user.joinDate !== undefined && user.joinDate !== null) {
    const joinTitle = createElement(
      "div",
      { class: "upp-section-title" },
      requestsText("profile.memberSince"),
    );
    const joinText = createElement("div", { class: "upp-join-text" }, user.joinDate);
    appendChildren(joinSection, joinTitle, joinText);
  }
  return joinSection;
}

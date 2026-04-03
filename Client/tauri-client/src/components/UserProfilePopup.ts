/**
 * UserProfilePopup — anchored popover that appears when clicking a username
 * in the chat or member list. Shows avatar, username, role badge, status dot,
 * about section, join date, and Message/Call action buttons.
 *
 * Position: anchored to click point, flips if <100px from viewport edge.
 * Animation: fade+scale 100ms.
 * Close: outside click or Escape.
 * A11y: role="dialog", aria-label, focus trap, return focus on close.
 */

import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import type { UserStatus } from "@lib/types";
import { isSafeUrl } from "./message-list/attachments";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserProfileData {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly role: string;
  readonly status: UserStatus;
  readonly about?: string | null;
  readonly joinDate?: string | null;
  readonly isDeleted?: boolean;
}

export interface UserProfilePopupOptions {
  readonly user: UserProfileData;
  /** Anchor point — the click event's clientX/clientY. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Called when the user clicks "Message". */
  readonly onMessage?: (userId: number) => void;
  /** Called when the user clicks "Call". */
  readonly onCall?: (userId: number) => void;
}

export type UserProfilePopupComponent = MountableComponent & {
  /** Check if the popup is currently visible. */
  isOpen(): boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POPUP_WIDTH = 300;
const EDGE_THRESHOLD = 100;
const ANIMATION_DURATION_MS = 100;

const STATUS_COLORS: Record<UserStatus, string> = {
  online: "#3ba55d",
  idle: "#faa61a",
  dnd: "#ed4245",
  offline: "#747f8d",
};

const STATUS_LABELS: Record<UserStatus, string> = {
  online: "Online",
  idle: "Idle",
  dnd: "Do Not Disturb",
  offline: "Offline",
};

const ROLE_COLORS: Record<string, string> = {
  owner: "#e74c3c",
  admin: "#f39c12",
  moderator: "#2ecc71",
  member: "#949ba4",
};

// ---------------------------------------------------------------------------
// Component factory
// ---------------------------------------------------------------------------

export function createUserProfilePopup(
  options: UserProfilePopupOptions,
): UserProfilePopupComponent {
  const ac = new AbortController();
  const { signal } = ac;

  let overlay: HTMLDivElement | null = null;
  let popup: HTMLDivElement | null = null;
  let previousFocus: Element | null = null;

  function isOpen(): boolean {
    return popup !== null && overlay !== null;
  }

  function close(): void {
    if (overlay !== null) {
      overlay.remove();
      overlay = null;
    }
    popup = null;
    ac.abort();

    // Return focus to the element that was focused before opening
    if (previousFocus instanceof HTMLElement) {
      previousFocus.focus();
    }
  }

  function computePosition(anchorX: number, anchorY: number): { left: number; top: number } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = anchorX;
    let top = anchorY;

    // Flip horizontally if too close to right edge
    if (vw - anchorX < EDGE_THRESHOLD) {
      left = anchorX - POPUP_WIDTH;
    }

    // Flip vertically if too close to bottom edge
    if (vh - anchorY < EDGE_THRESHOLD) {
      top = anchorY - 300; // approximate popup height
    }

    // Clamp to viewport
    left = Math.max(8, Math.min(left, vw - POPUP_WIDTH - 8));
    top = Math.max(8, top);

    return { left, top };
  }

  function buildAvatar(user: UserProfileData): HTMLDivElement {
    const wrapper = createElement("div", { class: "upp-avatar" });

    if (user.isDeleted === true) {
      wrapper.style.background = "#4e5058";
      const text = createElement("span", {}, "?");
      wrapper.appendChild(text);
    } else if (user.avatar !== null && user.avatar.length > 0 && isSafeUrl(user.avatar)) {
      const img = createElement("img", {
        src: user.avatar,
        alt: user.username,
        class: "upp-avatar-img",
      });
      img.style.width = "64px";
      img.style.height = "64px";
      img.style.borderRadius = "50%";
      wrapper.appendChild(img);
    } else {
      wrapper.style.background = "var(--accent, #5865f2)";
      const initial = user.username.charAt(0).toUpperCase() || "?";
      const text = createElement("span", {}, initial);
      wrapper.appendChild(text);
    }

    // Status dot overlay
    const statusDot = createElement("div", { class: "upp-status-dot" });
    statusDot.style.background = STATUS_COLORS[user.status] ?? STATUS_COLORS.offline;
    statusDot.title = STATUS_LABELS[user.status] ?? "Offline";
    wrapper.appendChild(statusDot);

    return wrapper;
  }

  function mount(container: Element): void {
    previousFocus = document.activeElement;
    const user = options.user;
    const displayName = user.isDeleted === true ? "[deleted]" : user.username;

    // Overlay for outside-click detection
    overlay = createElement("div", {
      class: "upp-overlay",
      "data-testid": "user-profile-overlay",
    });

    // Popup container
    popup = createElement("div", {
      class: "upp-popup",
      role: "dialog",
      "aria-label": "User profile",
      "aria-modal": "true",
      tabindex: "-1",
      "data-testid": "user-profile-popup",
    });

    // Position the popup
    const pos = computePosition(options.anchorX, options.anchorY);
    popup.style.left = `${pos.left}px`;
    popup.style.top = `${pos.top}px`;
    popup.style.width = `${POPUP_WIDTH}px`;

    // Animation: fade + scale
    popup.style.opacity = "0";
    popup.style.transform = "scale(0.95)";
    popup.style.transition = `opacity ${ANIMATION_DURATION_MS}ms ease, transform ${ANIMATION_DURATION_MS}ms ease`;

    // --- Content ---

    // Avatar
    const avatar = buildAvatar(user);

    // Username
    const nameEl = createElement("div", { class: "upp-username" }, displayName);
    if (user.isDeleted === true) {
      nameEl.style.color = "var(--text-faint, #80848e)";
    }

    // Role badge
    const roleBadge = createElement("span", { class: "upp-role-badge" });
    const roleDot = createElement("span", { class: "upp-role-dot" });
    roleDot.style.background = ROLE_COLORS[user.role] ?? ROLE_COLORS.member ?? "";
    const roleLabel = createElement(
      "span",
      {},
      user.role.charAt(0).toUpperCase() + user.role.slice(1),
    );
    appendChildren(roleBadge, roleDot, roleLabel);

    // Status line
    const statusLine = createElement("div", { class: "upp-status-line" });
    const statusDotInline = createElement("span", { class: "upp-status-dot-inline" });
    statusDotInline.style.background = STATUS_COLORS[user.status] ?? STATUS_COLORS.offline;
    const statusText = createElement("span", {}, STATUS_LABELS[user.status] ?? "Offline");
    appendChildren(statusLine, statusDotInline, statusText);

    // About section (2 lines max)
    const aboutSection = createElement("div", { class: "upp-about" });
    if (user.about !== undefined && user.about !== null && user.about.length > 0) {
      const aboutTitle = createElement("div", { class: "upp-section-title" }, "ABOUT ME");
      const aboutText = createElement("div", { class: "upp-about-text" }, user.about);
      appendChildren(aboutSection, aboutTitle, aboutText);
    }

    // Join date
    const joinSection = createElement("div", { class: "upp-join-date" });
    if (user.joinDate !== undefined && user.joinDate !== null) {
      const joinTitle = createElement("div", { class: "upp-section-title" }, "MEMBER SINCE");
      const joinText = createElement("div", { class: "upp-join-text" }, user.joinDate);
      appendChildren(joinSection, joinTitle, joinText);
    }

    // Divider
    const divider = createElement("div", { class: "upp-divider" });

    // Actions
    const actions = createElement("div", { class: "upp-actions" });

    const messageBtn = createElement("button", {
      class: "upp-action-btn",
      "data-testid": "upp-message-btn",
    });
    messageBtn.appendChild(createIcon("send", 16));
    messageBtn.appendChild(document.createTextNode(" Message"));
    messageBtn.addEventListener(
      "click",
      () => {
        options.onMessage?.(user.id);
        close();
      },
      { signal },
    );

    const callBtn = createElement("button", {
      class: "upp-action-btn",
      "data-testid": "upp-call-btn",
    });
    callBtn.appendChild(createIcon("phone", 16));
    callBtn.appendChild(document.createTextNode(" Call"));
    callBtn.addEventListener(
      "click",
      () => {
        options.onCall?.(user.id);
        close();
      },
      { signal },
    );

    appendChildren(actions, messageBtn, callBtn);

    // Assemble popup
    appendChildren(
      popup,
      avatar,
      nameEl,
      roleBadge,
      statusLine,
      aboutSection,
      joinSection,
      divider,
      actions,
    );

    overlay.appendChild(popup);
    container.appendChild(overlay);

    // Trigger animation
    requestAnimationFrame(() => {
      if (popup !== null) {
        popup.style.opacity = "1";
        popup.style.transform = "scale(1)";
      }
    });

    // Focus the popup for a11y
    popup.focus();

    // Close on outside click (click on overlay but not on popup)
    overlay.addEventListener(
      "mousedown",
      (e: MouseEvent) => {
        if (popup !== null && !popup.contains(e.target as Node)) {
          close();
        }
      },
      { signal },
    );

    // Close on Escape
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && isOpen()) {
          close();
        }
      },
      { signal },
    );

    // Focus trap: keep focus inside popup
    popup.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key !== "Tab" || popup === null) return;
        const focusable = popup.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;

        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      },
      { signal },
    );
  }

  function destroy(): void {
    close();
  }

  return { mount, destroy, isOpen };
}

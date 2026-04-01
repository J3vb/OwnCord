/**
 * DmProfileSidebar -- right-side panel showing the DM partner's profile.
 * Appears when clicking the DM header ("@ username" area).
 * 340px wide, slides in from the right with a 170ms animation.
 *
 * Content: 80px avatar, username, status dot + label, about section,
 * "Member Since" date, and a local-only editable Note field.
 *
 * A11y: role="complementary", aria-label="User profile", Esc to close,
 * focus first focusable on open.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { UserStatus } from "@lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DmProfileData {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly status: UserStatus;
  readonly about?: string | null;
  readonly joinDate?: string | null;
}

export interface DmProfileSidebarOptions {
  readonly user: DmProfileData;
  readonly onClose: () => void;
}

export type DmProfileSidebarComponent = MountableComponent & {
  readonly isOpen: () => boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIDEBAR_WIDTH = 340;
const ANIMATION_DURATION_MS = 170;
const NOTE_STORAGE_PREFIX = "owncord:dm-note:";

const STATUS_COLORS: Readonly<Record<UserStatus, string>> = {
  online: "#3ba55d",
  idle: "#faa61a",
  dnd: "#ed4245",
  offline: "#747f8d",
};

const STATUS_LABELS: Readonly<Record<UserStatus, string>> = {
  online: "Online",
  idle: "Idle",
  dnd: "Do Not Disturb",
  offline: "Offline",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadNote(userId: number): string {
  try {
    return localStorage.getItem(NOTE_STORAGE_PREFIX + String(userId)) ?? "";
  } catch {
    return "";
  }
}

function saveNote(userId: number, text: string): void {
  try {
    localStorage.setItem(NOTE_STORAGE_PREFIX + String(userId), text);
  } catch {
    // localStorage may be unavailable or full -- silently ignore
  }
}

// ---------------------------------------------------------------------------
// Component factory
// ---------------------------------------------------------------------------

export function createDmProfileSidebar(
  options: DmProfileSidebarOptions,
): DmProfileSidebarComponent {
  const ac = new AbortController();
  const { signal } = ac;
  const { user, onClose } = options;

  let panel: HTMLDivElement | null = null;
  let open = false;

  function isOpen(): boolean {
    return open;
  }

  function buildAvatar(): HTMLDivElement {
    const wrapper = createElement("div", {
      class: "dps-avatar",
      "data-testid": "dps-avatar",
    });
    wrapper.style.width = "80px";
    wrapper.style.height = "80px";
    wrapper.style.borderRadius = "50%";
    wrapper.style.display = "flex";
    wrapper.style.alignItems = "center";
    wrapper.style.justifyContent = "center";
    wrapper.style.fontSize = "32px";
    wrapper.style.fontWeight = "700";
    wrapper.style.color = "#fff";
    wrapper.style.margin = "24px auto 12px";
    wrapper.style.position = "relative";
    wrapper.style.flexShrink = "0";

    if (user.avatar !== null && user.avatar.length > 0) {
      wrapper.style.background = "transparent";
      const img = createElement("img", {
        src: user.avatar,
        alt: user.username,
        class: "dps-avatar-img",
      });
      img.style.width = "80px";
      img.style.height = "80px";
      img.style.borderRadius = "50%";
      wrapper.appendChild(img);
    } else {
      wrapper.style.background = "var(--accent, #5865f2)";
      const initial = user.username.charAt(0).toUpperCase() || "?";
      const text = createElement("span", {}, initial);
      wrapper.appendChild(text);
    }

    // Status dot overlay
    const statusDot = createElement("div", { class: "dps-status-dot" });
    statusDot.style.position = "absolute";
    statusDot.style.bottom = "2px";
    statusDot.style.right = "2px";
    statusDot.style.width = "16px";
    statusDot.style.height = "16px";
    statusDot.style.borderRadius = "50%";
    statusDot.style.border = "3px solid var(--bg-secondary, #111214)";
    statusDot.style.background = STATUS_COLORS[user.status] ?? STATUS_COLORS.offline;
    statusDot.title = STATUS_LABELS[user.status] ?? "Offline";
    wrapper.appendChild(statusDot);

    return wrapper;
  }

  function mount(container: Element): void {
    open = true;

    panel = createElement("div", {
      class: "dm-profile-sidebar",
      role: "complementary",
      "aria-label": "User profile",
      tabindex: "-1",
      "data-testid": "dm-profile-sidebar",
    });

    // Base styles
    panel.style.width = `${SIDEBAR_WIDTH}px`;
    panel.style.background = "var(--bg-secondary, #111214)";
    panel.style.borderLeft = "1px solid var(--border-glow, rgba(0,200,255,0.08))";
    panel.style.display = "flex";
    panel.style.flexDirection = "column";
    panel.style.flexShrink = "0";
    panel.style.overflow = "hidden";
    panel.style.position = "relative";

    // Slide-in animation: start offscreen then animate
    panel.style.marginRight = `-${SIDEBAR_WIDTH}px`;
    panel.style.transition = `margin-right ${ANIMATION_DURATION_MS}ms ease`;

    // --- Close button ---
    const closeBtn = createElement("button", {
      class: "dps-close",
      "aria-label": "Close profile sidebar",
      "data-testid": "dps-close",
    });
    closeBtn.style.position = "absolute";
    closeBtn.style.top = "8px";
    closeBtn.style.right = "8px";
    closeBtn.style.background = "none";
    closeBtn.style.border = "none";
    closeBtn.style.color = "var(--text-muted, #949ba4)";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.fontSize = "18px";
    closeBtn.style.lineHeight = "1";
    closeBtn.style.padding = "4px";
    closeBtn.style.zIndex = "1";
    closeBtn.textContent = "\u2715";
    closeBtn.addEventListener(
      "click",
      () => {
        onClose();
      },
      { signal },
    );
    panel.appendChild(closeBtn);

    // --- Scrollable content ---
    const content = createElement("div", { class: "dps-content" });
    content.style.overflowY = "auto";
    content.style.flex = "1";
    content.style.padding = "0 16px 16px";

    // Avatar
    content.appendChild(buildAvatar());

    // Username
    const nameEl = createElement("div", {
      class: "dps-username",
      "data-testid": "dps-username",
    });
    nameEl.style.textAlign = "center";
    nameEl.style.fontSize = "20px";
    nameEl.style.fontWeight = "600";
    nameEl.style.color = "var(--text-primary, #f2f3f5)";
    nameEl.style.marginBottom = "4px";
    setText(nameEl, user.username);

    // Status line
    const statusLine = createElement("div", {
      class: "dps-status",
      "data-testid": "dps-status",
    });
    statusLine.style.display = "flex";
    statusLine.style.alignItems = "center";
    statusLine.style.justifyContent = "center";
    statusLine.style.gap = "6px";
    statusLine.style.marginBottom = "16px";
    statusLine.style.fontSize = "13px";
    statusLine.style.color = "var(--text-muted, #949ba4)";

    const statusDotInline = createElement("span", { class: "dps-status-dot-inline" });
    statusDotInline.style.width = "8px";
    statusDotInline.style.height = "8px";
    statusDotInline.style.borderRadius = "50%";
    statusDotInline.style.display = "inline-block";
    statusDotInline.style.background = STATUS_COLORS[user.status] ?? STATUS_COLORS.offline;

    const statusText = createElement("span", {}, STATUS_LABELS[user.status] ?? "Offline");
    appendChildren(statusLine, statusDotInline, statusText);

    appendChildren(content, nameEl, statusLine);

    // Divider helper
    const makeDivider = (): HTMLDivElement => {
      const d = createElement("div", { class: "dps-divider" });
      d.style.height = "1px";
      d.style.background = "var(--border-glow, rgba(0,200,255,0.08))";
      d.style.margin = "12px 0";
      return d;
    };

    // About section
    if (user.about !== undefined && user.about !== null && user.about.length > 0) {
      content.appendChild(makeDivider());
      const aboutTitle = createElement("div", { class: "dps-section-title" }, "ABOUT ME");
      aboutTitle.style.fontSize = "12px";
      aboutTitle.style.fontWeight = "700";
      aboutTitle.style.color = "var(--text-muted, #949ba4)";
      aboutTitle.style.textTransform = "uppercase";
      aboutTitle.style.marginBottom = "8px";

      const aboutText = createElement("div", {
        class: "dps-about-text",
        "data-testid": "dps-about",
      });
      aboutText.style.fontSize = "14px";
      aboutText.style.color = "var(--text-secondary, #dbdee1)";
      aboutText.style.lineHeight = "1.4";
      aboutText.style.wordBreak = "break-word";
      setText(aboutText, user.about);

      appendChildren(content, aboutTitle, aboutText);
    }

    // Member Since
    if (user.joinDate !== undefined && user.joinDate !== null) {
      content.appendChild(makeDivider());
      const joinTitle = createElement("div", { class: "dps-section-title" }, "MEMBER SINCE");
      joinTitle.style.fontSize = "12px";
      joinTitle.style.fontWeight = "700";
      joinTitle.style.color = "var(--text-muted, #949ba4)";
      joinTitle.style.textTransform = "uppercase";
      joinTitle.style.marginBottom = "8px";

      const joinText = createElement("div", {
        class: "dps-join-text",
        "data-testid": "dps-join-date",
      });
      joinText.style.fontSize = "14px";
      joinText.style.color = "var(--text-secondary, #dbdee1)";
      setText(joinText, user.joinDate);

      appendChildren(content, joinTitle, joinText);
    }

    // Note section (local-only, persisted to localStorage)
    content.appendChild(makeDivider());
    const noteTitle = createElement("div", { class: "dps-section-title" }, "NOTE");
    noteTitle.style.fontSize = "12px";
    noteTitle.style.fontWeight = "700";
    noteTitle.style.color = "var(--text-muted, #949ba4)";
    noteTitle.style.textTransform = "uppercase";
    noteTitle.style.marginBottom = "8px";

    const noteInput = createElement("textarea", {
      class: "dps-note",
      placeholder: "Click to add a note",
      "data-testid": "dps-note",
      rows: "3",
    });
    noteInput.style.width = "100%";
    noteInput.style.resize = "vertical";
    noteInput.style.background = "var(--bg-primary, #1e1f22)";
    noteInput.style.border = "none";
    noteInput.style.borderRadius = "4px";
    noteInput.style.color = "var(--text-primary, #f2f3f5)";
    noteInput.style.fontSize = "13px";
    noteInput.style.padding = "8px";
    noteInput.style.fontFamily = "inherit";
    noteInput.value = loadNote(user.id);

    noteInput.addEventListener(
      "input",
      () => {
        saveNote(user.id, noteInput.value);
      },
      { signal },
    );

    appendChildren(content, noteTitle, noteInput);

    panel.appendChild(content);
    container.appendChild(panel);

    // Trigger slide-in animation
    requestAnimationFrame(() => {
      if (panel !== null) {
        panel.style.marginRight = "0";
      }
    });

    // Focus panel for a11y
    panel.focus();

    // Close on Escape
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && open) {
          onClose();
        }
      },
      { signal },
    );
  }

  function destroy(): void {
    open = false;
    ac.abort();
    if (panel !== null) {
      panel.remove();
      panel = null;
    }
  }

  return { mount, destroy, isOpen };
}

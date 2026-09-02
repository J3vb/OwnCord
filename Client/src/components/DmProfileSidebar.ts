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
import { avatarInitial, isRenderableAvatar, resolveDisplayName } from "@lib/avatar";
import { fetchImageAsDataUrl, resolveServerUrl } from "./message-list/attachments";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DmProfileData {
  readonly id: number;
  readonly username: string;
  /** Nickname, when set. The DM header this panel opens from renders through
   *  `dmDisplayName`, which prefers this over `username` -- without it here
   *  the panel would show a different identity from the header just clicked. */
  readonly displayName?: string | null;
  readonly avatar: string | null;
  readonly status: UserStatus;
  readonly about?: string | null;
  readonly joinDate?: string | null;
}

export interface DmProfileSidebarOptions {
  readonly user: DmProfileData;
  readonly onClose: () => void;
  /**
   * The connected server's host, used to scope the note's localStorage key.
   * User ids are per-server, so without this a note about user 5 on one
   * server is shown for, and overwritten by, the unrelated user 5 on
   * another — real in the multi-profile client (see profiles.ts). Optional,
   * and falls back to the legacy unscoped key, so a caller that has not
   * been updated to pass it yet keeps today's single-profile behavior
   * exactly (including any note already saved under the old key).
   */
  readonly host?: string;
}

export type DmProfileSidebarComponent = MountableComponent & {
  readonly isOpen: () => boolean;
  /**
   * Repaint the name, avatar initial and status (dot + label, both the
   * avatar-corner one and the inline one) from a fresher `DmProfileData`,
   * in place -- without rebuilding the panel and losing the note textarea's
   * focus/selection. The panel itself has no subscription to any store (it
   * is intentionally presentational); the owner is expected to call this
   * when the underlying user's presence or identity changes while the panel
   * stays open, mirroring how ChannelController keeps the DM chat header
   * live across the same events (see ChannelController.ts's refreshDmHeader).
   * A no-op before mount() or after destroy().
   */
  readonly update: (user: DmProfileData) => void;
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
  // A DM partner is never invisible from here — the server maps it to offline
  // for everyone but its owner — but the map has to be total over UserStatus.
  invisible: "#747f8d",
  offline: "#747f8d",
};

const STATUS_LABELS: Readonly<Record<UserStatus, string>> = {
  online: "Online",
  idle: "Idle",
  dnd: "Do Not Disturb",
  invisible: "Invisible",
  offline: "Offline",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The legacy unscoped key, from before per-server notes (or when the caller
 *  has not yet been updated to pass a host). */
function legacyNoteKey(userId: number): string {
  return NOTE_STORAGE_PREFIX + String(userId);
}

function scopedNoteKey(userId: number, host: string): string {
  return `${NOTE_STORAGE_PREFIX}${host}:${userId}`;
}

function loadNote(userId: number, host: string): string {
  try {
    if (host === "") return localStorage.getItem(legacyNoteKey(userId)) ?? "";

    const scoped = localStorage.getItem(scopedNoteKey(userId, host));
    if (scoped !== null) return scoped;

    // Miss at the scoped key: read through to the pre-scoping legacy key
    // once, persist it under this host's key, and consume the legacy entry so
    // the migration can only ever apply to the FIRST host opened post-upgrade.
    // User ids are per-server autoincrement integers, so leaving the legacy
    // key in place would show server A's private note about user N for the
    // unrelated user N on every other server (OC-0329) — the same shape
    // channel-mutes.ts fixed for OC-0288.
    const legacy = localStorage.getItem(legacyNoteKey(userId));
    if (legacy === null) return "";
    try {
      localStorage.setItem(scopedNoteKey(userId, host), legacy);
      localStorage.removeItem(legacyNoteKey(userId));
    } catch {
      // Quota: the scoped copy could not be written. Keep the legacy key
      // for a later retry rather than losing the note behind an empty
      // panel (Codex on PR #1502); the note itself was read fine.
    }
    return legacy;
  } catch {
    return "";
  }
}

function saveNote(userId: number, host: string, text: string): void {
  try {
    const key = host !== "" ? scopedNoteKey(userId, host) : legacyNoteKey(userId);
    localStorage.setItem(key, text);
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
  const { onClose, host = "" } = options;
  let user = options.user;

  let panel: HTMLDivElement | null = null;
  let open = false;

  // Live-updatable node refs, populated on mount() and cleared on destroy()
  // -- see the `update()` doc comment on DmProfileSidebarComponent for why
  // these are repainted in place instead of the whole panel being rebuilt.
  let nameNode: HTMLDivElement | null = null;
  let avatarLetterNode: HTMLSpanElement | null = null;
  let statusDotNode: HTMLDivElement | null = null;
  let statusDotInlineNode: HTMLSpanElement | null = null;
  let statusTextNode: HTMLSpanElement | null = null;

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

    // The letter draws immediately; the picture (if any) is fetched through
    // the same cert-pinned, bearer-token path attachments use and swapped in
    // once the bytes arrive. `<img src>` cannot carry the auth header an
    // `/api/v1/files/{id}` avatar needs, so the URL is never assigned raw.
    wrapper.style.background = "var(--accent, #5865f2)";
    const initial = avatarInitial(user);
    const letter = createElement("span", {}, initial);
    avatarLetterNode = letter;
    wrapper.appendChild(letter);

    if (isRenderableAvatar(user.avatar)) {
      const resolved = resolveServerUrl(user.avatar);
      void fetchImageAsDataUrl(resolved).then((dataUrl) => {
        if (dataUrl === null || !wrapper.isConnected) return;
        const img = createElement("img", {
          src: dataUrl,
          alt: resolveDisplayName(user),
          class: "dps-avatar-img",
        });
        img.style.width = "80px";
        img.style.height = "80px";
        img.style.borderRadius = "50%";
        letter.remove();
        wrapper.style.background = "transparent";
        wrapper.insertBefore(img, wrapper.firstChild);
      });
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
    statusDotNode = statusDot;
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
    setText(nameEl, resolveDisplayName(user));
    nameNode = nameEl;

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
    statusDotInlineNode = statusDotInline;

    const statusText = createElement("span", {}, STATUS_LABELS[user.status] ?? "Offline");
    statusTextNode = statusText;
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
    noteInput.value = loadNote(user.id, host);

    noteInput.addEventListener(
      "input",
      () => {
        saveNote(user.id, host, noteInput.value);
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
    nameNode = null;
    avatarLetterNode = null;
    statusDotNode = null;
    statusDotInlineNode = null;
    statusTextNode = null;
  }

  function update(nextUser: DmProfileData): void {
    user = nextUser;
    // Not mounted (or already torn down) -- nothing to repaint. mount() will
    // paint the fresh `user` from scratch if it is called afterwards.
    if (panel === null) return;

    if (nameNode !== null) setText(nameNode, resolveDisplayName(user));

    const color = STATUS_COLORS[user.status] ?? STATUS_COLORS.offline;
    const label = STATUS_LABELS[user.status] ?? "Offline";

    if (statusDotNode !== null) {
      statusDotNode.style.background = color;
      statusDotNode.title = label;
    }
    if (statusDotInlineNode !== null) {
      statusDotInlineNode.style.background = color;
    }
    if (statusTextNode !== null) setText(statusTextNode, label);

    // Only repaint the fallback letter if it is still showing -- once the
    // fetched avatar image swaps in, buildAvatar() removes the letter node
    // from the DOM (see above), and a stale identity's initial no longer
    // matters (or exists) to update.
    if (avatarLetterNode !== null && avatarLetterNode.isConnected) {
      setText(avatarLetterNode, avatarInitial(user));
    }
  }

  return { mount, destroy, isOpen, update };
}

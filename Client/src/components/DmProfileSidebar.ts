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

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { UserStatus } from "@lib/types";
import { avatarInitial, isRenderableAvatar, resolveDisplayName } from "@lib/avatar";
import {
  fetchImageAsDataUrl,
  recoverEvictedImage,
  resolveServerUrl,
} from "./message-list/attachments";
import { migrateLegacyValue } from "@lib/legacyKeyMigration";
import { shellText } from "../i18n/shell";
import { requestsText } from "../i18n/requests";

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

const STATUS_LABELS: Readonly<
  Record<
    UserStatus,
    "status.online" | "status.idle" | "status.dnd" | "status.invisible" | "status.offline"
  >
> = {
  online: "status.online",
  idle: "status.idle",
  dnd: "status.dnd",
  invisible: "status.invisible",
  offline: "status.offline",
};

const statusLabel = (status: UserStatus): string => shellText(STATUS_LABELS[status]);

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

    // Miss at the scoped key: migrate the pre-scoping legacy note through
    // `migrateLegacyValue`, which moves it under the key of the FIRST host
    // opened post-upgrade and no other. User ids are per-server autoincrement
    // integers, so a legacy note left readable would show server A's private
    // note about user N for the unrelated user N on every other server
    // (OC-0329) — the same shape channel-mutes.ts fixed for OC-0288.
    return migrateLegacyValue(legacyNoteKey(userId), scopedNoteKey(userId, host)) ?? "";
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

// Divider helper
const makeDivider = (): HTMLDivElement => createElement("div", { class: "dps-divider" });

export function createDmProfileSidebar(
  options: DmProfileSidebarOptions,
): DmProfileSidebarComponent {
  const disposable = new Disposable();
  const { signal } = disposable;
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
    // The letter draws immediately; the picture (if any) is fetched through
    // the same cert-pinned, bearer-token path attachments use and swapped in
    // once the bytes arrive. `<img src>` cannot carry the auth header an
    // `/api/v1/files/{id}` avatar needs, so the URL is never assigned raw.
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
        recoverEvictedImage(img, { url: resolved });
        letter.remove();
        wrapper.style.background = "transparent";
        wrapper.insertBefore(img, wrapper.firstChild);
      });
    }

    // Status dot overlay
    const statusDot = createElement("div", { class: "dps-status-dot" });
    statusDot.style.background = STATUS_COLORS[user.status] ?? STATUS_COLORS.offline;
    statusDot.title = statusLabel(user.status);
    statusDotNode = statusDot;
    wrapper.appendChild(statusDot);

    return wrapper;
  }

  function mount(container: Element): void {
    open = true;

    panel = createElement("div", {
      class: "dm-profile-sidebar",
      role: "complementary",
      "aria-label": requestsText("profile.label"),
      tabindex: "-1",
      "data-testid": "dm-profile-sidebar",
    });

    // Slide-in animation: start offscreen then animate. Width and the
    // transition duration are static (see .dm-profile-sidebar in app.css);
    // the margin itself is the one genuinely animated value, kept in sync
    // with the CSS width via the same SIDEBAR_WIDTH constant.
    panel.style.marginRight = `-${SIDEBAR_WIDTH}px`;

    // --- Close button ---
    const closeBtn = createElement("button", {
      class: "dps-close",
      "aria-label": requestsText("profile.close"),
      "data-testid": "dps-close",
    });
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

    // Avatar
    content.appendChild(buildAvatar());

    // Username
    const nameEl = createElement("div", {
      class: "dps-username",
      "data-testid": "dps-username",
    });
    setText(nameEl, resolveDisplayName(user));
    nameNode = nameEl;

    // Status line
    const statusLine = createElement("div", {
      class: "dps-status",
      "data-testid": "dps-status",
    });

    const statusDotInline = createElement("span", { class: "dps-status-dot-inline" });
    statusDotInline.style.background = STATUS_COLORS[user.status] ?? STATUS_COLORS.offline;
    statusDotInlineNode = statusDotInline;

    const statusText = createElement("span", {}, statusLabel(user.status));
    statusTextNode = statusText;
    appendChildren(statusLine, statusDotInline, statusText);

    appendChildren(content, nameEl, statusLine);

    // About section
    if (user.about !== undefined && user.about !== null && user.about.length > 0) {
      content.appendChild(makeDivider());
      const aboutTitle = createElement(
        "div",
        { class: "dps-section-title" },
        requestsText("profile.about"),
      );

      const aboutText = createElement("div", {
        class: "dps-about-text",
        "data-testid": "dps-about",
      });
      setText(aboutText, user.about);

      appendChildren(content, aboutTitle, aboutText);
    }

    // Member Since
    if (user.joinDate !== undefined && user.joinDate !== null) {
      content.appendChild(makeDivider());
      const joinTitle = createElement(
        "div",
        { class: "dps-section-title" },
        requestsText("profile.memberSince"),
      );

      const joinText = createElement("div", {
        class: "dps-join-text",
        "data-testid": "dps-join-date",
      });
      setText(joinText, user.joinDate);

      appendChildren(content, joinTitle, joinText);
    }

    // Note section (local-only, persisted to localStorage)
    content.appendChild(makeDivider());
    const noteTitle = createElement(
      "div",
      { class: "dps-section-title" },
      requestsText("profile.note"),
    );

    const noteInput = createElement("textarea", {
      class: "dps-note",
      placeholder: requestsText("profile.notePlaceholder"),
      "data-testid": "dps-note",
      rows: "3",
    });
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
    disposable.destroy();
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
    const label = statusLabel(user.status);

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

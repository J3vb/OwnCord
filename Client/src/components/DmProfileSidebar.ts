/**
 * DmProfileSidebar -- right-side panel showing the DM partner's profile.
 * Appears when clicking the DM header ("@ username" area).
 * 340px wide, slides in from the right with a 170ms animation.
 *
 * Content: 80px avatar, username, status dot + label, about section,
 * "Member Since" date, and an editable private Note field (kept on the
 * server with the `user_notes` capability, else in localStorage).
 *
 * A11y: role="complementary", aria-label="User profile", Esc to close,
 * focus first focusable on open.
 */

import { Disposable } from "@lib/disposable";
import { dialogOpen } from "@lib/dialogOpen";
import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import type { UserStatus } from "@lib/types";
import { avatarInitial, resolveDisplayName } from "@lib/avatar";
import { isRenderableAvatar, setAvatarSource } from "./message-list/avatar";
import {
  fetchImageAsObjectUrl,
  recoverEvictedImage,
  resolveServerUrl,
} from "./message-list/attachments";
import { blocksStore } from "@stores/blocks.store";
import { paintBanner } from "../features/profiles/banner";
import { bannerImages } from "./bannerImages";
import { shellText, statusLabel } from "../i18n/shell";
import { requestsText } from "../i18n/requests";
import { playingForLine } from "../features/members/gameActivityLine";
import { mountListeningCard } from "../features/members/listeningCard";
import type { ListeningSong } from "../features/members/listeningLine";
import {
  NOTE_MAX_LENGTH,
  createNoteBinding,
  type NotesContext,
} from "../features/profiles/userNotes";

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
  /** The game being played (WP 8.3): "Playing <game> · for N min" under the status. */
  readonly activity?: { readonly name: string; readonly startedAt: number } | null;
  /** The song being listened to (WP 8.10), with a progress bar that ticks while open. */
  readonly listening?: ListeningSong | null;
  readonly about?: string | null;
  readonly joinDate?: string | null;
  /** Banner image path and colour; absent or null = no strip (WP 6.11d). */
  readonly banner?: string | null;
  readonly banner_color?: string | null;
}

export interface DmProfileSidebarOptions {
  readonly user: DmProfileData;
  readonly onClose: () => void;
  /** Block (`block` true) or Unblock this user (WP 3B-2). The owner confirms a
   *  Block; the label follows `blocksStore`. Omitted: no button. */
  readonly onToggleBlock?: (userId: number, block: boolean) => void;
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
  /**
   * Where the note is kept: the session that opened the panel, captured at open
   * so a flush on close or on a DM switch uses its API client. Omitted: the note
   * stays in localStorage under `host`, as before the server kept notes.
   */
  readonly notes?: NotesContext;
  /**
   * Move focus to the panel on mount. True (the default) when the user opened
   * it; false when it opened by itself with the conversation, so it never takes
   * focus from the composer or whatever the user was typing in.
   */
  readonly focus?: boolean;
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

const STATUS_COLORS: Readonly<Record<UserStatus, string>> = {
  online: "var(--green)",
  idle: "var(--yellow)",
  dnd: "var(--red)",
  // A DM partner is never invisible from here — the server maps it to offline
  // for everyone but its owner — but the map has to be total over UserStatus.
  invisible: "var(--text-micro)",
  offline: "var(--text-micro)",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** What the strip is painted from; "|" means no banner at all. */
const bannerKeyOf = (u: DmProfileData): string => `${u.banner ?? ""}|${u.banner_color ?? ""}`;

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
  let contentNode: HTMLDivElement | null = null;
  let contentOwner: Disposable | null = null;
  let avatarLetterNode: HTMLSpanElement | null = null;
  let avatarWrapperNode: HTMLDivElement | null = null;
  // The avatar value the face was last painted from, and a counter that drops a
  // stale fetch when a newer paint has started.
  let avatarSource: string | null | undefined;
  let avatarGen = 0;
  let bannerNode: HTMLDivElement | null = null;
  // What the strip was last painted from, so a presence change does not refetch.
  let bannerKey = "";
  let statusDotNode: HTMLDivElement | null = null;
  let statusDotInlineNode: HTMLSpanElement | null = null;
  let statusTextNode: HTMLSpanElement | null = null;
  let activityNode: HTMLDivElement | null = null;
  let listeningNode: HTMLDivElement | null = null;
  /** Stops the song card's clock; null when no card is drawn. */
  let stopListening: (() => void) | null = null;

  /** Draw (or clear) the "Playing <game> · for N min" line from `user`. */
  function paintActivity(): void {
    if (activityNode === null) return;
    activityNode.replaceChildren();
    if (user.activity == null) return;
    const icon = createIcon("gamepad-2", 14);
    icon.setAttribute("aria-hidden", "true");
    icon.classList.add("dps-activity-icon");
    const text = createElement("span", { class: "dps-activity-text" });
    setText(text, playingForLine(user.activity, Date.now()));
    appendChildren(activityNode, icon, text);
  }

  /** Draw (or clear) the song card from `user`, restarting its clock. */
  function paintListening(): void {
    stopListening?.();
    stopListening = null;
    if (listeningNode === null) return;
    listeningNode.replaceChildren();
    if (user.listening == null) return;
    stopListening = mountListeningCard(listeningNode, user.listening, { prefix: "dps" });
  }

  function isOpen(): boolean {
    return open;
  }

  /**
   * Draw the avatar face (letter, then the fetched picture) at the front of
   * `wrapper`, replacing whatever face it held. The letter draws immediately;
   * the picture (if any) is fetched through the same cert-pinned, bearer-token
   * path attachments use and swapped in once the bytes arrive. `<img src>`
   * cannot carry the auth header an `/api/v1/files/{id}` avatar needs, so the
   * URL is never assigned raw. A fetch that resolves after the avatar changed
   * again is dropped (`avatarGen`).
   */
  function paintAvatarFace(wrapper: HTMLDivElement): void {
    const gen = ++avatarGen;
    avatarSource = user.avatar;
    wrapper.querySelector(":scope > img.dps-avatar-img")?.remove();
    avatarLetterNode?.remove();
    wrapper.style.background = "";
    const letter = createElement("span", {}, avatarInitial(user));
    avatarLetterNode = letter;
    wrapper.insertBefore(letter, wrapper.firstChild);

    if (isRenderableAvatar(user.avatar)) {
      const resolved = resolveServerUrl(user.avatar);
      const name = resolveDisplayName(user);
      void fetchImageAsObjectUrl(resolved).then(async (objectUrl) => {
        const current = (): boolean => wrapper.isConnected && gen === avatarGen;
        if (objectUrl === null || !current()) return;
        const img = createElement("img", { alt: name, class: "dps-avatar-img" });
        recoverEvictedImage(img, { url: resolved });
        if (!(await setAvatarSource(img, objectUrl, () => "always", current))) return;
        letter.remove();
        wrapper.style.background = "transparent";
        wrapper.insertBefore(img, wrapper.firstChild);
      });
    }
  }

  /** Put the strip in front of the avatar when the member has a banner, or take
   *  it away when they no longer do. `content` holds the avatar as a child. */
  function paintBannerStrip(content: HTMLElement): void {
    bannerKey = bannerKeyOf(user);
    const has = bannerKey !== "|";
    if (!has) {
      bannerNode?.remove();
      bannerNode = null;
      return;
    }
    if (bannerNode === null) {
      bannerNode = createElement("div", { class: "dps-banner", "data-testid": "dps-banner" });
      content.insertBefore(bannerNode, content.firstChild);
    }
    paintBanner(bannerNode, user, content, bannerImages);
  }

  function buildAvatar(): HTMLDivElement {
    const wrapper = createElement("div", {
      class: "dps-avatar",
      "data-testid": "dps-avatar",
    });
    avatarWrapperNode = wrapper;
    paintAvatarFace(wrapper);

    // Status dot overlay
    const statusDot = createElement("div", { class: "dps-status-dot" });
    statusDot.style.background = STATUS_COLORS[user.status] ?? STATUS_COLORS.offline;
    statusDot.title = statusLabel(user.status);
    statusDotNode = statusDot;
    wrapper.appendChild(statusDot);

    return wrapper;
  }

  /** The scrollable body for the current `user`. Its listeners die with `contentOwner`. */
  function buildContent(): HTMLDivElement {
    contentOwner?.destroy();
    contentOwner = new Disposable();
    const contentSignal = contentOwner.signal;
    const content = createElement("div", { class: "dps-content" });

    // Banner strip, only for a member who has one; the avatar overlaps it.
    bannerNode = null;
    content.appendChild(buildAvatar());
    paintBannerStrip(content);

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

    const activityLine = createElement("div", {
      class: "dps-activity",
      "data-testid": "dps-activity",
    });
    activityNode = activityLine;
    paintActivity();

    const listeningLine = createElement("div", {
      class: "dps-listening",
      "data-testid": "dps-listening",
    });
    listeningNode = listeningLine;
    paintListening();

    appendChildren(content, nameEl, statusLine, activityLine, listeningLine);

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

    // Note section (private; on the server when it keeps notes, else localStorage)
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
      maxlength: String(NOTE_MAX_LENGTH),
    });
    const binding = createNoteBinding(
      options.notes ?? { api: null, host, sessionSignal: signal },
      user.id,
    );
    // Flush an edit still waiting on its debounce when the body goes away: the
    // panel closing, or a switch to another DM.
    contentSignal.addEventListener("abort", () => binding.destroy(), { once: true });
    let noteDirty = false;
    if (binding.remote) {
      void binding.load(contentSignal).then(
        (text) => {
          if (!noteDirty && !contentSignal.aborted) noteInput.value = text;
        },
        () => undefined,
      );
    } else {
      noteInput.value = binding.readLocal();
    }
    const noteError = createElement("div", {
      class: "dps-note-error",
      role: "status",
      "data-testid": "dps-note-error",
    });
    binding.onFailedChange((failed) => {
      setText(noteError, failed ? requestsText("profile.noteNotSaved") : "");
    });

    noteInput.addEventListener(
      "input",
      () => {
        noteDirty = true;
        binding.change(noteInput.value);
      },
      { signal: contentSignal },
    );
    noteInput.addEventListener("blur", () => binding.flush(), { signal: contentSignal });

    appendChildren(content, noteTitle, noteInput, noteError);

    // Block / Unblock. The label follows blocksStore, so it flips when the
    // owner's request lands and stays put when it fails.
    if (options.onToggleBlock !== undefined) {
      const onToggleBlock = options.onToggleBlock;
      const blockBtn = createElement("button", {
        class: "dps-block-btn",
        type: "button",
        "data-testid": "dps-block-btn",
      });
      const paint = (): void => {
        setText(
          blockBtn,
          shellText(
            blocksStore.getState().blockedByMe.has(user.id) ? "member.unblock" : "member.block",
          ),
        );
      };
      paint();
      blockBtn.addEventListener(
        "click",
        () => onToggleBlock(user.id, !blocksStore.getState().blockedByMe.has(user.id)),
        { signal: contentSignal },
      );
      const unsub = blocksStore.subscribe(paint);
      contentSignal.addEventListener("abort", unsub, { once: true });
      content.append(makeDivider(), blockBtn);
    }

    return content;
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

    contentNode = buildContent();
    panel.appendChild(contentNode);
    container.appendChild(panel);

    // Trigger slide-in animation
    requestAnimationFrame(() => {
      if (panel !== null) {
        panel.style.marginRight = "0";
      }
    });

    // Focus panel for a11y, when the user asked for it
    if (options.focus !== false) panel.focus();

    // Close on Escape, only for a key meant for the panel. A dialog on top, or
    // a field that already used the key (preventDefault), owns it; and with
    // focus outside the panel (the composer, say) Escape is not this panel's.
    // What was open is read in the capture phase, before any listener closes
    // it, so the decision does not depend on listener order.
    let escapeTaken = false;
    window.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape") escapeTaken = dialogOpen();
      },
      { capture: true, signal },
    );
    // The bubble listener sits on `document`, ahead of the window-level global
    // Escape (mark channel read), which skips a key already handled here.
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key !== "Escape" || !open) return;
        if (escapeTaken || e.defaultPrevented) return;
        if (panel === null || !panel.contains(document.activeElement)) return;
        e.preventDefault();
        onClose();
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
    avatarWrapperNode = null;
    contentNode = null;
    contentOwner?.destroy();
    contentOwner = null;
    avatarGen++;
    bannerNode = null;
    statusDotNode = null;
    statusDotInlineNode = null;
    statusTextNode = null;
    activityNode = null;
    stopListening?.();
    stopListening = null;
    listeningNode = null;
  }

  function update(nextUser: DmProfileData): void {
    const identityChanged = nextUser.id !== user.id;
    user = nextUser;
    // Not mounted (or already torn down) -- nothing to repaint. mount() will
    // paint the fresh `user` from scratch if it is called afterwards.
    if (panel === null) return;

    // A different person (a DM-to-DM switch): swap the body -- avatar, about,
    // join date, this person's note, Block -- but keep the panel element, so
    // it does not slide in again and an outside focus is left alone.
    if (identityChanged && contentNode !== null) {
      const hadFocus = contentNode.contains(document.activeElement);
      const next = buildContent();
      contentNode.replaceWith(next);
      contentNode = next;
      if (hadFocus) panel.focus();
      return;
    }

    if (nameNode !== null) setText(nameNode, resolveDisplayName(user));
    if (contentNode !== null && bannerKeyOf(user) !== bannerKey) paintBannerStrip(contentNode);

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
    paintActivity();
    paintListening();

    // A changed avatar swaps the face (letter or picture); an unchanged one
    // only refreshes the fallback letter, if it is still showing, since the
    // name it comes from may have changed.
    if (avatarWrapperNode !== null && user.avatar !== avatarSource) {
      paintAvatarFace(avatarWrapperNode);
    } else if (avatarLetterNode !== null && avatarLetterNode.isConnected) {
      setText(avatarLetterNode, avatarInitial(user));
    }
  }

  return { mount, destroy, isOpen, update };
}

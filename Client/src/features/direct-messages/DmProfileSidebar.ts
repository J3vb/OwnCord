/**
 * DmProfileSidebar -- right-side panel showing the DM partner's profile.
 * Appears when clicking the DM header ("@ username" area).
 * 340px wide, slides in from the right with a 170ms animation.
 *
 * Content: 80px avatar, name, @username (when a nickname stands in for it),
 * custom status, status dot + label, about section, "Member Since" date, an
 * editable private Note field (kept on the server with the `user_notes`
 * capability, else in localStorage), Report and Block.
 *
 * A11y: role="complementary", aria-label="User profile", Esc to close,
 * focus first focusable on open.
 */

import type {
  DmProfileData,
  DmProfileSidebarComponent,
  DmProfileSidebarOptions,
} from "./dmProfileTypes";
import { appendActionButtons, appendNoteSection, makeDivider } from "./dmProfileSections";
import { isImeCommit } from "@lib/text/ime";
import { Disposable } from "@lib/disposable";
import { dialogOpen } from "@lib/ui/dialogOpen";
import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { avatarInitial, resolveDisplayName } from "@lib/ui/avatar";
import { isRenderableAvatar, setAvatarSource } from "../profiles/avatar";
import {
  fetchImageAsObjectUrl,
  recoverEvictedImage,
  resolveServerUrl,
} from "../messaging/content/attachments";
import { paintBanner } from "../profiles/banner";
import { bannerImages } from "../profiles/bannerImages";
import {
  applyStatusIndicator,
  applyStatusLine,
  statusIndicatorLabel,
} from "@lib/ui/statusIndicator";
import { requestsText } from "../../i18n/requests";
import { playingForLine } from "../members/gameActivityLine";
import { mountListeningCard } from "../members/listeningCard";

export type { DmProfileData, DmProfileSidebarComponent, DmProfileSidebarOptions };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIDEBAR_WIDTH = 340;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** What the strip is painted from; "|" means no banner at all. */
const bannerKeyOf = (u: DmProfileData): string => `${u.banner ?? ""}|${u.banner_color ?? ""}`;

// ---------------------------------------------------------------------------
// Component factory
// ---------------------------------------------------------------------------

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
  let handleNode: HTMLDivElement | null = null;
  let customStatusNode: HTMLDivElement | null = null;
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

  /** The @username line shows only while a nickname stands in for it, since
   *  mentions still resolve by username. Empty lines are hidden by CSS. */
  function paintIdentityLines(): void {
    if (handleNode !== null) {
      const name = resolveDisplayName(user);
      setText(handleNode, name !== user.username ? `@${user.username}` : "");
    }
    if (customStatusNode !== null) setText(customStatusNode, user.customStatus ?? "");
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
    applyStatusIndicator(statusDot, user.status, user.mobile === true);
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
    handleNode = createElement("div", { class: "dps-handle", "data-testid": "dps-handle" });
    customStatusNode = createElement("div", {
      class: "dps-custom-status",
      "data-testid": "dps-custom-status",
    });
    paintIdentityLines();

    // Status line
    const statusLine = createElement("div", {
      class: "dps-status",
      "data-testid": "dps-status",
    });

    const statusDotInline = createElement("span", { class: "dps-status-dot-inline" });
    statusDotInlineNode = statusDotInline;

    const statusText = createElement(
      "span",
      {},
      applyStatusLine(statusDotInline, user.status, user.mobile === true),
    );
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

    appendChildren(
      content,
      nameEl,
      handleNode,
      customStatusNode,
      statusLine,
      activityLine,
      listeningLine,
    );

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

    appendNoteSection(content, {
      userId: user.id,
      host,
      notes: options.notes,
      signal,
      contentSignal,
    });

    appendActionButtons(content, user.id, options, contentSignal);

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
        if (e.key === "Escape" && !isImeCommit(e)) escapeTaken = dialogOpen();
      },
      { capture: true, signal },
    );
    // The bubble listener sits on `document`, ahead of the window-level global
    // Escape (mark channel read), which skips a key already handled here.
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key !== "Escape" || isImeCommit(e) || !open) return;
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
    handleNode = null;
    customStatusNode = null;
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
    paintIdentityLines();
    if (contentNode !== null && bannerKeyOf(user) !== bannerKey) paintBannerStrip(contentNode);

    const mobile = user.mobile === true;
    if (statusDotNode !== null) applyStatusIndicator(statusDotNode, user.status, mobile);
    const label =
      statusDotInlineNode !== null
        ? applyStatusLine(statusDotInlineNode, user.status, mobile)
        : statusIndicatorLabel(user.status, mobile);
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

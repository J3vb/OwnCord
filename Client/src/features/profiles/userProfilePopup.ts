/**
 * UserProfilePopup — anchored popover that appears when clicking a username
 * in the chat or member list. Shows avatar, username, role badge, status dot,
 * about section, join date, and Message/Call action buttons.
 *
 * Position: anchored to the click point, flipped to the other side and clamped
 * against the measured card height so it always lands fully on screen.
 * Animation: fade+scale, defined in CSS so reduced-motion can drop it.
 * Close: outside click or Escape.
 * A11y: role="dialog", aria-label, focus trap, return focus on close.
 */

import { isImeCommit } from "@lib/text/ime";
import { Disposable } from "@lib/disposable";
import { trapFocus } from "@lib/ui/a11y";
import { openBottomSheet, type BottomSheet } from "@lib/ui/bottomSheet";
import { createElement, appendChildren } from "@lib/dom";
import { resolveDisplayName } from "@lib/ui/avatar";
import { requestsText } from "../../i18n/requests";
import { paintBanner } from "./banner";
import { bannerImages } from "./bannerImages";
import { buildActions, arrangeBody, type CardParts } from "./userProfileActions";
import {
  POPUP_WIDTH,
  buildAboutSection,
  buildAvatar,
  buildIdentityLines,
  buildJoinSection,
  buildStatusLine,
  position,
  type IdentityLines,
} from "./userProfileLayout";
import { buildNoteSection } from "./userNoteSection";
import { createRoleArea, type RoleArea } from "./userProfileRoles";
import type { UserProfilePopupComponent, UserProfilePopupOptions } from "./userProfileTypes";

export type {
  UserProfileData,
  ProfileRoleState,
  ProfileRoleControl,
  ProfileRoleChip,
  ProfileRolesState,
  ProfileRolesControl,
  UserProfilePopupOptions,
  UserProfilePopupComponent,
} from "./userProfileTypes";

/** The overlay that catches outside presses and the dialog card inside it. */
function buildShell(asSheet: boolean): { host: HTMLDivElement; card: HTMLDivElement } {
  const host = createElement("div", {
    class: asSheet ? "upp-sheet-host" : "upp-overlay",
    "data-testid": "user-profile-overlay",
  });
  const card = createElement("div", {
    class: "upp-popup",
    role: "dialog",
    "aria-label": requestsText("profile.label"),
    "aria-modal": "true",
    tabindex: "-1",
    "data-testid": "user-profile-popup",
  });
  if (!asSheet) card.style.width = `${POPUP_WIDTH}px`;
  return { host, card };
}

// ---------------------------------------------------------------------------
// Component factory
// ---------------------------------------------------------------------------

export function createUserProfilePopup(
  options: UserProfilePopupOptions,
): UserProfilePopupComponent {
  const disposable = new Disposable();
  const { signal } = disposable;

  let overlay: HTMLDivElement | null = null;
  let popup: HTMLDivElement | null = null;
  let previousFocus: Element | null = null;
  let sheet: BottomSheet | null = null;
  const asSheet = options.sheet === true;

  /** Keep the card on screen after its height changed. A sheet places itself. */
  function place(el: HTMLElement): void {
    if (!asSheet && el.isConnected) position(el, options.anchorX, options.anchorY);
  }

  function isOpen(): boolean {
    return popup !== null && overlay !== null;
  }

  function close(): void {
    if (overlay === null) return;
    overlay.remove();
    overlay = null;
    popup = null;
    const closingSheet = sheet;
    sheet = null;
    closingSheet?.close();
    disposable.destroy();
    options.onNoteFlush?.();

    // Return focus to the element that was focused before opening
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      previousFocus.focus();
    } else {
      options.fallbackFocus?.()?.focus();
    }
    options.onClose?.();
  }

  /** Everything under the name that is built once from the member's data. */
  function buildParts(
    banner: HTMLElement,
    displayName: string,
    identity: IdentityLines,
    roleArea: RoleArea,
  ): CardParts {
    const user = options.user;
    const statusLine = buildStatusLine(user);
    const aboutSection = buildAboutSection(user);
    const noteSection = buildNoteSection(options.note, {
      signal,
      onLayoutChange: () => {
        if (popup !== null) place(popup);
      },
    });
    const joinSection = buildJoinSection(user);
    const divider = createElement("div", { class: "upp-divider" });
    const actions = buildActions({ options, user, signal, close });
    return {
      ...identity,
      body: createElement("div", { class: "upp-body" }),
      banner,
      roleHolder: roleArea.holder,
      statusLine,
      aboutSection,
      noteSection,
      joinSection,
      divider,
      actions,
    };
  }

  /** Show the card in a bottom sheet, or in the container beside the anchor. */
  function present(container: Element, host: HTMLDivElement, card: HTMLDivElement): void {
    host.appendChild(card);
    if (asSheet) {
      // The sheet is the dialog; the card inside is its content.
      card.removeAttribute("role");
      card.removeAttribute("aria-modal");
      sheet = openBottomSheet({
        label: requestsText("profile.label"),
        content: host,
        className: "profile-sheet",
        testId: "profile-sheet",
        focusFirst: false,
        onClosed: () => {
          sheet = null;
          close();
        },
      });
      return;
    }
    container.appendChild(host);
    // Measure, then place: the card has to be in the document before it has a
    // height to clamp against.
    position(card, options.anchorX, options.anchorY);
  }

  /** Outside press, Escape and the focus trap close or contain the card. */
  function bindDismissal(host: HTMLDivElement, card: HTMLDivElement, roleArea: RoleArea): void {
    // Close on outside click (click on overlay but not on popup)
    host.addEventListener(
      "mousedown",
      (e: MouseEvent) => {
        if (popup !== null && !popup.contains(e.target as Node)) {
          close();
        }
      },
      { signal },
    );

    // A press elsewhere in the card closes an open role list.
    card.addEventListener(
      "mousedown",
      (e: MouseEvent) => roleArea.closeMenuOnOutsidePress(e.target as Node),
      { signal },
    );

    // Close on Escape
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && !isImeCommit(e) && isOpen()) {
          close();
        }
      },
      { signal },
    );

    // Focus trap: keep focus inside popup
    trapFocus(card, signal);
  }

  function mount(container: Element): void {
    previousFocus = document.activeElement;
    const user = options.user;
    const displayName = user.isDeleted === true ? "[deleted]" : resolveDisplayName(user);

    // Overlay for outside-click detection, and the popup container
    const { host, card } = buildShell(asSheet);
    overlay = host;
    popup = card;

    // --- Content ---
    const avatar = buildAvatar(user);
    const identity = buildIdentityLines(user, displayName, disposable);

    // Role badge, or the role picker for a viewer who may change it.
    const roleArea = createRoleArea({
      user,
      displayName,
      control: options.roleControl,
      rolesControl: options.rolesControl,
      signal,
      getPopup: () => popup,
      isOpen,
      place,
    });

    // Assemble the card: a banner strip and a body, with the avatar straddling
    // the seam between them the way Discord's popout does.
    const banner = createElement("div", { class: "upp-banner" });
    const parts = buildParts(banner, displayName, identity, roleArea);
    arrangeBody(parts, asSheet);
    // The avatar hangs off the body's top edge, so it is a child of the card
    // rather than the body — the body scrolls, and a scroll container clips.
    // Appending it last puts it over the banner without needing a z-index.
    appendChildren(card, banner, parts.body, avatar);
    paintBanner(banner, user, card, bannerImages);

    roleArea.render();
    present(container, host, card);

    // The fade+scale itself lives in CSS so `prefers-reduced-motion` can drop it.
    requestAnimationFrame(() => {
      if (popup !== null) {
        popup.classList.add("open");
      }
    });

    const live = options.rolesControl ?? options.roleControl;
    if (live !== undefined) {
      disposable.addCleanup(live.subscribe(() => roleArea.render()));
    }

    // Focus the popup for a11y
    card.focus();
    bindDismissal(host, card, roleArea);
  }

  function destroy(): void {
    close();
  }

  return { mount, destroy, isOpen };
}

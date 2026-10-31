/**
 * Swipes on a phone, touch only:
 *
 * - swipe right on the chat opens the channel drawer, swipe left opens the
 *   member list;
 * - swipe the open drawer left, or the open member list right, to close it;
 * - swipe a message left to reply: the message follows the finger up to a
 *   short distance, a reply icon appears, and letting go past the threshold
 *   starts the reply exactly as the Reply button does.
 *
 * The recognizer and its exclusions (text fields, sideways scrollers, the
 * image viewer, sheets, text selection) are in `lib/ui/swipe.ts`. Whether the
 * phone layout applies is asked at every touch, so turning the device
 * re-decides it without a reinstall. No vibration here.
 */

import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { watchSwipes } from "@lib/ui/swipe";

/** How far a swipe must go before letting go opens or closes a panel. */
export const PANEL_SWIPE_PX = 60;
/** How far a message follows the finger. */
export const REPLY_FOLLOW_MAX_PX = 64;
/** Past this the reply icon is armed and letting go starts the reply. */
export const REPLY_THRESHOLD_PX = 56;

const REPLY_BUTTON = '[data-testid^="msg-reply-"]';

export interface PhoneGesturesOptions {
  readonly signal: AbortSignal;
  /** The chat column: a swipe on it opens a panel or replies. */
  readonly chatArea: HTMLElement;
  /** The drawer's own elements (sidebar and rail slot): a left swipe closes. */
  readonly drawerSurfaces: readonly HTMLElement[];
  /** The member column: a right swipe closes the overlay. */
  readonly memberColumn: HTMLElement;
  /** The drawer, once its code has loaded. */
  readonly drawer: () => { open(): void; close(): void; isOpen(): boolean } | null;
  /** The member column, once its code has loaded. */
  readonly members: () => {
    openOverlay(): boolean;
    closeOverlay(): void;
    isOverlayOpen(): boolean;
  } | null;
}

type ChatMode = "pending" | "drawer" | "members" | "reply";

interface ChatSwipe {
  mode: ChatMode;
  readonly row: HTMLElement | null;
  readonly replyButton: HTMLElement | null;
  icon: HTMLElement | null;
}

function replyIcon(row: HTMLElement): HTMLElement | null {
  const region = row.closest<HTMLElement>(".messages-region");
  if (region === null) return null;
  const rowBox = row.getBoundingClientRect();
  const regionBox = region.getBoundingClientRect();
  const icon = createElement("span", {
    class: "msg-swipe-reply",
    "aria-hidden": "true",
    "data-testid": "msg-swipe-reply",
  });
  icon.appendChild(createIcon("reply", 20));
  // Pinned to the frame, not the scroller, so it does not stretch the list
  // sideways; the row slides off the space it sits in.
  icon.style.top = `${rowBox.top - regionBox.top + rowBox.height / 2}px`;
  region.appendChild(icon);
  return icon;
}

function follow(swipe: ChatSwipe, dx: number): void {
  const shift = Math.max(dx, -REPLY_FOLLOW_MAX_PX);
  const progress = Math.min(1, Math.abs(dx) / REPLY_THRESHOLD_PX);
  if (swipe.row !== null) swipe.row.style.transform = `translateX(${shift}px)`;
  if (swipe.icon !== null) {
    swipe.icon.style.opacity = String(progress);
    swipe.icon.style.setProperty("--swipe-progress", String(progress));
    swipe.icon.classList.toggle("armed", Math.abs(dx) >= REPLY_THRESHOLD_PX);
  }
}

function release(swipe: ChatSwipe): void {
  swipe.icon?.remove();
  swipe.icon = null;
  const row = swipe.row;
  if (row === null) return;
  row.classList.remove("msg-swiping");
  // Eased back by the row's own transition (messages.css).
  row.style.removeProperty("transform");
}

export function installPhoneGestures(opts: PhoneGesturesOptions): void {
  const { signal } = opts;

  watchSwipes<ChatSwipe>(opts.chatArea, signal, {
    begin(target) {
      // A panel in the way owns the touch: the drawer's backdrop covers the
      // chat, and the member list sits on it.
      if (!isPhoneLayout() || opts.drawer()?.isOpen() === true) return null;
      if (opts.members()?.isOverlayOpen() === true) return null;
      const row = target.closest<HTMLElement>(".message");
      const replyButton = row?.querySelector<HTMLElement>(REPLY_BUTTON) ?? null;
      return { mode: "pending", row: replyButton === null ? null : row, replyButton, icon: null };
    },
    start(swipe, dx) {
      if (dx > 0) {
        swipe.mode = "drawer";
      } else if (swipe.replyButton !== null && swipe.row !== null) {
        swipe.mode = "reply";
        swipe.row.classList.add("msg-swiping");
        swipe.icon = replyIcon(swipe.row);
      } else {
        swipe.mode = "members";
      }
      return true;
    },
    move(swipe, dx) {
      if (swipe.mode === "reply") follow(swipe, dx);
    },
    end(swipe, dx, released) {
      if (swipe.mode === "reply") {
        const commit = released && dx <= -REPLY_THRESHOLD_PX && swipe.row?.isConnected === true;
        release(swipe);
        if (commit) swipe.replyButton?.click();
        return;
      }
      if (!released || !isPhoneLayout()) return;
      if (swipe.mode === "drawer" && dx >= PANEL_SWIPE_PX) opts.drawer()?.open();
      else if (swipe.mode === "members" && dx <= -PANEL_SWIPE_PX) opts.members()?.openOverlay();
    },
  });

  for (const surface of opts.drawerSurfaces) {
    watchSwipes<object>(surface, signal, {
      begin() {
        return isPhoneLayout() && opts.drawer()?.isOpen() === true ? {} : null;
      },
      // Only leftward: the drawer has nowhere further to go the other way.
      start: (_ctx, dx) => dx < 0,
      end(_ctx, dx, released) {
        if (released && dx <= -PANEL_SWIPE_PX) opts.drawer()?.close();
      },
    });
  }

  watchSwipes<object>(opts.memberColumn, signal, {
    begin() {
      return isPhoneLayout() && opts.members()?.isOverlayOpen() === true ? {} : null;
    },
    start: (_ctx, dx) => dx > 0,
    end(_ctx, dx, released) {
      if (released && dx >= PANEL_SWIPE_PX) opts.members()?.closeOverlay();
    },
  });
}

/**
 * The phone bottom sheet: one panel that slides up from the bottom edge over
 * a dimmed backdrop. The message actions, the emoji/GIF/sticker picker and the
 * profile card open in it on a phone; on a desktop they keep their popups.
 *
 * One sheet at a time: opening a second closes the first and inherits its
 * focus return, so a sheet that hands over to another (Add Reaction) sends
 * focus back to what opened the first. A sheet closes on a backdrop tap, a
 * swipe down from its handle, Escape, the Back button (it claims Back through
 * backHistory, which keeps one history entry for a whole chain of sheets), its
 * owner's signal, or a session reset.
 */

import { Disposable } from "../disposable";
import { createElement } from "../dom";
import { isImeCommit } from "../text/ime";
import { registerSessionReset } from "../net/sessionRegistry";
import { applyDialogSemantics, focusDialog, trapFocus } from "./a11y";
import { claimBack } from "./backHistory";
import { closeOnBackdropClick } from "./modalFactory";

/**
 * The phone layout's gate: a touch screen that is narrow (a phone upright) or
 * short (a phone on its side, which is wider than a tablet in portrait but
 * has no room to spare). The CSS phone media queries repeat this text and
 * `tests/unit/phone-query-css.test.ts` fails when one of them differs, so
 * change both together.
 */
export const PHONE_LAYOUT_QUERY =
  "(pointer: coarse) and (max-width: 899px), (pointer: coarse) and (max-height: 499px)";

export function isPhoneLayout(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(PHONE_LAYOUT_QUERY).matches;
}

/**
 * Run `handler` when a resize or a rotation moves the window onto or off the
 * phone layout. It listens to `resize` (rotation fires one) and compares
 * `isPhoneLayout()` itself, so it needs nothing from the media query object.
 * The listener goes with `signal`.
 */
export function onPhoneLayoutChange(handler: (phone: boolean) => void, signal: AbortSignal): void {
  let last = isPhoneLayout();
  window.addEventListener(
    "resize",
    () => {
      const now = isPhoneLayout();
      if (now === last) return;
      last = now;
      handler(now);
    },
    { signal },
  );
}

/** How far down a swipe must travel before the lift closes the sheet. */
const SWIPE_CLOSE_PX = 80;

export interface BottomSheetOptions {
  readonly label: string;
  readonly content: HTMLElement;
  /** Extra class on the panel, for the sheet's own layout. */
  readonly className?: string;
  readonly testId?: string;
  /** "tall" holds a fixed share of the screen (the picker); "auto" fits its content. */
  readonly size?: "auto" | "tall";
  /** The owner's lifetime: an abort closes the sheet. */
  readonly signal?: AbortSignal;
  /** Where focus goes on close when the opener has left the document. */
  readonly fallbackFocus?: () => HTMLElement | null;
  /** False leaves focus where the content puts it (a picker focuses its own search). */
  readonly focusFirst?: boolean;
  /** Runs once, however the sheet closed. */
  readonly onClosed?: () => void;
}

export interface BottomSheet {
  readonly panel: HTMLElement;
  readonly signal: AbortSignal;
  close(): void;
}

interface OpenSheet {
  readonly owner: Disposable;
  restoreFocus: (() => void) | null;
  /** Set when the next sheet takes over: no focus return, no history step. */
  handedOver: boolean;
}

let current: OpenSheet | null = null;

/** Called once by the next sheet that opens; see `watchNextBottomSheet`. */
let nextSheetWatcher: (() => void) | null = null;

/**
 * Run `fn` once when the next sheet opens (the touch input uses it to tell a
 * long-press that opened a sheet from one that opened nothing, or a menu).
 * Only the latest watcher is kept, and it is dropped when `signal` aborts.
 */
export function watchNextBottomSheet(fn: () => void, signal: AbortSignal): void {
  if (signal.aborted) return;
  const watcher = (): void => {
    nextSheetWatcher = null;
    fn();
  };
  nextSheetWatcher = watcher;
  signal.addEventListener(
    "abort",
    () => {
      if (nextSheetWatcher === watcher) nextSheetWatcher = null;
    },
    { once: true },
  );
}

// Module lifetime: a sheet from the old server never outlives a switch.
void registerSessionReset("bottomSheet:open", () => {
  nextSheetWatcher = null;
  closeBottomSheet();
});

/** Whether a sheet is open (the swipes stay out of the way while one is). */
export function isBottomSheetOpen(): boolean {
  return current !== null;
}

/** Close the open sheet, if any. */
export function closeBottomSheet(): void {
  current?.owner.destroy();
}

export function openBottomSheet(options: BottomSheetOptions): BottomSheet {
  if (options.signal?.aborted === true) {
    // An owner already gone opens nothing and calls nothing back.
    const dead = new Disposable();
    dead.destroy();
    return { panel: options.content, signal: dead.signal, close: () => undefined };
  }
  const previous = current;
  const owner = new Disposable();
  const signal = owner.signal;
  // Claimed before the previous sheet lets go, so a hand-over keeps the one
  // history entry the chain already has.
  claimBack(() => owner.destroy(), signal);
  let inherited: (() => void) | null = null;
  if (previous !== null) {
    inherited = previous.restoreFocus;
    previous.restoreFocus = null;
    previous.handedOver = true;
    previous.owner.destroy();
  }

  const entry: OpenSheet = { owner, restoreFocus: null, handedOver: false };
  current = entry;

  const overlay = createElement("div", { class: "bottom-sheet-overlay" });
  const panel = createElement("div", {
    class: `bottom-sheet${options.size === "tall" ? " bottom-sheet-tall" : ""}${
      options.className !== undefined ? ` ${options.className}` : ""
    }`,
    ...(options.testId !== undefined ? { "data-testid": options.testId } : {}),
  });
  applyDialogSemantics(panel, { label: options.label });
  const handle = createElement("div", {
    class: "bottom-sheet-handle",
    "aria-hidden": "true",
    "data-sheet-drag": "",
  });
  handle.appendChild(createElement("span", { class: "bottom-sheet-grip" }));
  panel.append(handle, options.content);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  owner.addCleanup(() => {
    overlay.remove();
    if (current === entry) current = null;
    if (!entry.handedOver) {
      // Only focus the sheet left behind: an action that moved focus on
      // purpose (a pick that returns to the composer) keeps it.
      const active = document.activeElement;
      if (active === null || active === document.body) entry.restoreFocus?.();
    }
    entry.restoreFocus = null;
    options.onClosed?.();
  });

  const close = (): void => owner.destroy();

  options.signal?.addEventListener("abort", close, { once: true, signal });

  closeOnBackdropClick(overlay, close, signal);
  trapFocus(panel, signal);
  panel.addEventListener(
    "keydown",
    (e) => {
      // Content that handles Escape itself (a picker clearing its search) wins.
      if (e.key !== "Escape" || e.defaultPrevented || isImeCommit(e)) return;
      e.preventDefault();
      close();
    },
    { signal },
  );

  // The handle (and anything the content marks) drags the sheet down.
  let dragStart: number | null = null;
  let dragPointer = -1;
  let dragDy = 0;
  panel.addEventListener(
    "pointerdown",
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target === null || target.closest("[data-sheet-drag]") === null) return;
      if (target.closest("button, a, input, textarea, select") !== null) return;
      dragStart = e.clientY;
      dragPointer = e.pointerId;
      dragDy = 0;
      panel.classList.add("bottom-sheet-dragging");
    },
    { signal },
  );
  const endDrag = (closeIfFar: boolean): void => {
    if (dragStart === null) return;
    dragStart = null;
    panel.classList.remove("bottom-sheet-dragging");
    if (closeIfFar && dragDy >= SWIPE_CLOSE_PX) {
      close();
      return;
    }
    panel.style.removeProperty("transform");
  };
  overlay.addEventListener(
    "pointermove",
    (e) => {
      if (dragStart === null || e.pointerId !== dragPointer) return;
      dragDy = Math.max(0, e.clientY - dragStart);
      panel.style.transform = `translateY(${dragDy}px)`;
    },
    { signal },
  );
  overlay.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerId === dragPointer) endDrag(true);
    },
    { signal },
  );
  overlay.addEventListener(
    "pointercancel",
    (e) => {
      if (e.pointerId === dragPointer) endDrag(false);
    },
    { signal },
  );

  if (inherited !== null) {
    entry.restoreFocus = inherited;
    if (options.focusFirst !== false) focusDialog(panel);
  } else if (options.focusFirst !== false) {
    entry.restoreFocus = focusDialog(panel, options.fallbackFocus);
  } else {
    const opener = document.activeElement;
    entry.restoreFocus = () => {
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        opener.closest("[inert]") === null
      ) {
        opener.focus();
        return;
      }
      const target = options.fallbackFocus?.();
      if (target?.isConnected === true) target.focus();
    };
  }

  nextSheetWatcher?.();
  return { panel, signal, close };
}

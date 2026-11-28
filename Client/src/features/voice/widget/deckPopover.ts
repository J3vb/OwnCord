/**
 * The voice widget's anchored popovers under the Command Deck on a desktop:
 * the connection card above the ping button and the share card above the
 * share button. The panel stays where the widget put it in the DOM and is
 * lifted out with `position: fixed` (the `vw-pop` class), placed above its
 * button with a small arrow, kept inside the window, and closed by Esc, a
 * click outside it, or its button again.
 *
 * Classic and the phone layout keep the panel inline: there the controller
 * only toggles its open class, with no outside-click or Esc handling.
 */
import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/text/ime";
import { isPhoneLayout, PHONE_LAYOUT_QUERY } from "@lib/ui/phoneLayout";

/** Space kept between the panel and the window's edges. */
const EDGE = 8;
/** Space between the panel's arrow tip and its button. */
const GAP = 10;
/** The arrow never sits closer than this to the panel's rounded corners. */
const ARROW_INSET = 18;

/** Popovers apply under Deck on a desktop; the phone layout keeps its rows. */
export function isDeckPopoverMode(): boolean {
  return document.documentElement.classList.contains("layout-deck") && !isPhoneLayout();
}

export interface DeckPopoverOptions {
  readonly panel: HTMLElement;
  readonly anchor: HTMLElement;
  /** The class that shows the panel when open ("visible" for the stats pane). */
  readonly openClass: string;
  /** The owner's lifetime: every listener ends with it, and the button's
   *  aria-haspopup and aria-expanded go with it. */
  readonly signal: AbortSignal;
  /** Whether the button also opens the panel inline (the ping button does;
   *  the share button stops the share there), so it reports aria-expanded
   *  in both modes. */
  readonly inlineToggle: boolean;
  /** Told after each open or close. */
  readonly onChange?: (open: boolean) => void;
}

export interface DeckPopover {
  isOpen(): boolean;
  toggle(): void;
  open(): void;
  /** Close; `restoreFocus` puts the focus back on the button (Esc). */
  close(restoreFocus?: boolean): void;
  /** Re-apply the mode (popover or inline) and re-place an open panel. */
  sync(): void;
}

/** Where the panel goes: above the button, centred on it where the window
 *  allows, otherwise pushed in from the nearer edge, with the arrow kept over
 *  the button. */
export function placePopover(
  anchor: DOMRect,
  panelWidth: number,
  viewport: { width: number; height: number },
): { left: number; bottom: number; maxHeight: number; arrow: number } {
  const centre = anchor.left + anchor.width / 2;
  const maxLeft = Math.max(EDGE, viewport.width - panelWidth - EDGE);
  const left = Math.min(Math.max(centre - panelWidth / 2, EDGE), maxLeft);
  const arrow = Math.min(Math.max(centre - left, ARROW_INSET), panelWidth - ARROW_INSET);
  const bottom = viewport.height - anchor.top + GAP;
  const maxHeight = Math.max(0, anchor.top - GAP - EDGE);
  return { left, bottom, maxHeight, arrow };
}

export function createDeckPopover(options: DeckPopoverOptions): DeckPopover {
  const { panel, anchor, openClass, signal } = options;
  /** Owns the listeners of the open panel only; ended on close. */
  let openScope: Disposable | null = null;

  const isOpen = (): boolean => panel.classList.contains(openClass);

  function place(): void {
    if (!panel.classList.contains("vw-pop")) return;
    const spot = placePopover(anchor.getBoundingClientRect(), panel.offsetWidth, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    panel.style.left = `${spot.left}px`;
    panel.style.bottom = `${spot.bottom}px`;
    panel.style.setProperty("--deck-pop-arrow", `${spot.arrow}px`);
    // A window too short for the whole panel: it scrolls inside the room
    // above its button, without the arrow (a scrolling box would clip it).
    const tight = panel.scrollHeight > spot.maxHeight;
    panel.classList.toggle("vw-pop--tight", tight);
    if (tight) panel.style.maxHeight = `${spot.maxHeight}px`;
    else panel.style.removeProperty("max-height");
  }

  function clearPlacement(): void {
    for (const prop of ["left", "bottom", "max-height", "--deck-pop-arrow"]) {
      panel.style.removeProperty(prop);
    }
    panel.classList.remove("vw-pop--tight");
  }

  const inlineRole = panel.getAttribute("role");

  /** As a popover the panel is a dialog its button opens; inline it keeps
   *  its own role. */
  function applyMode(): void {
    const popover = isDeckPopoverMode();
    panel.classList.toggle("vw-pop", popover);
    if (popover) {
      panel.setAttribute("role", "dialog");
      anchor.setAttribute("aria-haspopup", "dialog");
    } else {
      if (inlineRole === null) panel.removeAttribute("role");
      else panel.setAttribute("role", inlineRole);
      anchor.removeAttribute("aria-haspopup");
    }
    if (popover || options.inlineToggle) anchor.setAttribute("aria-expanded", String(isOpen()));
    else anchor.removeAttribute("aria-expanded");
    if (popover && openScope === null && isOpen()) armDismiss();
    if (!popover) {
      openScope?.destroy();
      openScope = null;
      clearPlacement();
    }
  }

  function onPointerDown(e: Event): void {
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (panel.contains(target) || anchor.contains(target)) return;
    close();
  }

  function onKeyDown(e: KeyboardEvent): void {
    // An Escape that ends an IME composition is the input method's.
    if (e.key !== "Escape" || isImeCommit(e)) return;
    e.preventDefault();
    close(true);
  }

  /** Esc and an outside click close the panel; a resize re-places it. */
  function armDismiss(): void {
    openScope = new Disposable();
    const openSignal = openScope.signal;
    document.addEventListener("pointerdown", onPointerDown, {
      signal: openSignal,
      capture: true,
    });
    document.addEventListener("keydown", onKeyDown, { signal: openSignal });
    window.addEventListener("resize", place, { signal: openSignal });
  }

  function open(): void {
    if (signal.aborted || isOpen()) return;
    applyMode();
    panel.classList.add(openClass);
    anchor.setAttribute("aria-expanded", "true");
    if (panel.classList.contains("vw-pop")) {
      armDismiss();
      place();
    }
    options.onChange?.(true);
  }

  function close(restoreFocus = false): void {
    openScope?.destroy();
    openScope = null;
    if (!isOpen()) return;
    panel.classList.remove(openClass);
    anchor.setAttribute("aria-expanded", "false");
    clearPlacement();
    if (restoreFocus) anchor.focus();
    options.onChange?.(false);
  }

  // A phone turned on its side leaves the phone layout, and back.
  const phoneQuery =
    typeof window.matchMedia === "function" ? window.matchMedia(PHONE_LAYOUT_QUERY) : null;
  if (typeof phoneQuery?.addEventListener === "function") {
    phoneQuery.addEventListener("change", applyMode, { signal });
  }
  // The button outlives a share's card: it stops offering a popup with it.
  signal.addEventListener(
    "abort",
    () => {
      openScope?.destroy();
      openScope = null;
      anchor.removeAttribute("aria-haspopup");
      anchor.removeAttribute("aria-expanded");
    },
    { once: true },
  );
  applyMode();

  return {
    isOpen,
    toggle: () => (isOpen() ? close() : open()),
    open,
    close,
    sync() {
      applyMode();
      if (isOpen()) place();
    },
  };
}

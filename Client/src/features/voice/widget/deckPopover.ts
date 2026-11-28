/**
 * The voice widget's anchored popovers under the Command Deck on a desktop:
 * the connection card above the ping button and the share card above the
 * share button. The panel stays where the widget put it in the DOM and is
 * lifted out with `position: fixed` (the `vw-pop` class), placed above its
 * button with a small arrow, kept inside the window, and closed by Esc, a
 * click outside it, or its button again. Only one is open at a time: opening
 * one closes the other.
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
  /** The element whose top the panel sits above (the status bar), so it
   *  covers none of the bar's rows; the button when left out. The arrow stays
   *  over the button. */
  readonly base?: () => Element | null;
  /** Told after each open or close. */
  readonly onChange?: (open: boolean) => void;
}

export interface DeckPopover {
  isOpen(): boolean;
  /** Open or close; opened from the keyboard, the focus moves into it. */
  toggle(viaKeyboard?: boolean): void;
  open(viaKeyboard?: boolean): void;
  /** Close; `restoreFocus` puts the focus back on the button (Esc). */
  close(restoreFocus?: boolean): void;
  /** Re-apply the mode (popover or inline) and re-place an open panel. */
  sync(): void;
}

/** Where the panel goes: above `top` (the top of the status bar, or of the
 *  button itself), centred on the button where the window allows, otherwise
 *  pushed in from the nearer edge, with the arrow kept over the button. */
export function placePopover(
  anchor: DOMRect,
  panelWidth: number,
  viewport: { width: number; height: number },
  top = anchor.top,
): { left: number; bottom: number; maxHeight: number; arrow: number } {
  const centre = anchor.left + anchor.width / 2;
  const maxLeft = Math.max(EDGE, viewport.width - panelWidth - EDGE);
  const left = Math.min(Math.max(centre - panelWidth / 2, EDGE), maxLeft);
  const arrow = Math.min(Math.max(centre - left, ARROW_INSET), panelWidth - ARROW_INSET);
  const bottom = viewport.height - top + GAP;
  const maxHeight = Math.max(0, top - GAP - EDGE);
  return { left, bottom, maxHeight, arrow };
}

/** The open popover, if any: opening another closes it first. */
let openPopover: DeckPopover | null = null;

const shown = (el: HTMLElement): boolean => el.closest("[hidden]") === null;

/** Where the focus goes when the panel opens from the keyboard: the checked
 *  segment of a radio group, else its first shown control, else the panel. */
function focusTarget(panel: HTMLElement): HTMLElement {
  const controls = [
    ...panel.querySelectorAll<HTMLElement>('[role="radio"][aria-checked="true"]'),
    ...panel.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex='0']"),
  ];
  const control = controls.find(shown);
  if (control !== undefined) return control;
  panel.tabIndex = -1;
  return panel;
}

export function createDeckPopover(options: DeckPopoverOptions): DeckPopover {
  const { panel, anchor, openClass, signal } = options;
  /** Owns the listeners of the open panel only; ended on close. */
  let openScope: Disposable | null = null;

  const isOpen = (): boolean => panel.classList.contains(openClass);

  function place(): void {
    if (!panel.classList.contains("vw-pop")) return;
    const base = options.base?.() ?? anchor;
    const spot = placePopover(
      anchor.getBoundingClientRect(),
      panel.offsetWidth,
      { width: window.innerWidth, height: window.innerHeight },
      base.getBoundingClientRect().top,
    );
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
    const lifted = isDeckPopoverMode();
    panel.classList.toggle("vw-pop", lifted);
    if (lifted) {
      panel.setAttribute("role", "dialog");
      anchor.setAttribute("aria-haspopup", "dialog");
    } else {
      if (inlineRole === null) panel.removeAttribute("role");
      else panel.setAttribute("role", inlineRole);
      anchor.removeAttribute("aria-haspopup");
    }
    if (lifted || options.inlineToggle) anchor.setAttribute("aria-expanded", String(isOpen()));
    else anchor.removeAttribute("aria-expanded");
    if (lifted && openScope === null && isOpen()) armDismiss();
    if (!lifted) {
      openScope?.destroy();
      openScope = null;
      if (openPopover === popover) openPopover = null;
      clearPlacement();
    }
  }

  function onPointerDown(e: Event): void {
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (panel.contains(target) || anchor.contains(target)) return;
    close();
  }

  /** Esc closes this panel, unless something else took it first (an IME
   *  composition, a menu inside). The focus goes back to the button only when
   *  it was in the panel or on the button, never away from elsewhere. */
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Escape" || e.defaultPrevented || isImeCommit(e)) return;
    e.preventDefault();
    const active = document.activeElement;
    close(active !== null && (panel.contains(active) || active === anchor));
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

  function open(viaKeyboard = false): void {
    if (signal.aborted || isOpen()) return;
    applyMode();
    const lifted = panel.classList.contains("vw-pop");
    if (lifted && openPopover !== popover) openPopover?.close();
    panel.classList.add(openClass);
    anchor.setAttribute("aria-expanded", "true");
    if (lifted) {
      openPopover = popover;
      armDismiss();
      place();
    }
    options.onChange?.(true);
    if (lifted && viaKeyboard) focusTarget(panel).focus();
  }

  function close(restoreFocus = false): void {
    openScope?.destroy();
    openScope = null;
    if (openPopover === popover) openPopover = null;
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
      if (openPopover === popover) openPopover = null;
      anchor.removeAttribute("aria-haspopup");
      anchor.removeAttribute("aria-expanded");
    },
    { once: true },
  );
  const popover: DeckPopover = {
    isOpen,
    toggle: (viaKeyboard = false) => (isOpen() ? close() : open(viaKeyboard)),
    open,
    close,
    sync() {
      applyMode();
      if (isOpen()) place();
    },
  };
  applyMode();
  return popover;
}

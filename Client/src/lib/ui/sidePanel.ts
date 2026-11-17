/**
 * The channel side panel's behaviour (outside press, Escape, Back on a phone,
 * the header button's pressed state and focus return), shared by every panel
 * the chat header opens, and the group that keeps one open at a time. The
 * frame they render in is sidePanelFrame.ts, loaded with the panels.
 */

import { isImeCommit } from "../text/ime";
import { claimBackOnPhone } from "./bottomSheet";
import { dialogOpen, isDisplayed } from "./dialogOpen";

/** What counts as the panel and its header button, as selectors. */
export interface SidePanelTargets {
  /** The panel's own element under the root. */
  readonly panel: string;
  /** The header button that toggles the panel: its click closes it. */
  readonly toggle: string;
  /** Where focus returns when the toggle is not displayed (a phone folds it
   *  into the header's More button). */
  readonly fallbackFocus?: string;
}

// Layers stacked over the page (a dialog, menu, sheet, toast or image viewer):
// a press there belongs to that layer, not to the page behind the panel.
const FLOATING_LAYERS =
  '.modal-overlay, [aria-modal="true"], [role="dialog"], .context-menu, .bottom-sheet-overlay, .toast-container, .image-lightbox';

/**
 * Close a side panel when a press lands outside it. Listens on pointerdown in
 * the capture phase, so a click that re-renders or removes its target inside
 * the panel still counts as inside, and a handler that stops propagation
 * cannot hide the press.
 */
function closeOnOutsidePress(
  root: ParentNode,
  targets: SidePanelTargets,
  onClose: () => void,
  signal: AbortSignal,
): void {
  document.addEventListener(
    "pointerdown",
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (root.querySelector(targets.panel)?.contains(target) === true) return;
      if (target.closest(targets.toggle) !== null) return;
      if (target.closest(FLOATING_LAYERS) !== null || dialogOpen()) return;
      onClose();
    },
    { capture: true, signal },
  );
}

function toggles(targets: SidePanelTargets): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(targets.toggle));
}

/** Focus the header button, or the fallback when the button is not on screen. */
function returnFocus(targets: SidePanelTargets): void {
  const fallback =
    targets.fallbackFocus === undefined
      ? []
      : Array.from(document.querySelectorAll<HTMLElement>(targets.fallbackFocus));
  const target = [...toggles(targets), ...fallback].find((el) => el.isConnected && isDisplayed(el));
  target?.focus();
}

/**
 * The open panel's behaviour, for as long as `signal` lives: an outside press,
 * Escape from inside it or on its header button, and Back on a phone close it;
 * the header button shows pressed; focus moves into the panel, and when it
 * closes with focus inside, focus goes back to the header button.
 */
export function bindSidePanel(
  root: ParentNode,
  targets: SidePanelTargets,
  onClose: () => void,
  signal: AbortSignal,
): void {
  closeOnOutsidePress(root, targets, onClose, signal);
  claimBackOnPhone(onClose, signal);
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || isImeCommit(e) || dialogOpen()) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const inside = root.querySelector(targets.panel)?.contains(target) === true;
      if (!inside && target.closest(targets.toggle) === null) return;
      // Taken, so the page's own Escape (mark read) does not also run.
      e.preventDefault();
      onClose();
    },
    { signal },
  );
  for (const btn of toggles(targets)) btn.setAttribute("aria-pressed", "true");
  // Like the DM profile panel: the panel itself takes focus (tabindex -1), so
  // a keyboard user starts inside it and the landmark's name is read.
  root.querySelector<HTMLElement>(targets.panel)?.focus();
  signal.addEventListener(
    "abort",
    () => {
      const focused = document.activeElement;
      const hadFocus =
        focused instanceof Element && root.querySelector(targets.panel)?.contains(focused) === true;
      for (const btn of toggles(targets)) btn.setAttribute("aria-pressed", "false");
      if (hadFocus) returnFocus(targets);
    },
    { once: true },
  );
}

/** A panel as the group drives it. */
export interface GroupedSidePanel {
  open(): Promise<void>;
  cleanup(): void;
  isOpen(): boolean;
  /** Still loading for what it was opened for: a second press cancels it. */
  isPending?(): boolean;
}

export interface SidePanelGroup<K extends string> {
  /** Close the panel when it is open or loading, else close the others and open it. */
  toggle(key: K): Promise<void>;
  /** Close the others and open it; a no-op when it is already open. */
  open(key: K): Promise<void>;
  closeAll(): void;
}

/** One side panel at a time: opening one closes (and cancels the load of) the others. */
export function createSidePanelGroup<K extends string>(
  panels: Readonly<Record<K, GroupedSidePanel>>,
): SidePanelGroup<K> {
  const keys = Object.keys(panels) as K[];
  function open(key: K): Promise<void> {
    for (const other of keys) if (other !== key) panels[other].cleanup();
    return panels[key].open();
  }
  return {
    toggle: (key) => {
      const panel = panels[key];
      if (!panel.isOpen() && panel.isPending?.() !== true) return open(key);
      panels[key].cleanup();
      return Promise.resolve();
    },
    open,
    closeAll: () => {
      for (const key of keys) panels[key].cleanup();
    },
  };
}

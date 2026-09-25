/**
 * SidebarDrawer — the narrow-width (<=800px) way into the unified sidebar
 * (WCAG 1.4.10 Reflow; the beta treats accessibility as a release property).
 *
 * Above 800px the sidebar is always in flow and this does nothing. Below it
 * `responsive.css` takes the sidebar out of flow and off-screen, and every
 * entry point that lives only there (channels, DMs, the requests inbox, the
 * Moderation Center, Settings and My reports) becomes unreachable. This turns
 * the sidebar into a drawer the header's menu button opens.
 *
 * Close paths: Escape, a click/tap outside, and reaching a destination. The
 * destination is detected through the stores one writes (the active channel,
 * the open content view, Settings), so it works whatever control was chosen
 * rather than tracking every entry point. Focus moves into the drawer on open
 * and returns to the menu button on close; the button's `aria-expanded` and
 * accessible name track the state for the keyboard model.
 */

import { Disposable } from "@lib/disposable";
import { createElement } from "@lib/dom";
import { focusDialog } from "@lib/a11y";
import { channelsStore } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { shellText } from "../../i18n/shell";

/** The breakpoint `responsive.css` collapses the sidebar at. Keep in step. */
const NARROW_MAX = 800;

export interface SidebarDrawerOptions {
  /** The `.unified-sidebar` element the drawer shows and hides. */
  readonly sidebar: HTMLElement;
  /** The header menu button that opens it. */
  readonly toggle: HTMLButtonElement;
  /** Where to put focus on close if the toggle is gone. */
  readonly fallbackFocus?: () => HTMLElement | null;
}

export interface SidebarDrawer {
  destroy(): void;
}

export function createSidebarDrawer(opts: SidebarDrawerOptions): SidebarDrawer {
  const { sidebar, toggle } = opts;
  const owner = new Disposable();
  let open = false;
  let restoreFocusRef: (() => void) | null = null;

  // The backdrop sits just before the sidebar so it shares the drawer's
  // stacking layer and paints under it, but it is `position: fixed`, so the
  // parent's own layout is irrelevant.
  const backdrop = createElement("div", {
    class: "sidebar-drawer-backdrop",
    "data-testid": "sidebar-drawer-backdrop",
  });
  sidebar.before(backdrop);

  /** True while the media query collapses the sidebar (window <= 800px). */
  function isNarrow(): boolean {
    return window.innerWidth > 0 && window.innerWidth <= NARROW_MAX;
  }

  function sync(): void {
    sidebar.classList.toggle("drawer-open", open);
    backdrop.classList.toggle("open", open);
    // Below the breakpoint the closed sidebar is off-screen, so its controls
    // must not stay tabbable off-screen; above it, the sidebar is in flow and
    // must stay fully interactive.
    sidebar.inert = isNarrow() && !open;
    toggle.setAttribute("aria-expanded", String(open));
    const label = open ? shellText("sidebar.close") : shellText("sidebar.open");
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  }

  // The drawer owns the toggle's state, so seed it (the header builds the
  // button before this controller exists).
  sync();

  function openDrawer(): void {
    if (open) return;
    open = true;
    // sync() clears `inert` first: focus cannot move into an inert subtree.
    sync();
    // Capture the opener now — focusDialog reads document.activeElement.
    restoreFocusRef = focusDialog(sidebar, opts.fallbackFocus);
  }

  type CloseReason = "dismiss" | "destination";

  /**
   * A dismissal (Escape, outside, the toggle) always returns focus to the
   * opener. A chosen destination may have moved focus itself (a content view
   * focuses its title, Settings focuses its panel); the drawer only restores
   * focus when nothing else claimed it, so it neither fights the destination
   * nor lets focus drop to `<body>` as the closed sidebar goes inert.
   */
  function closeDrawer(reason: CloseReason): void {
    if (!open) return;
    open = false;
    const restoreFn = restoreFocusRef;
    restoreFocusRef = null;
    const focusWasInside = sidebar.contains(document.activeElement);
    sync();
    if (reason === "dismiss" || focusWasInside) restoreFn?.();
  }

  toggle.addEventListener("click", () => (open ? closeDrawer("dismiss") : openDrawer()), {
    signal: owner.signal,
  });

  owner.onEvent(document, "keydown", (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !open) return;
    e.preventDefault();
    closeDrawer("dismiss");
  });

  // A press outside the drawer lands on the backdrop, which covers the app. A
  // dialog or menu opened from the drawer paints above both, so a press inside
  // it neither closes the drawer nor pulls focus back to the toggle.
  owner.onEvent(backdrop, "pointerdown", () => closeDrawer("dismiss"));

  // A destination chosen: every sidebar entry ends in one of these stores, so
  // this fires for a channel, a DM, the requests inbox, the Moderation Center
  // and Settings (where My reports lives).
  const destinationChosen = (): void => closeDrawer("destination");
  owner.onStoreChange(channelsStore, (s) => s.activeChannelId, destinationChosen);
  owner.onStoreChange(uiStore, (s) => s.activeView, destinationChosen);
  owner.onStoreChange(uiStore, (s) => s.settingsOpen, destinationChosen);

  // A navigation row re-selected while it is already active changes no store,
  // so its click closes the drawer directly.
  owner.onEvent(sidebar, "click", (e: MouseEvent) => {
    const target = e.target;
    if (target instanceof Element && target.closest("[data-channel-id], [data-testid='dm-entry']"))
      closeDrawer("destination");
  });

  // Crossing the breakpoint changes whether the closed sidebar is off-screen
  // (and so inert), and a drawer left open while the window widens would linger
  // and re-appear on the next shrink.
  owner.onEvent(window, "resize", () => {
    if (window.innerWidth <= NARROW_MAX) {
      // Staying/becoming narrow only changes whether the closed sidebar is
      // inert; the open state is unchanged.
      sync();
      return;
    }
    // Widening puts the sidebar back in flow and hides the toggle. Focus that
    // was inside the drawer stays on the now-visible sidebar, so drop the
    // restore rather than yank it to a hidden button.
    open = false;
    restoreFocusRef = null;
    sync();
  });

  return {
    destroy: () => {
      closeDrawer("dismiss");
      owner.destroy();
      backdrop.remove();
      sidebar.classList.remove("drawer-open");
    },
  };
}

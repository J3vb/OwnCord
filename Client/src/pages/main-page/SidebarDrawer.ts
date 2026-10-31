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
 * On a phone the server rail joins the drawer: it is the same rail the desktop
 * shows (one instance, mounted once by MainPage), and this controller only
 * shows its slot in the drawer's layer while the drawer is open. A search
 * button under the server name opens the quick switcher.
 *
 * Back: a drawer opened with the menu button (or a swipe) claims the Back
 * button, so Back closes it. In the Android app a guard keeps one history
 * entry while the drawer is closed, so Back from a chat opens the drawer, and
 * a drawer opened that way holds no entry: one more Back leaves the app. The
 * guard goes back up when the drawer closes.
 *
 * Close paths: Escape, a click/tap outside, and reaching a destination. The
 * destination is detected through the stores one writes (the active channel,
 * the open content view, Settings), so it works whatever control was chosen
 * rather than tracking every entry point. Focus moves into the drawer on open
 * and returns to the menu button on close; the button's `aria-expanded` and
 * accessible name track the state for the keyboard model.
 */

import { isImeCommit } from "@lib/text/ime";
import { Disposable } from "@lib/disposable";
import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { focusDialog } from "@lib/ui/a11y";
import { claimBack, holdBackGuard, type BackClaim, type BackGuard } from "@lib/ui/backHistory";
import { isPhoneLayout, onPhoneLayoutChange } from "@lib/ui/bottomSheet";
import { channelsStore } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { isAndroidApp } from "../../features/voice/native/platform";
import { shellText } from "../../i18n/shell";

/**
 * The width `responsive.css` collapses the sidebar under. A phone on its side
 * is wider than this but collapses it too (the phone layout's own media
 * query), so the drawer asks `isPhoneLayout()` as well. Keep in step.
 */
const NARROW_QUERY = "(max-width: 800px)";

export interface SidebarDrawerOptions {
  /** The `.unified-sidebar` element the drawer shows and hides. */
  readonly sidebar: HTMLElement;
  /** The header menu button that opens it. */
  readonly toggle: HTMLButtonElement;
  /** Where to put focus on close if the toggle is gone. */
  readonly fallbackFocus?: () => HTMLElement | null;
  /** Called on open, to close a panel that would otherwise paint over it. */
  readonly onOpen?: () => void;
  /** The server rail's slot, shown beside the channel list while a phone's drawer is open. */
  readonly rail?: HTMLElement | null;
  /** Opens the quick switcher; with it the drawer gets a search button on a phone. */
  readonly onSearch?: () => void;
}

export interface SidebarDrawer {
  /** Open as the menu button does. */
  open(): void;
  /** Close as a tap outside does. */
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

export function createSidebarDrawer(opts: SidebarDrawerOptions): SidebarDrawer {
  const { sidebar, toggle } = opts;
  const rail = opts.rail ?? null;
  const owner = new Disposable();
  const narrow = window.matchMedia(NARROW_QUERY);
  /** Whether the sidebar is collapsed into the drawer right now. */
  const collapsed = (): boolean => narrow.matches || isPhoneLayout();
  let open = false;
  let restoreFocusRef: (() => void) | null = null;
  let backClaim: BackClaim | null = null;
  // Only the Android app has a Back button to catch (a phone browser has its
  // own, and leaving the page is what it should do).
  const backGuard: BackGuard | null = isAndroidApp()
    ? holdBackGuard(() => openDrawer(false), owner.signal)
    : null;

  // The backdrop sits just before the sidebar (and the rail beside it) so it
  // shares the drawer's stacking layer and paints under both, but it is
  // `position: fixed`, so the parent's own layout is irrelevant.
  const backdrop = createElement("div", {
    class: "sidebar-drawer-backdrop",
    "data-testid": "sidebar-drawer-backdrop",
  });
  (rail ?? sidebar).before(backdrop);

  // The search button sits under the server name and only shows on a phone
  // (responsive.css); the quick switcher it opens is the Ctrl+K one.
  let searchButton: HTMLButtonElement | null = null;
  const onSearch = opts.onSearch;
  if (onSearch !== undefined) {
    const button = createElement("button", {
      type: "button",
      class: "sidebar-drawer-search",
      "data-testid": "sidebar-drawer-search",
    });
    button.append(createIcon("search", 16), createElement("span", {}, shellText("sidebar.search")));
    sidebar.querySelector(".unified-sidebar-header")?.after(button);
    // Closed first, so the switcher finds the chat and not the drawer behind it.
    owner.onEvent(button, "click", () => {
      closeDrawer("destination");
      onSearch();
    });
    searchButton = button;
  }

  function sync(): void {
    sidebar.classList.toggle("drawer-open", open);
    rail?.classList.toggle("drawer-open", open);
    backdrop.classList.toggle("open", open);
    // With the drawer shut, Back from a chat has an entry to pop (Android).
    backGuard?.setActive(!open && collapsed() && isPhoneLayout());
    // Below the breakpoint the closed sidebar is off-screen, so its controls
    // must not stay tabbable off-screen; above it, the sidebar is in flow and
    // must stay fully interactive.
    sidebar.inert = collapsed() && !open;
    toggle.setAttribute("aria-expanded", String(open));
    const label = open ? shellText("sidebar.close") : shellText("sidebar.open");
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  }

  // The drawer owns the toggle's state, so seed it (the header builds the
  // button before this controller exists).
  sync();

  /** `claimsBack`: Back closes the drawer (the menu); false when Back itself opened it. */
  function openDrawer(claimsBack: boolean): void {
    if (open) return;
    open = true;
    if (claimsBack && isPhoneLayout())
      backClaim = claimBack(() => closeDrawer("dismiss"), owner.signal);
    opts.onOpen?.();
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
    // The guard goes back up before the claim is let go, so the history entry
    // the claim held carries over instead of being popped and pushed again.
    sync();
    backClaim?.release();
    backClaim = null;
    if (reason === "dismiss" || focusWasInside) restoreFn?.();
  }

  toggle.addEventListener("click", () => (open ? closeDrawer("dismiss") : openDrawer(true)), {
    signal: owner.signal,
  });

  // Only an Escape pressed in the drawer or on its toggle: one in a dialog
  // opened from the drawer is that dialog's to handle.
  owner.onEvent(document, "keydown", (e: KeyboardEvent) => {
    if (e.key !== "Escape" || isImeCommit(e) || !open) return;
    const target = e.target;
    const inDrawer =
      target === document.body ||
      (target instanceof Node &&
        (sidebar.contains(target) || toggle.contains(target) || rail?.contains(target) === true));
    if (!inDrawer) return;
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
  const onBreakpoint = (): void => {
    if (!collapsed()) {
      // Widening puts the sidebar back in flow and hides the toggle. Focus
      // that was inside the drawer stays on the now-visible sidebar, so drop
      // the restore rather than yank it to a hidden button.
      open = false;
      restoreFocusRef = null;
      backClaim?.release();
      backClaim = null;
    }
    sync();
  };
  narrow.addEventListener("change", onBreakpoint, { signal: owner.signal });
  // A rotation moves a phone across the other breakpoint (its height).
  onPhoneLayoutChange(onBreakpoint, owner.signal);

  return {
    open: () => openDrawer(true),
    close: () => closeDrawer("dismiss"),
    isOpen: () => open,
    destroy: () => {
      closeDrawer("dismiss");
      owner.destroy();
      backdrop.remove();
      searchButton?.remove();
      sidebar.classList.remove("drawer-open");
      rail?.classList.remove("drawer-open");
    },
  };
}

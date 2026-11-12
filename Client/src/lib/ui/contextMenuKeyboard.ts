// The keyboard model every menu shares: Shift+F10 to open, arrow keys, Home and
// End, Escape, and ArrowRight or Enter into a submenu.
import { isImeCommit } from "../text/ime";
import { setRovingTabindex } from "./a11y";
import {
  MENU_ITEM_SELECTOR,
  SUBMENU_SELECTOR,
  hideFlyout,
  menuItems,
  ownedSubmenu,
  revealSubmenu,
} from "./contextMenuFlyout";

/**
 * Bind the keyboard entry point (Shift+F10 / the dedicated Menu key) that opens
 * a row's menu, anchored to the row's own edge instead of a pointer position
 * (A11Y-01). The listener dies with `signal`, matching the row's render owner.
 */
export function openMenuOnKeyboard(
  el: HTMLElement,
  openAt: (x: number, y: number) => void,
  signal: AbortSignal,
  /** Return false when the row has no menu right now: the key is then left alone. */
  canOpen: () => boolean = () => true,
): void {
  el.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (!(e.shiftKey && e.key === "F10") && e.key !== "ContextMenu") return;
      if (!canOpen()) return;
      e.preventDefault();
      // A row nested in another menu-owning row (a voice participant inside a
      // voice channel row) must not also open its parent's menu.
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      openAt(rect.right, rect.top);
    },
    { signal },
  );
}

export interface MenuKeyboardOptions {
  /** Aborts the menu's key listener; usually the menu's own dismiss signal. */
  readonly signal: AbortSignal;
  /** Remove/abort the menu. Escape and outside dismissal run this. */
  readonly onClose: () => void;
  /** Fallback focus target when the previously focused control is gone. */
  readonly restoreFocusTo?: () => HTMLElement | null;
}

/** ArrowLeft inside a sibling flyout closes it and returns to its trigger. Whether it did. */
function closeFlyoutOnArrowLeft(e: KeyboardEvent, owner: HTMLElement): boolean {
  if (e.key !== "ArrowLeft" || !owner.matches(SUBMENU_SELECTOR)) return false;
  const trigger = owner.previousElementSibling;
  if (!(trigger instanceof HTMLElement) || trigger.getAttribute("aria-haspopup") !== "menu") {
    return false;
  }
  e.preventDefault();
  hideFlyout(owner);
  trigger.focus();
  return true;
}

/** ArrowRight/Enter/Space on a row that owns a flyout. Whether the key was taken. */
function openSubmenuOnKey(e: KeyboardEvent, target: HTMLElement): boolean {
  if (e.key !== "ArrowRight" && e.key !== "Enter" && e.key !== " ") return false;
  const sub = ownedSubmenu(target);
  if (sub === null) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  // A trigger that is itself an action (Mute Channel) runs it on Enter
  // or Space; only ArrowRight opens its flyout. Otherwise Enter or Space
  // would also fire the trigger's click, which is stopped so the submenu
  // opens instead of the row activating.
  if (e.key !== "ArrowRight" && target.dataset["activates"] === "true") target.click();
  else revealSubmenu(sub);
  return true;
}

/** The index an arrow/Home/End key moves to in a menu, or null when it does not move. */
function menuMoveTarget(key: string, from: number, count: number, inRow: boolean): number | null {
  if (key === "ArrowDown") return Math.min(from + 1, count - 1);
  if (key === "ArrowUp") return Math.max(from - 1, 0);
  if (key === "ArrowRight" && inRow) return Math.min(from + 1, count - 1);
  if (key === "ArrowLeft" && inRow) return Math.max(from - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** Move the roving focus within `owner`'s rows. */
function moveMenuFocus(e: KeyboardEvent, target: HTMLElement, owner: HTMLElement): void {
  // Left/Right move along a side-by-side row (the quick reactions); Up/Down
  // still walk the whole menu.
  const row = target.closest<HTMLElement>('[role="group"]');
  const sideways = e.key === "ArrowLeft" || e.key === "ArrowRight";
  const items = menuItems(owner).filter((el) => !sideways || row?.contains(el) === true);
  const from = items.indexOf(target);
  if (from === -1) return;
  const to = menuMoveTarget(e.key, from, items.length, row !== null);
  if (to === null) return;
  e.preventDefault();
  for (const item of items) item.setAttribute("tabindex", "-1");
  const next = items[to]!;
  next.setAttribute("tabindex", "0");
  next.focus();
}

function handleMenuKey(e: KeyboardEvent, close: () => void): void {
  // Escape closes the whole menu from anywhere inside it, submenu or
  // inline reveal form (the ban reason/duration fields) alike.
  if (e.key === "Escape" && !isImeCommit(e)) {
    e.preventDefault();
    e.stopPropagation();
    close();
    return;
  }

  const target =
    e.target instanceof HTMLElement ? e.target.closest<HTMLElement>(MENU_ITEM_SELECTOR) : null;
  if (target === null) return;
  const owner = target.closest<HTMLElement>(`[role="menu"], ${SUBMENU_SELECTOR}`);
  if (owner === null) return;
  if (closeFlyoutOnArrowLeft(e, owner)) return;
  if (openSubmenuOnKey(e, target)) return;
  moveMenuFocus(e, target, owner);
}

/**
 * Attach the shared menu keyboard model to an already-built, mounted menu.
 * Returns a restorer that puts focus back on the invoking control — call it
 * after any close path (item click, outside dismissal) so focus is never lost
 * to `<body>`.
 *
 * Mouse behaviour is unchanged: the caller's own click handlers still fire, and
 * hovering still opens submenus. Keyboard: focus moves to the first row on
 * open; ArrowUp/Down + Home/End move within a menu; ArrowRight/Enter opens a
 * submenu and focuses its first row; Escape closes the menu and restores focus
 * to the invoking row. Enter/Space on a row activates it through its native
 * button click (or opens its submenu, handled before the click fires).
 */
export function enableMenuKeyboard(menu: HTMLElement, opts: MenuKeyboardOptions): () => void {
  menu.setAttribute("role", "menu");
  // The menu's own document: a call's pop-out window keeps its own focus.
  const doc = menu.ownerDocument;
  const previous = doc.activeElement;
  setRovingTabindex(menu, MENU_ITEM_SELECTOR);

  // The row that invoked the menu held focus when we captured `previous`
  // (keyboard open); restore it on close so focus never drops to <body>.
  const restore = (): void => {
    const active = doc.activeElement;
    const lost = active === null || active === doc.body || menu.contains(active);
    if (!lost) return;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    else opts.restoreFocusTo?.()?.focus();
  };
  const close = (): void => {
    opts.onClose();
    restore();
  };

  // A caller that returns the menu for its owner to append (AdminActions) has
  // not mounted it yet, and focus() on a detached node is a no-op. Focus the
  // first row on the microtask after the caller's synchronous append; a menu
  // already mounted (showContextMenu, volume-menu) focuses right away.
  const focusFirst = (): void => menuItems(menu)[0]?.focus();
  if (menu.isConnected) queueMicrotask(focusFirst);
  else
    queueMicrotask(() => {
      if (!opts.signal.aborted && menu.isConnected) focusFirst();
    });

  menu.addEventListener("keydown", (e: KeyboardEvent) => handleMenuKey(e, close), {
    signal: opts.signal,
  });

  return restore;
}

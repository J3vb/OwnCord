/**
 * Shared context menu utility.
 * Creates a positioned context menu with items, handles click-outside
 * dismissal, and cleans up via AbortSignal. Also owns the keyboard model every
 * menu in the app shares (B9 A11Y-01): role=menu, focusable role=menuitem rows
 * with a roving tabindex, focus into the menu on open, arrow-key/Home/End
 * navigation, Escape to close and restore focus, and ArrowRight/Enter to open a
 * nested submenu.
 */

import { Disposable } from "./disposable";
import { createElement, setOwnedTimeout } from "./dom";
import { setRovingTabindex } from "./a11y";

/** A nested flyout submenu, whether or not its role is set yet. */
const SUBMENU_SELECTOR = ".context-menu__submenu";

export interface ContextMenuItem {
  readonly label: string;
  readonly onClick: () => void;
  readonly danger?: boolean;
  readonly testId?: string;
}

export interface ContextMenuOptions {
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
  /** AbortSignal for automatic cleanup when parent component is destroyed. */
  readonly signal: AbortSignal;
  /** CSS class added to the menu root (for styling/selection). */
  readonly className?: string;
}

/** Actionable menu rows, in any menu. Disabled rows are not navigable. */
const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([aria-disabled="true"]):not([disabled])';

/** The menu rows directly inside `menu`. A nested submenu holds its own; the
 *  ban/purge reveal form's confirm row is excluded while hidden (it becomes a
 *  Tab stop only once the form is shown), so Arrow keys never land on it. */
function menuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
    (el) =>
      el.closest<HTMLElement>(`[role="menu"], ${SUBMENU_SELECTOR}`) === menu &&
      el.closest(".context-menu__reason") === null,
  );
}

/**
 * Bind the keyboard entry point (Shift+F10 / the dedicated Menu key) that opens
 * a row's menu, anchored to the row's own edge instead of a pointer position
 * (A11Y-01). The listener dies with `signal`, matching the row's render owner.
 */
export function openMenuOnKeyboard(
  el: HTMLElement,
  openAt: (x: number, y: number) => void,
  signal: AbortSignal,
): void {
  el.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (!(e.shiftKey && e.key === "F10") && e.key !== "ContextMenu") return;
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

/**
 * Build one menu row as a real focusable element: a `<button role="menuitem">`
 * so Enter/Space activate it natively, or (for a row that owns a nested flyout,
 * which a button may not contain) a `role="menuitem"` div. Roving tabindex
 * starts at -1; enableMenuKeyboard raises the first visible row to 0.
 */
export function createMenuItem(
  label: string,
  className: string,
  opts: { testId?: string; submenu?: boolean } = {},
): HTMLElement {
  const attrs: Record<string, string> = { class: className, role: "menuitem", tabindex: "-1" };
  if (opts.submenu === true) {
    attrs["aria-haspopup"] = "menu";
    attrs["aria-expanded"] = "false";
  } else {
    attrs["type"] = "button";
  }
  if (opts.testId !== undefined) attrs["data-testid"] = opts.testId;
  return createElement(opts.submenu === true ? "div" : "button", attrs, label);
}

export interface MenuKeyboardOptions {
  /** Aborts the menu's key listener; usually the menu's own dismiss signal. */
  readonly signal: AbortSignal;
  /** Remove/abort the menu. Escape and outside dismissal run this. */
  readonly onClose: () => void;
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
  const previous = document.activeElement;
  setRovingTabindex(menu, MENU_ITEM_SELECTOR);

  // The row that invoked the menu held focus when we captured `previous`
  // (keyboard open); restore it on close so focus never drops to <body>.
  const restore = (): void => {
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
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

  menu.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      // Escape closes the whole menu from anywhere inside it, submenu or
      // inline reveal form (the ban reason/duration fields) alike.
      if (e.key === "Escape") {
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

      if (e.key === "ArrowRight" || e.key === "Enter") {
        const sub = target.querySelector<HTMLElement>(`:scope > ${SUBMENU_SELECTOR}`);
        if (sub !== null) {
          e.preventDefault();
          // Enter would otherwise also fire the trigger's click; stop it so the
          // submenu opens instead of the row activating.
          e.stopImmediatePropagation();
          revealSubmenu(target, sub);
          return;
        }
      }

      const items = menuItems(owner);
      const from = items.indexOf(target);
      if (from === -1) return;
      let to: number | null = null;
      if (e.key === "ArrowDown") to = Math.min(from + 1, items.length - 1);
      else if (e.key === "ArrowUp") to = Math.max(from - 1, 0);
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = items.length - 1;
      if (to === null) return;
      e.preventDefault();
      for (const item of items) item.setAttribute("tabindex", "-1");
      const next = items[to]!;
      next.setAttribute("tabindex", "0");
      next.focus();
    },
    { signal: opts.signal },
  );

  return restore;
}

/** Reveal a trigger's submenu and focus its first row. */
function revealSubmenu(trigger: HTMLElement, submenu: HTMLElement): void {
  submenu.style.display = "";
  submenu.setAttribute("role", "menu");
  trigger.setAttribute("aria-expanded", "true");
  setRovingTabindex(submenu, MENU_ITEM_SELECTOR);
  menuItems(submenu)[0]?.focus();
}

/** No-op default until the keyboard model installs the real restorer. */
const noop = (): void => {};

// Tracks each open menu's per-invocation dismiss owner, so a menu swept away
// by a same-class reopen (see below) can release its own teardown listener on
// the caller's signal instead of leaving it pinned until the caller's signal
// eventually aborts.
const dismissOwners = new WeakMap<Element, Disposable>();

/**
 * Show a context menu at the given coordinates.
 * Automatically removes any existing menu with the same className.
 * Closes on click outside or when signal is aborted.
 */
export function showContextMenu(opts: ContextMenuOptions): void {
  const { x, y, items, signal, className } = opts;
  const menuClass = className ?? "context-menu";

  // Remove any existing context menu with same class, releasing its dismiss
  // owner so its teardown listener on the caller's signal is dropped
  // now rather than lingering until the caller itself is destroyed.
  document.querySelectorAll(`.${menuClass}`).forEach((el) => {
    dismissOwners.get(el)?.destroy();
    el.remove();
  });

  const menu = createElement("div", { class: `context-menu ${menuClass}` });
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const dismiss = new Disposable();
  dismissOwners.set(menu, dismiss);

  let restoreFocus: () => void = noop;
  const closeMenu = (): void => {
    menu.remove();
    dismiss.destroy();
    restoreFocus();
  };

  let hasSeparator = false;
  for (const item of items) {
    if (hasSeparator && item.danger) {
      menu.appendChild(createElement("div", { class: "context-menu-sep" }));
    }

    const el = createMenuItem(
      item.label,
      item.danger ? "context-menu-item danger" : "context-menu-item",
      item.testId !== undefined ? { testId: item.testId } : {},
    );
    el.addEventListener(
      "click",
      () => {
        closeMenu();
        item.onClick();
      },
      { signal },
    );
    menu.appendChild(el);
    hasSeparator = !item.danger;
  }

  document.body.appendChild(menu);

  restoreFocus = enableMenuKeyboard(menu, { signal: dismiss.signal, onClose: closeMenu });

  // Close on click outside (deferred so the opening click doesn't immediately close)
  setOwnedTimeout(
    dismiss.signal,
    () => {
      document.addEventListener(
        "mousedown",
        (e: MouseEvent) => {
          if (!menu.contains(e.target as Node)) {
            closeMenu();
          }
        },
        { signal: dismiss.signal },
      );
    },
    0,
  );

  // Clean up if parent component is destroyed. If the caller's signal is
  // already aborted, "abort" already fired and would never reach a listener
  // added now, so tear down immediately instead of registering one. When it
  // isn't, tie the listener's own lifetime to `dismiss`: once the menu is
  // dismissed some other way (item click, outside click), `dismiss` is
  // destroyed and this listener is dropped from the caller's signal instead of
  // lingering — with its closure over `menu` — for the rest of the caller's
  // lifetime.
  if (signal.aborted) {
    menu.remove();
    dismiss.destroy();
  } else {
    signal.addEventListener(
      "abort",
      () => {
        menu.remove();
        dismiss.destroy();
      },
      { once: true, signal: dismiss.signal },
    );
  }
}

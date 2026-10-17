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
  /** The row's text, or its `aria-label` when `content` is given. */
  readonly label: string;
  /** Receives the click, so a row can read `shiftKey`. A keyboard activation
   *  (Enter/Space) arrives as a click too. */
  readonly onClick: (e: MouseEvent) => void;
  readonly danger?: boolean;
  readonly testId?: string;
  /** Shown but not actionable: skipped by the arrow keys, ignores clicks, and
   *  stays open so the reason in `title` can be read. */
  readonly disabled?: boolean;
  readonly title?: string;
  /** Rendered in place of the text label (an emoji). */
  readonly content?: Node;
  /** Makes the row a checkbox (`role="menuitemcheckbox"`); the value is its
   *  `aria-checked`. A click still closes the menu, so the caller flips the
   *  state it reads from and the next open shows the new value. */
  readonly checked?: boolean;
}

/** A divider between two rows. */
export interface ContextMenuSeparator {
  readonly separator: true;
}

export interface ContextMenuOptions {
  readonly x: number;
  readonly y: number;
  readonly items: readonly (ContextMenuItem | ContextMenuSeparator)[];
  /** `count` consecutive items from index `start` sit side by side in one
   *  `role="group"` row (the message menu's quick reactions). */
  readonly group?: { readonly start: number; readonly count: number };
  /** Where focus goes on close when the control that had it before the menu
   *  opened has left the page (a row rebuilt by scrolling). */
  readonly restoreFocusTo?: () => HTMLElement | null;
  /** The accessible name of the `group` row. */
  readonly groupLabel?: string;
  /** The menu's accessible name. */
  readonly ariaLabel?: string;
  /** Runs once when the menu goes away, by any path. */
  readonly onClosed?: () => void;
  /** AbortSignal for automatic cleanup when parent component is destroyed. */
  readonly signal: AbortSignal;
  /** CSS class added to the menu root (for styling/selection). */
  readonly className?: string;
}

/** The close hook of the open sidebar (channel or category) context menu. */
let activeSidebarMenuClose: (() => void) | null = null;

/**
 * Register `close` as the open sidebar menu, closing any previous one first.
 * Returns the unregister, which the menu's own close calls so it never
 * clears a successor.
 */
export function registerSidebarMenu(close: () => void): () => void {
  activeSidebarMenuClose?.();
  document.querySelectorAll(".channel-ctx-menu").forEach((prev) => prev.remove());
  activeSidebarMenuClose = close;
  return () => {
    if (activeSidebarMenuClose === close) activeSidebarMenuClose = null;
  };
}

/** Actionable menu rows, in any menu. Disabled rows are not navigable. */
const MENU_ITEM_SELECTOR = ["menuitem", "menuitemcheckbox"]
  .map((role) => `[role="${role}"]:not([aria-disabled="true"]):not([disabled])`)
  .join(", ");

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
  if (opts.submenu !== true) attrs["type"] = "button";
  if (opts.testId !== undefined) attrs["data-testid"] = opts.testId;
  return createElement(opts.submenu === true ? "div" : "button", attrs, label);
}

export interface MenuKeyboardOptions {
  /** Aborts the menu's key listener; usually the menu's own dismiss signal. */
  readonly signal: AbortSignal;
  /** Remove/abort the menu. Escape and outside dismissal run this. */
  readonly onClose: () => void;
  /** Fallback focus target when the previously focused control is gone. */
  readonly restoreFocusTo?: () => HTMLElement | null;
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
          revealSubmenu(sub);
          return;
        }
      }

      // Left/Right move along a side-by-side row (the quick reactions); Up/Down
      // still walk the whole menu.
      const row = target.closest<HTMLElement>('[role="group"]');
      const sideways = e.key === "ArrowLeft" || e.key === "ArrowRight";
      const items = menuItems(owner).filter((el) => !sideways || row?.contains(el) === true);
      const from = items.indexOf(target);
      if (from === -1) return;
      let to: number | null = null;
      if (e.key === "ArrowDown") to = Math.min(from + 1, items.length - 1);
      else if (e.key === "ArrowUp") to = Math.max(from - 1, 0);
      else if (e.key === "ArrowRight" && row !== null) to = Math.min(from + 1, items.length - 1);
      else if (e.key === "ArrowLeft" && row !== null) to = Math.max(from - 1, 0);
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

/** Reveal a submenu and focus its first row. */
function revealSubmenu(submenu: HTMLElement): void {
  submenu.style.display = "";
  submenu.setAttribute("role", "menu");
  setRovingTabindex(submenu, MENU_ITEM_SELECTOR);
  menuItems(submenu)[0]?.focus();
}

/** No-op default until the keyboard model installs the real restorer. */
const noop = (): void => {};

// Tracks each open menu's per-invocation dismiss owner, so a menu swept away
// by a same-class reopen can release its own teardown listener on the
// caller's signal instead of leaving it pinned until the caller's signal
// eventually aborts.
const dismissOwners = new WeakMap<Element, Disposable>();

/**
 * Keep a menu inside the viewport, anchored by its top-left, flipping to its
 * bottom/right edge when it does not fit — and never above the top margin.
 * Shared by the menus that are mounted directly (showContextMenu) and the
 * channel sidebar's own menus, so they cannot drift — a menu opened low in a
 * short window otherwise runs off and its last actions are unreachable (F9).
 */
export function clampMenuToViewport(menu: HTMLElement, x: number, y: number): void {
  const margin = 8;
  const { innerWidth: vw, innerHeight: vh } = window;
  const left = Math.min(x, vw - menu.offsetWidth - margin);
  menu.style.left = `${Math.max(margin, left)}px`;
  if (y + menu.offsetHeight > vh - margin) {
    menu.style.top = "";
    menu.style.bottom = `${Math.max(margin, Math.min(vh - y, vh - menu.offsetHeight - margin))}px`;
  } else {
    menu.style.bottom = "";
    menu.style.top = `${y}px`;
  }
}

/**
 * Show a context menu at the given coordinates.
 * Automatically removes any existing menu with the same className.
 * Closes on click outside or when signal is aborted.
 */
export function showContextMenu(opts: ContextMenuOptions): void {
  const { x, y, items, signal, className, group } = opts;
  const menuClass = className ?? "context-menu";

  // Remove any existing context menu with same class, releasing its dismiss
  // owner so its teardown listener on the caller's signal is dropped
  // now rather than lingering until the caller itself is destroyed.
  document.querySelectorAll(`.${menuClass}`).forEach((el) => {
    dismissOwners.get(el)?.destroy();
    el.remove();
  });

  const menu = createElement("div", { class: `context-menu ${menuClass}` });
  if (opts.ariaLabel !== undefined) menu.setAttribute("aria-label", opts.ariaLabel);

  const dismiss = new Disposable();
  dismissOwners.set(menu, dismiss);

  let restoreFocus: () => void = noop;
  const closeMenu = (): void => {
    menu.remove();
    dismiss.destroy();
    restoreFocus();
  };

  if (opts.onClosed !== undefined) dismiss.addCleanup(opts.onClosed);

  let hasSeparator = false;
  let groupRow: HTMLElement | null = null;
  items.forEach((item, index) => {
    if ("separator" in item) {
      menu.appendChild(createElement("div", { class: "context-menu-sep", role: "separator" }));
      hasSeparator = false;
      return;
    }
    if (hasSeparator && item.danger) {
      menu.appendChild(createElement("div", { class: "context-menu-sep" }));
    }

    const disabled = item.disabled === true;
    const el = createMenuItem(
      item.label,
      [
        "context-menu-item",
        item.danger ? "danger" : "",
        disabled ? "disabled" : "",
        item.content !== undefined ? "context-menu-item--content" : "",
      ]
        .filter((c) => c !== "")
        .join(" "),
      item.testId !== undefined ? { testId: item.testId } : {},
    );
    if (item.content !== undefined) {
      el.replaceChildren(item.content);
      el.setAttribute("aria-label", item.label);
    }
    if (item.title !== undefined) el.title = item.title;
    if (item.checked !== undefined) {
      el.setAttribute("role", "menuitemcheckbox");
      el.setAttribute("aria-checked", String(item.checked));
    }
    if (disabled) el.setAttribute("aria-disabled", "true");
    el.addEventListener(
      "click",
      (e) => {
        if (disabled) return;
        closeMenu();
        item.onClick(e);
      },
      { signal },
    );
    if (group !== undefined && index >= group.start && index < group.start + group.count) {
      if (groupRow === null) {
        groupRow = createElement("div", { class: "context-menu-group", role: "group" });
        if (opts.groupLabel !== undefined) groupRow.setAttribute("aria-label", opts.groupLabel);
        menu.appendChild(groupRow);
      }
      groupRow.appendChild(el);
    } else {
      menu.appendChild(el);
    }
    hasSeparator = !item.danger;
  });

  // Kept on screen: a menu opened near the bottom/right edge (a channel low
  // in the sidebar at the 940x500 minimum window) otherwise runs off and its
  // last actions are unreachable. Runs after the items are appended so the
  // measured size is real, and again on resize (the purge reveal form, a
  // nested submenu) so a later expand cannot push an action off-screen.
  const clamp = (): void => clampMenuToViewport(menu, x, y);

  document.body.appendChild(menu);
  clamp();
  const reposition = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(clamp);
  if (reposition !== null) {
    reposition.observe(menu);
    dismiss.addCleanup(() => reposition.disconnect());
  }

  restoreFocus = enableMenuKeyboard(menu, {
    signal: dismiss.signal,
    onClose: closeMenu,
    ...(opts.restoreFocusTo !== undefined ? { restoreFocusTo: opts.restoreFocusTo } : {}),
  });

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

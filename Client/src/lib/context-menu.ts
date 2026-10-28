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
  /** Makes the row a checkbox (`role="menuitemcheckbox"`), or a radio row
   *  (`role="menuitemradio"`) with `radio`; the value is its `aria-checked`.
   *  A click still closes the menu, so the caller flips the state it reads
   *  from and the next open shows the new value. */
  readonly checked?: boolean;
  /** With `checked`, a radio row instead of a checkbox. */
  readonly radio?: boolean;
  /** A second, smaller line under the label ("Muted until 15:30"). */
  readonly detail?: string;
  /** A row that owns a flyout. Hover or ArrowRight shows the rows; a click or
   *  Enter on the row itself runs `onClick`, which is the default action. */
  readonly submenu?: readonly ContextMenuItem[];
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

/** Tears down the one open menu, whatever kind it is. Opening any menu runs it
 *  first, so a sidebar menu never stays open beside a member or tile menu. */
let supersedeOpenMenu: (() => void) | null = null;

/** Actionable menu rows, in any menu. Disabled rows are not navigable. */
const MENU_ITEM_SELECTOR = ["menuitem", "menuitemcheckbox", "menuitemradio"]
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

      // ArrowLeft inside a sibling flyout closes it and returns to its trigger.
      if (e.key === "ArrowLeft" && owner.matches(SUBMENU_SELECTOR)) {
        const trigger = owner.previousElementSibling;
        if (trigger instanceof HTMLElement && trigger.getAttribute("aria-haspopup") === "menu") {
          e.preventDefault();
          hideFlyout(owner);
          trigger.focus();
          return;
        }
      }

      if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
        const sub = ownedSubmenu(target);
        // A trigger that is itself an action (Mute Channel) runs it on Enter
        // or Space; only ArrowRight opens its flyout.
        if (sub !== null && e.key !== "ArrowRight" && target.dataset["activates"] === "true") {
          e.preventDefault();
          e.stopImmediatePropagation();
          target.click();
          return;
        }
        if (sub !== null) {
          e.preventDefault();
          // Enter or Space would otherwise also fire the trigger's click; stop it so the
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

/** The flyout a menu row owns: a child (the hand-built menus) or the next
 *  sibling (`createSubmenuTrigger`, which keeps the row's own text clean). */
function ownedSubmenu(row: HTMLElement): HTMLElement | null {
  const child = row.querySelector<HTMLElement>(`:scope > ${SUBMENU_SELECTOR}`);
  if (child !== null) return child;
  const next = row.nextElementSibling;
  return next instanceof HTMLElement && next.matches(SUBMENU_SELECTOR) ? next : null;
}

/** Show a sibling flyout beside its trigger, flipping to the trigger's left
 *  when it would run off the right edge. A child flyout is placed by CSS. */
function placeFlyout(flyout: HTMLElement): void {
  const trigger = flyout.previousElementSibling;
  if (!(trigger instanceof HTMLElement) || trigger.getAttribute("aria-haspopup") !== "menu") return;
  flyout.style.top = `${trigger.offsetTop}px`;
  flyout.style.left = `${trigger.offsetLeft + trigger.offsetWidth}px`;
  const rect = flyout.getBoundingClientRect();
  const margin = 8;
  if (rect.right > window.innerWidth - margin) {
    flyout.style.left = `${trigger.offsetLeft - rect.width}px`;
  }
  // Near the bottom edge, slide up just enough to stay on screen (never past
  // the top margin).
  const overflow = rect.bottom - (window.innerHeight - margin);
  if (overflow > 0) {
    const shift = Math.min(overflow, Math.max(0, rect.top - margin));
    flyout.style.top = `${trigger.offsetTop - shift}px`;
  }
  trigger.setAttribute("aria-expanded", "true");
}

function hideFlyout(flyout: HTMLElement): void {
  flyout.style.display = "none";
  flyout.previousElementSibling?.setAttribute("aria-expanded", "false");
}

let submenuSeq = 0;

export interface SubmenuTriggerOptions {
  readonly testId?: string;
  /** True when a click or Enter on the row itself is an action (Mute Channel
   *  mutes until turned off). False: Enter opens the flyout instead. */
  readonly activates?: boolean;
  /** Runs for a click on the row itself, never for a click inside the flyout. */
  readonly onActivate?: (e: MouseEvent) => void;
}

/**
 * A menu row that owns a hover flyout, shared by every menu that needs one.
 * Append `trigger`, then `flyout`, to the menu in that order: the flyout is the
 * trigger's next sibling, so the row's own text stays just its label.
 */
export function createSubmenuTrigger(
  label: string,
  className: string,
  opts: SubmenuTriggerOptions,
  signal: AbortSignal,
): { readonly trigger: HTMLElement; readonly flyout: HTMLElement } {
  const trigger = createMenuItem(
    label,
    `${className} context-menu-item--submenu context-menu-item--flyout`,
    {
      submenu: true,
      ...(opts.testId !== undefined ? { testId: opts.testId } : {}),
    },
  );
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  const seq = ++submenuSeq;
  trigger.id = `ctx-submenu-trigger-${seq}`;
  if (opts.activates === true) trigger.setAttribute("data-activates", "true");
  const flyout = createElement("div", { class: "context-menu__submenu" });
  flyout.style.display = "none";
  flyout.setAttribute("role", "menu");
  flyout.id = `ctx-submenu-${seq}`;
  flyout.setAttribute("aria-labelledby", trigger.id);
  trigger.setAttribute("aria-controls", flyout.id);

  const show = (): void => {
    flyout.style.display = "";
    placeFlyout(flyout);
  };
  const hide = (e: MouseEvent): void => {
    const to = e.relatedTarget;
    if (to instanceof Node && (trigger.contains(to) || flyout.contains(to))) return;
    hideFlyout(flyout);
  };
  trigger.addEventListener("mouseenter", show, { signal });
  flyout.addEventListener("mouseenter", show, { signal });
  trigger.addEventListener("mouseleave", hide, { signal });
  flyout.addEventListener("mouseleave", hide, { signal });
  const onActivate = opts.onActivate;
  if (onActivate !== undefined) {
    trigger.addEventListener(
      "click",
      (e) => {
        if (e.target instanceof Node && flyout.contains(e.target)) return;
        onActivate(e);
      },
      { signal },
    );
  }
  return { trigger, flyout };
}

/** Reveal a submenu and focus its first row. */
function revealSubmenu(submenu: HTMLElement): void {
  submenu.style.display = "";
  placeFlyout(submenu);
  submenu.setAttribute("role", "menu");
  setRovingTabindex(submenu, MENU_ITEM_SELECTOR);
  menuItems(submenu)[0]?.focus();
}

/** The class list of a plain row. */
function rowClassOf(item: ContextMenuItem): string {
  return [
    "context-menu-item",
    item.danger ? "danger" : "",
    item.disabled === true ? "disabled" : "",
    item.content !== undefined ? "context-menu-item--content" : "",
  ]
    .filter((c) => c !== "")
    .join(" ");
}

/** Put a muted second line under a row's label. */
function appendDetail(row: HTMLElement, text: string): void {
  row.appendChild(createElement("span", { class: "context-menu-item__detail" }, text));
}

/** No-op default until the keyboard model installs the real restorer. */
const noop = (): void => {};

/**
 * Keep a menu inside the viewport, anchored by its top-left, flipping to its
 * bottom/right edge when it does not fit — and never above the top margin.
 * Shared by the menus that are mounted directly (showContextMenu) and the
 * channel sidebar's own menus, so they cannot drift — a menu opened low in a
 * short window otherwise runs off and its last actions are unreachable (F9).
 */
export function clampMenuToViewport(
  menu: HTMLElement,
  x: number,
  y: number,
  view: Window = window,
): void {
  const margin = 8;
  const { innerWidth: vw, innerHeight: vh } = view;
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

/** Keep a long menu inside the window by capping its height and scrolling it,
 *  anchored by its top-left (the video-tile menu). */
function fitMenuScrolling(menu: HTMLElement, x: number, y: number, view: Window): void {
  const margin = 8;
  const room = view.innerHeight - 2 * margin;
  if (menu.offsetHeight > room) {
    menu.style.maxHeight = `${room}px`;
    menu.style.overflowY = "auto";
  }
  const left = Math.min(x, view.innerWidth - menu.offsetWidth - margin);
  const top = Math.min(y, view.innerHeight - menu.offsetHeight - margin);
  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
}

export interface MenuShellOptions {
  readonly x: number;
  readonly y: number;
  /** Classes added after `context-menu`. */
  readonly className?: string;
  /** Extra attributes on the menu root (`data-testid`, `aria-label`, `style`). */
  readonly attrs?: Readonly<Record<string, string>>;
  /** The owner's lifetime: aborting it removes the menu. Omit only when the
   *  caller closes the menu itself on teardown. */
  readonly signal?: AbortSignal;
  /** `outside` (default): a mousedown outside the menu closes it. `any-click`:
   *  any click on the page closes it, inside included (the sidebar menus). */
  readonly dismiss?: "outside" | "any-click";
  /** `flip` (default): anchor by the bottom edge when it does not fit below.
   *  `scroll`: cap the height and scroll instead. */
  readonly fit?: "flip" | "scroll";
  /** The document to mount in (a call's pop-out window). */
  readonly doc?: Document;
  /** Where focus goes on close when the opener has left the page. */
  readonly restoreFocusTo?: () => HTMLElement | null;
  /** Runs once when the menu goes away, by any path. */
  readonly onClosed?: () => void;
  /** Fills the menu before it is mounted. `close` closes it and returns focus
   *  to the opener; `signal` aborts when the menu goes away. */
  readonly build: (menu: HTMLDivElement, close: () => void, signal: AbortSignal) => void;
}

export interface OpenMenu {
  readonly element: HTMLDivElement;
  /** Close the menu and return focus to the opener. Safe to call twice. */
  readonly destroy: () => void;
}

/**
 * The one way a right-click menu opens. Closes whatever menu is open, builds
 * the `.context-menu` root, mounts it (inside the full-screen element when
 * there is one, so it can be seen), keeps it inside the window, re-placed on
 * resize (an inline reveal form or submenu), installs the shared keyboard
 * model, and wires the dismissal and the owner's teardown.
 */
export function openMenuShell(opts: MenuShellOptions): OpenMenu {
  supersedeOpenMenu?.();
  const doc = opts.doc ?? document;
  const view = doc.defaultView ?? window;
  const menu = createElement("div", {
    ...opts.attrs,
    class: opts.className === undefined ? "context-menu" : `context-menu ${opts.className}`,
  });

  const owner = new Disposable();
  if (opts.onClosed !== undefined) owner.addCleanup(opts.onClosed);
  let open = true;
  let restoreFocus: () => void = noop;
  const teardown = (): void => {
    if (!open) return;
    open = false;
    if (supersedeOpenMenu === teardown) supersedeOpenMenu = null;
    menu.remove();
    owner.destroy();
  };
  const close = (): void => {
    if (!open) return;
    teardown();
    restoreFocus();
  };

  const signal = opts.signal;
  if (signal?.aborted === true) {
    teardown();
    return { element: menu, destroy: close };
  }

  opts.build(menu, close, owner.signal);
  (doc.fullscreenElement ?? doc.body).appendChild(menu);
  supersedeOpenMenu = teardown;

  // Placed after the rows are in, so the measured size is real.
  const place = (): void => {
    if (opts.fit === "scroll") fitMenuScrolling(menu, opts.x, opts.y, view);
    else clampMenuToViewport(menu, opts.x, opts.y, view);
  };
  place();
  if (typeof ResizeObserver !== "undefined") {
    const reposition = new ResizeObserver(place);
    reposition.observe(menu);
    owner.addCleanup(() => reposition.disconnect());
  }

  restoreFocus = enableMenuKeyboard(menu, {
    signal: owner.signal,
    onClose: close,
    ...(opts.restoreFocusTo !== undefined ? { restoreFocusTo: opts.restoreFocusTo } : {}),
  });

  // Deferred so the click that opened the menu does not close it.
  setOwnedTimeout(
    owner.signal,
    () => {
      if (opts.dismiss === "any-click") {
        doc.addEventListener("click", close, { signal: owner.signal });
        return;
      }
      doc.addEventListener(
        "mousedown",
        (e: MouseEvent) => {
          if (!(e.target instanceof Node && menu.contains(e.target))) close();
        },
        { signal: owner.signal },
      );
    },
    0,
  );

  // The bridge listener lives only as long as the menu, so a long-lived owner
  // does not collect one closure per right-click.
  signal?.addEventListener("abort", teardown, { once: true, signal: owner.signal });

  return { element: menu, destroy: close };
}

/**
 * Show a context menu of plain rows at the given coordinates. Closes any other
 * open menu, and closes on a click outside or when `signal` is aborted.
 */
export function showContextMenu(opts: ContextMenuOptions): void {
  const { x, y, items, signal, className, group } = opts;
  openMenuShell({
    x,
    y,
    ...(className !== undefined ? { className } : {}),
    ...(opts.ariaLabel !== undefined ? { attrs: { "aria-label": opts.ariaLabel } } : {}),
    signal,
    ...(opts.restoreFocusTo !== undefined ? { restoreFocusTo: opts.restoreFocusTo } : {}),
    ...(opts.onClosed !== undefined ? { onClosed: opts.onClosed } : {}),
    build: (menu, closeMenu, menuSignal) => {
      /** One plain row: a focusable button that closes the menu, then acts. */
      const buildRow = (item: ContextMenuItem): HTMLElement => {
        const disabled = item.disabled === true;
        const el = createMenuItem(
          item.label,
          rowClassOf(item),
          item.testId !== undefined ? { testId: item.testId } : {},
        );
        if (item.content !== undefined) {
          el.replaceChildren(item.content);
          el.setAttribute("aria-label", item.label);
        }
        if (item.detail !== undefined) appendDetail(el, item.detail);
        if (item.checked !== undefined) {
          el.setAttribute("role", item.radio === true ? "menuitemradio" : "menuitemcheckbox");
          el.setAttribute("aria-checked", String(item.checked));
        }
        if (item.title !== undefined) el.title = item.title;
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
        return el;
      };

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
        const rowClass = rowClassOf(item);
        const activate = (e: MouseEvent): void => {
          if (disabled) return;
          closeMenu();
          item.onClick(e);
        };
        if (item.submenu !== undefined && !disabled) {
          const { trigger, flyout } = createSubmenuTrigger(
            item.label,
            rowClass,
            {
              ...(item.testId !== undefined ? { testId: item.testId } : {}),
              activates: true,
              onActivate: activate,
            },
            menuSignal,
          );
          if (item.detail !== undefined) appendDetail(trigger, item.detail);
          for (const sub of item.submenu) flyout.appendChild(buildRow(sub));
          menu.append(trigger, flyout);
          hasSeparator = !item.danger;
          return;
        }
        const el = buildRow(item);
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
    },
  });
}

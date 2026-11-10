/**
 * Shared context menu utility.
 * Creates a positioned context menu with items, handles click-outside
 * dismissal, and cleans up via AbortSignal. Also owns the keyboard model every
 * menu in the app shares (B9 A11Y-01): role=menu, focusable role=menuitem rows
 * with a roving tabindex, focus into the menu on open, arrow-key/Home/End
 * navigation, Escape to close and restore focus, and ArrowRight/Enter to open a
 * nested submenu.
 */

import { Disposable } from "../disposable";
import { createElement, setOwnedTimeout } from "../dom";
import { enableMenuKeyboard } from "./contextMenuKeyboard";
import { createMenuItem, createSubmenuTrigger } from "./contextMenuFlyout";

export {
  openMenuOnKeyboard,
  enableMenuKeyboard,
  type MenuKeyboardOptions,
} from "./contextMenuKeyboard";
export {
  createMenuItem,
  createSubmenuTrigger,
  type SubmenuTriggerOptions,
} from "./contextMenuFlyout";

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
    if (supersedeOpenMenu === close) supersedeOpenMenu = null;
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
  // A full close: focus inside the replaced menu goes back to its opener
  // before this menu records where to return it.
  supersedeOpenMenu = close;

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

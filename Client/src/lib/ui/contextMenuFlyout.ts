// Menu rows and flyout submenus: the row selectors, the focusable row builder,
// the submenu trigger and where a flyout sits. contextMenu.ts re-exports the
// public pieces.
import { createElement, setText } from "../dom";
import { createIcon, type IconName } from "../icons";
import { setRovingTabindex } from "./a11y";

/** A nested flyout submenu, whether or not its role is set yet. */
export const SUBMENU_SELECTOR = ".context-menu__submenu";

/** Actionable menu rows, in any menu. Disabled rows are not navigable. */
export const MENU_ITEM_SELECTOR = ["menuitem", "menuitemcheckbox", "menuitemradio"]
  .map((role) => `[role="${role}"]:not([aria-disabled="true"]):not([disabled])`)
  .join(", ");

/** The menu rows directly inside `menu`. A nested submenu holds its own; the
 *  ban/purge reveal form's confirm row is excluded while hidden (it becomes a
 *  Tab stop only once the form is shown), so Arrow keys never land on it. */
export function menuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
    (el) =>
      el.closest<HTMLElement>(`[role="menu"], ${SUBMENU_SELECTOR}`) === menu &&
      el.closest(".context-menu__reason") === null,
  );
}

/** The icon column of a menu or sheet row. */
export const MENU_ICON_CLASS = "menu-item-icon";
const MENU_LABEL_CLASS = "context-menu-item__label";

/**
 * The leading icon of a row, decorative (the label stays the row's name).
 * Without `icon` it is an empty slot, so a row with no icon lines up with its
 * neighbours that have one.
 */
export function menuIconSlot(icon: IconName | undefined, size = 16): HTMLElement {
  const slot = createElement("span", { class: MENU_ICON_CLASS, "aria-hidden": "true" });
  if (icon !== undefined) slot.appendChild(createIcon(icon, size));
  return slot;
}

function iconSlotOf(row: Element): HTMLElement | null {
  return row.querySelector<HTMLElement>(`:scope > .${MENU_ICON_CLASS}`);
}

/**
 * Build one menu row as a real focusable element: a `<button role="menuitem">`
 * so Enter/Space activate it natively, or (for a row that owns a nested flyout,
 * which a button may not contain) a `role="menuitem"` div. Roving tabindex
 * starts at -1; enableMenuKeyboard raises the first visible row to 0. With
 * `icon`, the row leads with it and the label sits in its own span.
 */
export function createMenuItem(
  label: string,
  className: string,
  opts: { testId?: string; submenu?: boolean; icon?: IconName } = {},
): HTMLElement {
  const attrs: Record<string, string> = { class: className, role: "menuitem", tabindex: "-1" };
  if (opts.submenu !== true) attrs["type"] = "button";
  if (opts.testId !== undefined) attrs["data-testid"] = opts.testId;
  const tag = opts.submenu === true ? "div" : "button";
  if (opts.icon === undefined) return createElement(tag, attrs, label);
  const row = createElement(tag, attrs);
  row.append(menuIconSlot(opts.icon), createElement("span", { class: MENU_LABEL_CLASS }, label));
  return row;
}

/** Change a row's label text, keeping its icon. */
export function setMenuItemLabel(row: HTMLElement, label: string): void {
  const span = row.querySelector<HTMLElement>(`:scope > .${MENU_LABEL_CLASS}`);
  if (span !== null) {
    span.textContent = label;
    return;
  }
  const slot = iconSlotOf(row);
  if (slot === null) setText(row, label);
  else row.replaceChildren(slot, label);
}

const ROW_SELECTOR = ".context-menu-item, .context-menu__item";

/**
 * In each list of rows (the menu and each flyout) where any row has an icon,
 * give every other row an empty slot, so all the labels start in one column.
 * The emoji rows of a group are not in a list and keep their own layout.
 */
export function alignMenuIcons(menu: HTMLElement): void {
  for (const list of [menu, ...menu.querySelectorAll<HTMLElement>(SUBMENU_SELECTOR)]) {
    const rows = [...list.children].filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement &&
        el.matches(ROW_SELECTOR) &&
        !el.classList.contains("context-menu-item--content"),
    );
    if (!rows.some((row) => iconSlotOf(row) !== null)) continue;
    for (const row of rows) {
      if (iconSlotOf(row) === null) row.prepend(menuIconSlot(undefined));
    }
  }
}

/** The flyout a menu row owns: a child (the hand-built menus) or the next
 *  sibling (`createSubmenuTrigger`, which keeps the row's own text clean). */
export function ownedSubmenu(row: HTMLElement): HTMLElement | null {
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

export function hideFlyout(flyout: HTMLElement): void {
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
  /** The row's leading icon. */
  readonly icon?: IconName;
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
      ...(opts.icon !== undefined ? { icon: opts.icon } : {}),
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
export function revealSubmenu(submenu: HTMLElement): void {
  submenu.style.display = "";
  placeFlyout(submenu);
  submenu.setAttribute("role", "menu");
  setRovingTabindex(submenu, MENU_ITEM_SELECTOR);
  menuItems(submenu)[0]?.focus();
}

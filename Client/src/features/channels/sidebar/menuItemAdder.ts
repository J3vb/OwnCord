/**
 * The row builder the channel and category context menus share: a `null`
 * `onClick` draws the row disabled, otherwise a click closes the menu before
 * it acts. Row listeners take the sidebar-lifetime signal: the menu is
 * mounted on document.body, so a re-render must not detach them.
 */

import { createMenuItem } from "@lib/ui/contextMenu";

export type AddMenuItem = (
  label: string,
  className: string,
  testId: string,
  onClick: (() => void) | null,
) => HTMLElement;

export function menuItemAdder(
  menu: HTMLElement,
  closeMenu: () => void,
  lifetimeSignal: AbortSignal,
): AddMenuItem {
  return (label, className, testId, onClick) => {
    const item = createMenuItem(label, className, { testId });
    if (onClick === null) {
      item.setAttribute("aria-disabled", "true");
      item.classList.add("disabled");
    } else {
      item.addEventListener(
        "click",
        () => {
          closeMenu();
          onClick();
        },
        { signal: lifetimeSignal },
      );
    }
    menu.appendChild(item);
    return item;
  };
}

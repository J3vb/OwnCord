/**
 * The row builder the channel and category context menus share: a `null`
 * `onClick` draws the row disabled, otherwise a click closes the menu before
 * it acts. Row listeners take the sidebar-lifetime signal: the menu is
 * mounted on document.body, so a re-render must not detach them.
 */

import { createMenuItem } from "@lib/ui/contextMenu";
import type { IconName } from "@lib/icons";

export type AddMenuItem = (
  label: string,
  className: string,
  testId: string,
  onClick: (() => void) | null,
  icon?: IconName,
) => HTMLElement;

export function menuItemAdder(
  menu: HTMLElement,
  closeMenu: () => void,
  lifetimeSignal: AbortSignal,
): AddMenuItem {
  return (label, className, testId, onClick, icon) => {
    const item = createMenuItem(label, className, {
      testId,
      ...(icon !== undefined ? { icon } : {}),
    });
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

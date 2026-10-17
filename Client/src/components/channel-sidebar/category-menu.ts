/**
 * Category header context menu: Mark Category as Read, Collapse/Expand
 * Category and Collapse All Categories. All three touch only the caller's own
 * read state and collapse preferences, so none needs a permission. Opened by
 * right-click on the header or, on its arrow button, Shift+F10 / the Menu key.
 *
 * The menu is mounted on document.body and shares the channel menu's class, so
 * opening either one removes the other.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setOwnedTimeout } from "@lib/dom";
import { getChannelsByCategory } from "@stores/channels.store";
import { collapseCategories, isCategoryCollapsed, toggleCategory } from "@stores/ui.store";
import { hasUnread, markChannelsRead } from "@lib/read-state";
import {
  createMenuItem,
  enableMenuKeyboard,
  openMenuOnKeyboard,
  clampMenuToViewport,
  registerSidebarMenu,
} from "@lib/context-menu";
import { shellText } from "../../i18n/shell";

/**
 * `signal` scopes the header-level listeners to the header's render owner;
 * `lifetimeSignal` is the sidebar's, and owns everything inside the opened
 * menu (mounted on document.body, so a re-render must not detach it).
 */
export function attachCategoryContextMenu(
  header: HTMLElement,
  keyboardTarget: HTMLElement,
  category: string,
  signal: AbortSignal,
  lifetimeSignal: AbortSignal,
): void {
  function openMenu(anchorX: number, anchorY: number): void {
    const menu = createElement("div", {
      class: "context-menu channel-ctx-menu category-ctx-menu",
      "data-testid": "category-context-menu",
    });
    menu.style.left = `${anchorX}px`;
    menu.style.top = `${anchorY}px`;

    const menuOwner = new Disposable();
    const closeMenu = (): void => {
      unregister();
      menu.remove();
      menuOwner.destroy();
    };
    const unregister = registerSidebarMenu(closeMenu);

    const addItem = (
      label: string,
      className: string,
      testId: string,
      onClick: (() => void) | null,
    ): void => {
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
    };

    // Read live: the group's element is reused across renders, so the rows it
    // was built with may be stale by the time the menu opens.
    const groups = getChannelsByCategory();
    const unreadIds = (groups.get(category) ?? [])
      .filter((ch) => ch.type !== "voice" && hasUnread(ch.id))
      .map((ch) => ch.id);
    addItem(
      shellText("category.markRead"),
      unreadIds.length > 0 ? "context-menu-item" : "context-menu-item disabled",
      "ctx-category-mark-read",
      unreadIds.length > 0 ? () => markChannelsRead(unreadIds) : null,
    );

    addItem(
      shellText(isCategoryCollapsed(category) ? "category.expand" : "category.collapse"),
      "context-menu-item",
      "ctx-category-toggle",
      () => toggleCategory(category),
    );

    const names = [...groups.keys()].filter((name): name is string => name !== null);
    addItem(
      shellText("category.collapseAll"),
      "context-menu-item",
      "ctx-category-collapse-all",
      () => collapseCategories(names),
    );

    document.body.appendChild(menu);
    clampMenuToViewport(menu, anchorX, anchorY);

    const restoreFocus = enableMenuKeyboard(menu, { signal: menuOwner.signal, onClose: closeMenu });
    menuOwner.addCleanup(restoreFocus);

    lifetimeSignal.addEventListener("abort", closeMenu, { signal: menuOwner.signal });
    setOwnedTimeout(
      menuOwner.signal,
      () => {
        document.addEventListener("click", closeMenu, { signal: menuOwner.signal });
      },
      0,
    );
  }

  header.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.clientX, e.clientY);
    },
    { signal },
  );

  openMenuOnKeyboard(keyboardTarget, openMenu, signal);
}

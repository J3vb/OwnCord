/**
 * Category header context menu: Mark Category as Read, Collapse/Expand
 * Category and Collapse All Categories touch only the caller's own read state
 * and collapse preferences, so none needs a permission. A MANAGE_CHANNELS
 * holder also gets Create Category and, on a real category (one with an id),
 * Rename, Move Up / Move Down and Delete; the entries are decided each
 * time the menu opens, from `canManageChannels` and from which callbacks the
 * page wired. Opened by right-click on the header or, on its arrow button,
 * Shift+F10 / the Menu key.
 *
 * The menu is mounted on document.body; opening any other menu closes it.
 */

import { createElement } from "@lib/dom";
import { getChannelsByCategory, type CategoryRef } from "@stores/channels.store";
import { canManageChannels, visibleCategories } from "@lib/permissions";
import { collapseCategories, isCategoryCollapsed, toggleCategory } from "@stores/ui.store";
import { hasUnread, markChannelsRead } from "@lib/read-state";
import { createMenuItem, openMenuOnKeyboard, openMenuShell } from "@lib/context-menu";
import { shellText } from "../../i18n/shell";
import { canMoveCategory } from "../../features/channels/categoryActions";

/** The header a menu belongs to: its group key (what collapse state is saved under) and category. */
export interface CategoryMenuTarget extends CategoryRef {
  readonly key: string;
}

/** The management callbacks the page wired; an absent one hides its entry. */
export interface CategoryMenuActions {
  readonly onCreateCategory?: (() => void) | undefined;
  readonly onRenameCategory?: ((category: CategoryRef) => void) | undefined;
  readonly onDeleteCategory?: ((category: CategoryRef) => void) | undefined;
  readonly onMoveCategory?: ((category: CategoryRef, direction: -1 | 1) => void) | undefined;
}

/**
 * `signal` scopes the header-level listeners to the header's render owner;
 * `lifetimeSignal` is the sidebar's, and owns everything inside the opened
 * menu (mounted on document.body, so a re-render must not detach it).
 */
export function attachCategoryContextMenu(
  header: HTMLElement,
  keyboardTarget: HTMLElement,
  target: CategoryMenuTarget,
  actions: CategoryMenuActions,
  signal: AbortSignal,
  lifetimeSignal: AbortSignal,
): void {
  function openMenu(anchorX: number, anchorY: number): void {
    openMenuShell({
      x: anchorX,
      y: anchorY,
      className: "channel-ctx-menu category-ctx-menu",
      attrs: { "data-testid": "category-context-menu" },
      signal: lifetimeSignal,
      dismiss: "any-click",
      build: (menu, closeMenu) => buildCategoryMenu(menu, closeMenu),
    });
  }

  function buildCategoryMenu(menu: HTMLElement, closeMenu: () => void): void {
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
    const category = target.key;
    const groups = getChannelsByCategory(visibleCategories());
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

    // Management: read now, like every other gate, so a role change is current.
    if (canManageChannels()) {
      const ref: CategoryRef = { id: target.id, name: target.name };
      const real = target.id > 0;
      const { onCreateCategory, onRenameCategory, onDeleteCategory, onMoveCategory } = actions;
      const manage: (() => void)[] = [];
      if (onCreateCategory !== undefined) {
        manage.push(() =>
          addItem(
            shellText("category.create"),
            "context-menu-item",
            "ctx-category-create",
            onCreateCategory,
          ),
        );
      }
      if (real && onRenameCategory !== undefined) {
        manage.push(() =>
          addItem(shellText("category.rename"), "context-menu-item", "ctx-category-rename", () =>
            onRenameCategory(ref),
          ),
        );
      }
      if (real && onMoveCategory !== undefined) {
        for (const [direction, label, testId] of [
          [-1, "category.moveUp", "ctx-category-move-up"],
          [1, "category.moveDown", "ctx-category-move-down"],
        ] as const) {
          const can = canMoveCategory(target.id, direction);
          manage.push(() =>
            addItem(
              shellText(label),
              can ? "context-menu-item" : "context-menu-item disabled",
              testId,
              can ? () => onMoveCategory(ref, direction) : null,
            ),
          );
        }
      }
      if (real && onDeleteCategory !== undefined) {
        manage.push(() =>
          addItem(
            shellText("category.delete"),
            "context-menu-item danger",
            "ctx-category-delete",
            () => onDeleteCategory(ref),
          ),
        );
      }
      if (manage.length > 0) {
        menu.appendChild(createElement("div", { class: "context-menu-sep" }));
        for (const add of manage) add();
      }
    }
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

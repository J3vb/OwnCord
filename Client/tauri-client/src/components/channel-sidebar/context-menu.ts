/**
 * Channel context menu — right-click on a channel for Edit/Delete actions.
 * Only shown to admin/owner roles.
 */

import { createElement } from "@lib/dom";
import type { Channel } from "@stores/channels.store";
import { getCurrentUser } from "@stores/auth.store";

/** Attach a right-click context menu to a channel element for edit/delete. */
export function attachChannelContextMenu(
  el: HTMLElement,
  channel: Channel,
  signal: AbortSignal,
  onEdit?: (channel: Channel) => void,
  onDelete?: (channel: Channel) => void,
): void {
  if (onEdit === undefined && onDelete === undefined) {
    return;
  }
  const user = getCurrentUser();
  const role = user?.role?.toLowerCase() ?? "";
  if (role !== "owner" && role !== "admin") {
    return;
  }

  el.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Remove any existing context menu
      document.querySelector(".channel-ctx-menu")?.remove();

      const menu = createElement("div", {
        class: "context-menu channel-ctx-menu",
        "data-testid": "channel-context-menu",
      });
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;

      if (onEdit !== undefined) {
        const editItem = createElement(
          "div",
          { class: "context-menu-item", "data-testid": "ctx-edit-channel" },
          "Edit Channel",
        );
        editItem.addEventListener(
          "click",
          () => {
            closeMenu();
            onEdit(channel);
          },
          { signal },
        );
        menu.appendChild(editItem);
      }

      if (onDelete !== undefined) {
        if (onEdit !== undefined) {
          menu.appendChild(createElement("div", { class: "context-menu-sep" }));
        }
        const deleteItem = createElement(
          "div",
          { class: "context-menu-item danger", "data-testid": "ctx-delete-channel" },
          "Delete Channel",
        );
        deleteItem.addEventListener(
          "click",
          () => {
            closeMenu();
            onDelete(channel);
          },
          { signal },
        );
        menu.appendChild(deleteItem);
      }

      document.body.appendChild(menu);

      // Close menu on click elsewhere — use a per-menu AbortController
      const menuAc = new AbortController();
      const closeMenu = (): void => {
        menu.remove();
        menuAc.abort();
      };
      signal.addEventListener("abort", () => menuAc.abort());
      // Defer so this click event doesn't immediately close it
      setTimeout(() => {
        if (menuAc.signal.aborted) return;
        document.addEventListener("click", closeMenu, { signal: menuAc.signal });
      }, 0);
    },
    { signal },
  );
}

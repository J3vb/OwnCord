/**
 * Channel context menu — right-click on a channel for Edit/Delete/Purge.
 * Edit and Delete are admin/owner-only; Purge follows the server's gate and
 * appears for any role holding MANAGE_MESSAGES.
 */

import { createElement } from "@lib/dom";
import type { Channel } from "@stores/channels.store";
import { getCurrentUser } from "@stores/auth.store";
import { hasPermission, currentUserPermissions } from "@lib/permissions";
import { Permission } from "@lib/types";
import { appendPurgeSection } from "@components/purge-prompt";

/** Attach a right-click context menu to a channel element for edit/delete/purge. */
export function attachChannelContextMenu(
  el: HTMLElement,
  channel: Channel,
  signal: AbortSignal,
  onEdit?: (channel: Channel) => void,
  onDelete?: (channel: Channel) => void,
  onPurge?: (channel: Channel, count: number) => Promise<void>,
): void {
  const user = getCurrentUser();
  const role = user?.role?.toLowerCase() ?? "";
  const isChannelAdmin = role === "owner" || role === "admin";

  // Voice channels hold no messages, and the server rejects a purge in a DM,
  // so the section is offered only where it can succeed.
  const canPurge =
    onPurge !== undefined &&
    channel.type !== "voice" &&
    hasPermission(currentUserPermissions(), Permission.MANAGE_MESSAGES);

  const showEdit = isChannelAdmin && onEdit !== undefined;
  const showDelete = isChannelAdmin && onDelete !== undefined;
  if (!showEdit && !showDelete && !canPurge) {
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

      if (showEdit && onEdit !== undefined) {
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

      if (showDelete && onDelete !== undefined) {
        if (showEdit) {
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

      if (canPurge && onPurge !== undefined) {
        appendPurgeSection(menu, {
          itemClass: "context-menu-item",
          dangerItemClass: "context-menu-item danger",
          separatorClass: showEdit || showDelete ? "context-menu-sep" : "",
          onPurge: (count) => onPurge(channel, count),
          signal,
          onDone: () => closeMenu(),
        });
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

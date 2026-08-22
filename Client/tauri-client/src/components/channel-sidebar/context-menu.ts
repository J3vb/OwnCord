/**
 * Channel context menu — right-click on a channel for Mark as Read/Edit/Delete/
 * Purge. Mark as Read is offered to everyone (it only touches the caller's own
 * read state); Edit and Delete follow the server's MANAGE_CHANNELS gate; Purge
 * follows its MANAGE_MESSAGES gate.
 *
 * Both gates are permission bits, not role names: a custom role granted
 * MANAGE_CHANNELS could edit a channel through the API while the client hid
 * the menu item, because the old check asked whether the role was literally
 * called "owner" or "admin".
 */

import { createElement } from "@lib/dom";
import type { Channel } from "@stores/channels.store";
import { hasPermission, currentUserPermissions, canManageChannels } from "@lib/permissions";
import { Permission } from "@lib/types";
import { markChannelRead, hasUnread } from "@lib/read-state";
import { isChannelMuted, toggleChannelMute } from "@lib/channel-mutes";
import { appendPurgeSection } from "@components/purge-prompt";

/** Bubbles from a channel row when its mute is toggled. */
export const CHANNEL_MUTE_CHANGED = "owncord:channel-mute-changed";

/**
 * Attach a right-click context menu to a channel element for edit/delete/purge.
 *
 * `signal` governs only the row-level `contextmenu` listener below, so it
 * dies with the row that created it on the next re-render (OC-0229).
 * `lifetimeSignal` is the sidebar's own factory-lifetime signal (aborted only
 * on sidebar destroy) and owns everything INSIDE the opened menu instead --
 * the menu is mounted on document.body, independent of the row's render, and
 * must not be torn down (or have its item clicks silently detached) by an
 * unrelated re-render (OC-0282).
 */
export function attachChannelContextMenu(
  el: HTMLElement,
  channel: Channel,
  signal: AbortSignal,
  lifetimeSignal: AbortSignal,
  onEdit?: (channel: Channel) => void,
  onDelete?: (channel: Channel) => void,
  onPurge?: (channel: Channel, count: number) => Promise<void>,
): void {
  const canManage = canManageChannels();

  // Voice channels hold no messages, and the server rejects a purge in a DM,
  // so the section is offered only where it can succeed.
  const canPurge =
    onPurge !== undefined &&
    channel.type !== "voice" &&
    hasPermission(currentUserPermissions(), Permission.MANAGE_MESSAGES);

  const showEdit = canManage && onEdit !== undefined;
  const showDelete = canManage && onDelete !== undefined;
  // Mark as Read touches only the caller's own read state, so it needs no
  // permission — but a voice channel holds no messages to read.
  const showMarkRead = channel.type !== "voice";
  // Muting silences notifications, which a voice channel does not produce.
  const showMute = channel.type !== "voice";
  if (!showMarkRead && !showMute && !showEdit && !showDelete && !canPurge) {
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

      if (showMarkRead) {
        // Disabled rather than hidden: a menu whose entries move between
        // right-clicks is harder to use than one with a greyed-out row.
        const unread = hasUnread(channel.id);
        const markItem = createElement(
          "div",
          {
            class: unread ? "context-menu-item" : "context-menu-item disabled",
            "data-testid": "ctx-mark-read",
          },
          "Mark as Read",
        );
        if (unread) {
          markItem.addEventListener(
            "click",
            () => {
              closeMenu();
              markChannelRead(channel.id);
            },
            { signal: lifetimeSignal },
          );
        }
        menu.appendChild(markItem);
      }

      if (showMute) {
        // "Until turned off": there is no timed mute, because a timed one needs
        // a stored expiry the client would have to sweep, and the affordance it
        // buys ("quiet for 8 hours") is one the user can reproduce by unmuting.
        const muted = isChannelMuted(channel.id);
        const muteItem = createElement(
          "div",
          { class: "context-menu-item", "data-testid": "ctx-mute-channel" },
          muted ? "Unmute Channel" : "Mute Channel",
        );
        muteItem.addEventListener(
          "click",
          () => {
            closeMenu();
            toggleChannelMute(channel.id);
            // Mute state lives in localStorage, so there is no store change to
            // subscribe to. A bubbling DOM event lets the sidebar redraw the
            // row without threading a callback through four layers of
            // positional render arguments.
            el.dispatchEvent(
              new CustomEvent(CHANNEL_MUTE_CHANGED, {
                bubbles: true,
                detail: { channelId: channel.id },
              }),
            );
          },
          { signal: lifetimeSignal },
        );
        menu.appendChild(muteItem);
      }

      if ((showMarkRead || showMute) && (showEdit || showDelete || canPurge)) {
        menu.appendChild(createElement("div", { class: "context-menu-sep" }));
      }

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
          { signal: lifetimeSignal },
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
          { signal: lifetimeSignal },
        );
        menu.appendChild(deleteItem);
      }

      if (canPurge && onPurge !== undefined) {
        appendPurgeSection(menu, {
          itemClass: "context-menu-item",
          dangerItemClass: "context-menu-item danger",
          separatorClass: showEdit || showDelete ? "context-menu-sep" : "",
          onPurge: (count) => onPurge(channel, count),
          signal: lifetimeSignal,
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
      // Tie this bridge listener's own lifetime to menuAc so it does not
      // outlive the menu it belongs to — closeMenu (which aborts menuAc)
      // already fires far more often than the sidebar's own teardown.
      // lifetimeSignal (not the per-render `signal`): the menu is mounted on
      // document.body, independent of the row that opened it, so an unrelated
      // re-render must not close it (OC-0282).
      lifetimeSignal.addEventListener("abort", closeMenu, { signal: menuAc.signal });
      // Defer so this click event doesn't immediately close it
      setTimeout(() => {
        if (menuAc.signal.aborted) return;
        document.addEventListener("click", closeMenu, { signal: menuAc.signal });
      }, 0);
    },
    { signal },
  );
}

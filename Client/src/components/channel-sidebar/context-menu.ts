/**
 * Channel context menu — right-click on a channel for Mark as Read/Move/Edit/
 * Delete/Purge. Mark as Read is offered to everyone (it only touches the
 * caller's own read state); Move, Edit and Delete follow the server's
 * MANAGE_CHANNELS gate; Purge follows its MANAGE_MESSAGES gate.
 *
 * Both gates are permission bits, not role names: a custom role granted
 * MANAGE_CHANNELS could edit a channel through the API while the client hid
 * the menu item, because the old check asked whether the role was literally
 * called "owner" or "admin".
 */

import { Disposable } from "@lib/disposable";
import { createElement, setOwnedTimeout } from "@lib/dom";
import { channelsStore, updateChannelPosition, type Channel } from "@stores/channels.store";
import { hasPermission, currentUserPermissions, canManageChannels } from "@lib/permissions";
import { Permission } from "@lib/types";
import { markChannelRead, hasUnread } from "@lib/read-state";
import { isChannelMuted, toggleChannelMute } from "@lib/channel-mutes";
import { createMenuItem, enableMenuKeyboard, openMenuOnKeyboard } from "@lib/context-menu";
import { appendPurgeSection } from "@components/purge-prompt";
import type { ChannelReorderData } from "../ChannelSidebar";
import { shellText } from "../../i18n/shell";

/** Bubbles from a channel row when its mute is toggled. */
export const CHANNEL_MUTE_CHANGED = "owncord:channel-mute-changed";

/** The close hook of the currently-open channel menu, so a same-class reopen
 *  can tear the previous menu's listeners down before removing it. */
let activeMenuClose: (() => void) | null = null;

/**
 * Attach a context menu to a channel element for mark-read/move/edit/delete/
 * purge. Opened by right-click or, on the focused row, Shift+F10 / the Menu
 * key (A11Y-01).
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
  channels?: readonly Channel[],
  onReorder?: (reorders: readonly ChannelReorderData[]) => void,
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
  // Keyboard reordering only makes sense with the row's own group at hand.
  const showMove = canManage && channels !== undefined && onReorder !== undefined;
  if (!showMarkRead && !showMute && !showEdit && !showDelete && !canPurge && !showMove) {
    return;
  }

  /** Build, mount and wire the menu at a viewport anchor. */
  function openMenu(anchorX: number, anchorY: number): void {
    // Remove any existing context menu (and run its close hook).
    activeMenuClose?.();
    document.querySelectorAll(".channel-ctx-menu").forEach((prev) => prev.remove());

    const menu = createElement("div", {
      class: "context-menu channel-ctx-menu",
      "data-testid": "channel-context-menu",
    });
    menu.style.left = `${anchorX}px`;
    menu.style.top = `${anchorY}px`;

    // Close menu on click elsewhere — use a per-menu Disposable
    const menuOwner = new Disposable();
    const closeMenu = (): void => {
      if (activeMenuClose === closeMenu) activeMenuClose = null;
      menu.remove();
      menuOwner.destroy();
    };
    activeMenuClose = closeMenu;

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

    if (showMarkRead) {
      // Disabled rather than hidden: a menu whose entries move between
      // right-clicks is harder to use than one with a greyed-out row.
      const unread = hasUnread(channel.id);
      addItem(
        shellText("channel.markRead"),
        unread ? "context-menu-item" : "context-menu-item disabled",
        "ctx-mark-read",
        unread ? () => markChannelRead(channel.id) : null,
      );
    }

    if (showMute) {
      // "Until turned off": there is no timed mute, because a timed one needs
      // a stored expiry the client would have to sweep, and the affordance it
      // buys ("quiet for 8 hours") is one the user can reproduce by unmuting.
      const muted = isChannelMuted(channel.id);
      addItem(
        shellText(muted ? "channel.unmute" : "channel.mute"),
        "context-menu-item",
        "ctx-mute-channel",
        () => {
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
      );
    }

    if (showMove && channels !== undefined && onReorder !== undefined) {
      const live = channelsStore.getState().channels;
      const group = channels
        .map((c) => live.get(c.id))
        .filter((c): c is Channel => c !== undefined);
      const index = group.findIndex((c) => c.id === channel.id);
      // Swap positions with the adjacent row. `group` is position-sorted, so
      // this is the same visual move a drag onto that row produces. Equal
      // positions (newly created channels share 0) get nudged apart.
      const move = (delta: number): void => {
        const self = group[index];
        const other = group[index + delta];
        if (self === undefined || other === undefined) return;
        const mine = self.position;
        let theirs = other.position;
        if (theirs === mine) theirs = mine + delta;
        updateChannelPosition(self.id, theirs);
        updateChannelPosition(other.id, mine);
        onReorder([
          { channelId: self.id, newPosition: theirs },
          { channelId: other.id, newPosition: mine },
        ]);
      };
      addItem(
        shellText("channel.moveUp"),
        "context-menu-item",
        "ctx-move-up",
        index > 0 ? () => move(-1) : null,
      );
      addItem(
        shellText("channel.moveDown"),
        "context-menu-item",
        "ctx-move-down",
        index !== -1 && index < group.length - 1 ? () => move(1) : null,
      );
    }

    if ((showMarkRead || showMute || showMove) && (showEdit || showDelete || canPurge)) {
      menu.appendChild(createElement("div", { class: "context-menu-sep" }));
    }

    if (showEdit && onEdit !== undefined) {
      addItem(shellText("channel.edit"), "context-menu-item", "ctx-edit-channel", () =>
        onEdit(channel),
      );
    }

    if (showDelete && onDelete !== undefined) {
      if (showEdit) {
        menu.appendChild(createElement("div", { class: "context-menu-sep" }));
      }
      addItem(shellText("channel.delete"), "context-menu-item danger", "ctx-delete-channel", () =>
        onDelete(channel),
      );
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

    // Focus the first item on open; Escape/close restores focus to the row.
    const restoreFocus = enableMenuKeyboard(menu, { signal: menuOwner.signal, onClose: closeMenu });
    menuOwner.addCleanup(restoreFocus);

    // Tie this bridge listener's own lifetime to menuOwner so it does not
    // outlive the menu it belongs to — closeMenu (which aborts menuOwner)
    // already fires far more often than the sidebar's own teardown.
    // lifetimeSignal (not the per-render `signal`): the menu is mounted on
    // document.body, independent of the row that opened it, so an unrelated
    // re-render must not close it (OC-0282).
    lifetimeSignal.addEventListener("abort", closeMenu, { signal: menuOwner.signal });
    // Defer so this click event doesn't immediately close it
    setOwnedTimeout(
      menuOwner.signal,
      () => {
        document.addEventListener(
          "mousedown",
          (e) => {
            if (!menu.contains(e.target as Node)) closeMenu();
          },
          { signal: menuOwner.signal },
        );
      },
      0,
    );
  }

  el.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.clientX, e.clientY);
    },
    { signal },
  );

  // Keyboard entry point (A11Y-01): Shift+F10 / Menu key on the focused row.
  openMenuOnKeyboard(el, openMenu, signal);
}

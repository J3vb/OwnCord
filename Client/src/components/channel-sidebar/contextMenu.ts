/**
 * Channel context menu — right-click on a channel for Mark as Read/Copy Link/
 * Invite People/Move/Edit/Delete/Purge. Mark as Read is offered to everyone (it
 * only touches the caller's own read state); Move, Edit and Delete follow the server's
 * MANAGE_CHANNELS gate; Purge follows its MANAGE_MESSAGES gate.
 *
 * Both gates are permission bits, not role names: a custom role granted
 * MANAGE_CHANNELS could edit a channel through the API while the client hid
 * the menu item, because the old check asked whether the role was literally
 * called "owner" or "admin".
 */

import { createElement } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import type { Channel } from "@stores/channels.store";
import {
  hasPermission,
  currentUserPermissions,
  canManageChannels,
  canManageInvites,
} from "@lib/permissions";
import { Permission } from "@lib/types";
import type { ChannelAccess } from "../../features/channels/channelRow.view";
import { formatChannelLink } from "@lib/nav/deepLink";
import { navigateToChannel } from "@lib/nav/channelNavigation";
import { markChannelRead, showsUnreadBadge } from "@lib/readState";
import {
  getChannelMute,
  muteChannel,
  unmuteChannel,
  getChannelMutesHost,
} from "@lib/prefs/channelMutes";
import {
  createMenuItem,
  createSubmenuTrigger,
  openMenuOnKeyboard,
  openMenuShell,
} from "@lib/ui/contextMenu";
import {
  NOTIFICATION_LEVELS,
  effectiveNotificationLevel,
  getChannelNotificationLevel,
  setChannelNotificationLevel,
  type NotificationLevel,
} from "@lib/prefs/notificationLevel";
import { appendPurgeSection } from "@components/purgePrompt";
import { copyWithToast, isDeveloperMode } from "../../features/developer-mode/developerTools";
import type { ChannelReorderData } from "../ChannelSidebar";
import { shellText } from "../../i18n/shell";
import { muteChoices, mutedUntilLabel } from "../muteMenu";
import { channelMoves } from "../../features/channels/channelMoves";

const log = createLogger("channel-menu");

const LEVEL_KEYS = {
  all: "channel.notify.all",
  mentions: "channel.notify.mentions",
  nothing: "channel.notify.nothing",
} as const satisfies Record<NotificationLevel, string>;

/** Bubbles from a channel row when its mute is toggled. Re-exported from the
 *  mute store, which dispatches it on every write (F16). */
export { CHANNEL_MUTE_CHANGED } from "@lib/prefs/channelMutes";

/**
 * Attach a context menu to a channel element for mark-read/move/edit/delete/
 * purge. Opened by right-click or, on the focused row, Shift+F10 / the Menu
 * key (A11Y-01).
 *
 * `signal` governs only the row-level `contextmenu` listener below, so it
 * dies with the row that created it on the next re-render.
 * `lifetimeSignal` is the sidebar's own factory-lifetime signal (aborted only
 * on sidebar destroy) and owns everything INSIDE the opened menu instead --
 * the menu is mounted on document.body, independent of the row's render, and
 * must not be torn down (or have its item clicks silently detached) by an
 * unrelated re-render.
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
  onInvite?: (channel: Channel) => void,
  /** What the role may do, decided by the caller (the sidebar's row model);
   *  omitted, each entry reads the stores here. */
  access?: ChannelAccess,
): void {
  const canManage = access?.manageChannels ?? canManageChannels();

  // Voice channels hold no messages, and the server rejects a purge in a DM,
  // so the section is offered only where it can succeed.
  const canPurge =
    onPurge !== undefined &&
    channel.type !== "voice" &&
    (access?.manageMessages ?? hasPermission(currentUserPermissions(), Permission.MANAGE_MESSAGES));

  const showEdit = canManage && onEdit !== undefined;
  const showDelete = canManage && onDelete !== undefined;
  // Mark as Read touches only the caller's own read state, so it needs no
  // permission — but a voice channel holds no messages to read.
  // A forum holds no messages either, so it has no unread state to clear.
  const showMarkRead = channel.type !== "voice" && channel.type !== "forum";
  // Muting silences notifications, which a voice channel does not produce.
  const showMute = channel.type !== "voice";
  // Keyboard reordering only makes sense with the row's own group at hand.
  const showMove = canManage && channels !== undefined && onReorder !== undefined;
  // Invite People opens the invite manager, which only MANAGE_INVITES holders
  // can list or create from; the server enforces the same bit.
  const showInvite = onInvite !== undefined && (access?.manageInvites ?? canManageInvites());
  // The link opens the channel's message view, so a voice channel has none to
  // offer (joining one is a click on its row, not a link).
  const showCopyLink = channel.type !== "voice";
  // A voice channel's chat opens without joining; clicking the row
  // still joins.
  const showOpenChat = channel.type === "voice";
  const hasEntries =
    showOpenChat ||
    showMarkRead ||
    showMute ||
    showEdit ||
    showDelete ||
    canPurge ||
    showMove ||
    showCopyLink ||
    showInvite;

  /** A phone gets the menu as a bottom sheet, loaded on the first long-press. */
  function openSheet(): void {
    import("./channelSheet").then(
      ({ openChannelSheet }) => {
        if (lifetimeSignal.aborted) return;
        openChannelSheet({
          channel,
          show: {
            openChat: showOpenChat,
            markRead: showMarkRead,
            mute: showMute,
            copyLink: showCopyLink,
            invite: showInvite,
            move: showMove,
            edit: showEdit,
            delete: showDelete,
            purge: canPurge,
          },
          ...(onEdit !== undefined ? { onEdit } : {}),
          ...(onDelete !== undefined ? { onDelete } : {}),
          ...(onPurge !== undefined ? { onPurge } : {}),
          ...(onInvite !== undefined ? { onInvite } : {}),
          ...(channels !== undefined ? { channels } : {}),
          ...(onReorder !== undefined ? { onReorder } : {}),
          signal: lifetimeSignal,
          fallbackFocus: () => (el.isConnected ? el : null),
        });
      },
      (err: unknown) => log.warn("Channel sheet failed to open", { error: String(err) }),
    );
  }

  /** Build, mount and wire the menu at a viewport anchor. */
  function openMenu(anchorX: number, anchorY: number): void {
    if (isPhoneLayout()) {
      openSheet();
      return;
    }
    // lifetimeSignal (not the per-render `signal`): the menu is mounted on
    // document.body, independent of the row that opened it, so an unrelated
    // re-render must not close it.
    openMenuShell({
      x: anchorX,
      y: anchorY,
      className: "channel-ctx-menu",
      attrs: { "data-testid": "channel-context-menu" },
      signal: lifetimeSignal,
      dismiss: "any-click",
      build: (menu, closeMenu) => buildChannelMenu(menu, closeMenu),
    });
  }

  function buildChannelMenu(menu: HTMLElement, closeMenu: () => void): void {
    const addItem = (
      label: string,
      className: string,
      testId: string,
      onClick: (() => void) | null,
    ): HTMLElement => {
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

    if (showOpenChat) {
      addItem(shellText("channel.openChat"), "context-menu-item", "ctx-open-chat", () =>
        navigateToChannel(channel.id),
      );
    }

    if (showMarkRead) {
      // Disabled rather than hidden: a menu whose entries move between
      // right-clicks is harder to use than one with a greyed-out row.
      const unread = showsUnreadBadge(channel.id);
      addItem(
        shellText("channel.markRead"),
        unread ? "context-menu-item" : "context-menu-item disabled",
        "ctx-mark-read",
        unread ? () => markChannelRead(channel.id) : null,
      );
    }

    if (showMute) {
      // A mute is a read-time check on a stored expiry (`channel-mutes`), so a
      // timed one needs no sweep for the gates to be right.
      const mute = getChannelMute(channel.id);
      if (mute !== null) {
        const row = addItem(
          shellText("channel.unmute"),
          "context-menu-item",
          "ctx-mute-channel",
          () => unmuteChannel(channel.id),
        );
        const until = mutedUntilLabel(mute.until);
        if (until !== null) {
          row.appendChild(createElement("span", { class: "context-menu-item__detail" }, until));
        }
      } else {
        // Clicking the row (or Enter) mutes until turned off, as Discord does;
        // hovering or ArrowRight offers the timed choices.
        const { trigger, flyout } = createSubmenuTrigger(
          shellText("channel.mute"),
          "context-menu-item",
          {
            testId: "ctx-mute-channel",
            activates: true,
            onActivate: () => {
              closeMenu();
              muteChannel(channel.id);
            },
          },
          lifetimeSignal,
        );
        for (const choice of muteChoices()) {
          const row = createMenuItem(choice.label, "context-menu-item", {
            testId: choice.testId,
          });
          row.addEventListener(
            "click",
            () => {
              closeMenu();
              muteChannel(channel.id, choice.durationMs);
            },
            { signal: lifetimeSignal },
          );
          flyout.appendChild(row);
        }
        menu.append(trigger, flyout);
      }
    }

    if (showMute) {
      // Notification Settings ›: the channel's own level, or the server's.
      // Only the flyout rows act; the row itself just opens them.
      const own = getChannelNotificationLevel(channel.id);
      const { trigger, flyout } = createSubmenuTrigger(
        shellText("channel.notifySettings"),
        "context-menu-item",
        { testId: "ctx-notify-settings" },
        lifetimeSignal,
      );
      const addLevelRow = (
        label: string,
        level: NotificationLevel | null,
        testId: string,
      ): void => {
        const row = createMenuItem(label, "context-menu-item", { testId });
        row.setAttribute("role", "menuitemradio");
        row.setAttribute("aria-checked", String(own === level));
        row.addEventListener(
          "click",
          () => {
            closeMenu();
            setChannelNotificationLevel(channel.id, level);
          },
          { signal: lifetimeSignal },
        );
        flyout.appendChild(row);
      };
      addLevelRow(
        shellText("channel.notify.default", {
          level: shellText(LEVEL_KEYS[effectiveNotificationLevel()]),
        }),
        null,
        "ctx-notify-default",
      );
      for (const level of NOTIFICATION_LEVELS) {
        addLevelRow(shellText(LEVEL_KEYS[level]), level, `ctx-notify-${level}`);
      }
      menu.append(trigger, flyout);
    }

    if (showCopyLink) {
      addItem(shellText("channel.copyLink"), "context-menu-item", "ctx-copy-channel-link", () =>
        copyWithToast(
          formatChannelLink(channel.id, getChannelMutesHost() ?? ""),
          "toast.channelLinkCopied",
          "toast.channelLinkCopyFailed",
        ),
      );
    }

    if (showInvite && onInvite !== undefined) {
      addItem(shellText("channel.invite"), "context-menu-item", "ctx-invite-people", () =>
        onInvite(channel),
      );
    }

    if (showMove && channels !== undefined && onReorder !== undefined) {
      const { up, down } = channelMoves(channel, channels, onReorder);
      addItem(shellText("channel.moveUp"), "context-menu-item", "ctx-move-up", up);
      addItem(shellText("channel.moveDown"), "context-menu-item", "ctx-move-down", down);
    }

    if (isDeveloperMode()) {
      addItem(shellText("channel.copyId"), "context-menu-item", "ctx-copy-channel-id", () =>
        copyWithToast(String(channel.id), "toast.channelIdCopied", "toast.channelIdCopyFailed"),
      );
    }

    if (
      (showOpenChat || showMarkRead || showMute || showMove || showCopyLink || showInvite) &&
      (showEdit || showDelete || canPurge)
    ) {
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
  }

  el.addEventListener(
    "contextmenu",
    (e) => {
      // Developer Mode adds Copy Channel ID, so even a bare row has a menu then.
      if (!hasEntries && !isDeveloperMode()) return;
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.clientX, e.clientY);
    },
    { signal },
  );

  // Keyboard entry point (A11Y-01): Shift+F10 / Menu key on the focused row.
  openMenuOnKeyboard(el, openMenu, signal, () => hasEntries || isDeveloperMode());
}

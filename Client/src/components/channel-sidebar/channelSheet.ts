/**
 * The channel menu as a bottom sheet, for a long-press on a phone. It offers
 * what the right-click menu offers (contextMenu.ts decides which entries the
 * caller may see and passes the answer in), laid out by `menuSheet`: Mute
 * Channel and Notification Settings open a second page in the sheet instead of
 * a hover flyout.
 *
 * Loaded on the first long-press, so the sheet's code stays out of the
 * sidebar's chunk.
 */

import type { Channel } from "@stores/channels.store";
import { navigateToChannel } from "@lib/nav/channelNavigation";
import { formatChannelLink } from "@lib/nav/deepLink";
import { markChannelRead, showsUnreadBadge } from "@lib/readState";
import {
  getChannelMute,
  getChannelMutesHost,
  muteChannel,
  unmuteChannel,
} from "@lib/prefs/channelMutes";
import {
  NOTIFICATION_LEVELS,
  effectiveNotificationLevel,
  getChannelNotificationLevel,
  setChannelNotificationLevel,
  type NotificationLevel,
} from "@lib/prefs/notificationLevel";
import type { ContextMenuItem, ContextMenuSeparator } from "@lib/ui/contextMenu";
import { appendPurgeSection } from "@components/purgePrompt";
import { copyWithToast, isDeveloperMode } from "../../features/developer-mode/developerTools";
import type { ChannelReorderData } from "../ChannelSidebar";
import { openMenuSheet } from "../menuSheet";
import { muteChoices, mutedUntilLabel } from "../muteMenu";
import { shellText } from "../../i18n/shell";
import { channelMoves } from "./channelMoves";

const LEVEL_KEYS = {
  all: "channel.notify.all",
  mentions: "channel.notify.mentions",
  nothing: "channel.notify.nothing",
} as const satisfies Record<NotificationLevel, string>;

export interface ChannelSheetRequest {
  readonly channel: Channel;
  /** Which entries this user may see; the same answers the right-click menu uses. */
  readonly show: {
    readonly openChat: boolean;
    readonly markRead: boolean;
    readonly mute: boolean;
    readonly copyLink: boolean;
    readonly invite: boolean;
    readonly move: boolean;
    readonly edit: boolean;
    readonly delete: boolean;
    readonly purge: boolean;
  };
  readonly onEdit?: (channel: Channel) => void;
  readonly onDelete?: (channel: Channel) => void;
  readonly onPurge?: (channel: Channel, count: number) => Promise<void>;
  readonly onInvite?: (channel: Channel) => void;
  /** The channel's category, for Move Up and Move Down. */
  readonly channels?: readonly Channel[];
  readonly onReorder?: (reorders: readonly ChannelReorderData[]) => void;
  /** The sidebar's lifetime: the sheet is not tied to the row that opened it. */
  readonly signal: AbortSignal;
  readonly fallbackFocus: () => HTMLElement | null;
}

/** The sheet's rows, read from the stores as they are now. */
function channelSheetItems(req: ChannelSheetRequest): (ContextMenuItem | ContextMenuSeparator)[] {
  const { channel, show } = req;
  const top: ContextMenuItem[] = [];

  if (show.openChat) {
    top.push({
      label: shellText("channel.openChat"),
      testId: "ctx-open-chat",
      onClick: () => navigateToChannel(channel.id),
    });
  }

  if (show.markRead) {
    // Disabled rather than hidden, as in the right-click menu.
    const unread = showsUnreadBadge(channel.id);
    top.push({
      label: shellText("channel.markRead"),
      testId: "ctx-mark-read",
      disabled: !unread,
      onClick: () => markChannelRead(channel.id),
    });
  }

  if (show.mute) {
    const mute = getChannelMute(channel.id);
    if (mute !== null) {
      const until = mutedUntilLabel(mute.until);
      top.push({
        label: shellText("channel.unmute"),
        testId: "ctx-mute-channel",
        ...(until !== null ? { detail: until } : {}),
        onClick: () => unmuteChannel(channel.id),
      });
    } else {
      // A tap opens the choices; "Until I turn it back on" is the last of them.
      top.push({
        label: shellText("channel.mute"),
        testId: "ctx-mute-channel",
        onClick: () => muteChannel(channel.id),
        submenu: muteChoices().map((choice) => ({
          label: choice.label,
          testId: choice.testId,
          onClick: () => muteChannel(channel.id, choice.durationMs),
        })),
      });
    }

    const own = getChannelNotificationLevel(channel.id);
    const levelRow = (
      label: string,
      level: NotificationLevel | null,
      testId: string,
    ): ContextMenuItem => ({
      label,
      testId,
      checked: own === level,
      radio: true,
      onClick: () => setChannelNotificationLevel(channel.id, level),
    });
    top.push({
      label: shellText("channel.notifySettings"),
      testId: "ctx-notify-settings",
      onClick: () => undefined,
      submenu: [
        levelRow(
          shellText("channel.notify.default", {
            level: shellText(LEVEL_KEYS[effectiveNotificationLevel()]),
          }),
          null,
          "ctx-notify-default",
        ),
        ...NOTIFICATION_LEVELS.map((level) =>
          levelRow(shellText(LEVEL_KEYS[level]), level, `ctx-notify-${level}`),
        ),
      ],
    });
  }

  if (show.copyLink) {
    top.push({
      label: shellText("channel.copyLink"),
      testId: "ctx-copy-channel-link",
      onClick: () =>
        copyWithToast(
          formatChannelLink(channel.id, getChannelMutesHost() ?? ""),
          "toast.channelLinkCopied",
          "toast.channelLinkCopyFailed",
        ),
    });
  }

  const onInvite = req.onInvite;
  if (show.invite && onInvite !== undefined) {
    top.push({
      label: shellText("channel.invite"),
      testId: "ctx-invite-people",
      onClick: () => onInvite(channel),
    });
  }

  if (show.move && req.channels !== undefined && req.onReorder !== undefined) {
    const moves = channelMoves(channel, req.channels, req.onReorder);
    const { up, down } = moves;
    top.push(
      {
        label: shellText("channel.moveUp"),
        testId: "ctx-move-up",
        disabled: up === null,
        onClick: () => up?.(),
      },
      {
        label: shellText("channel.moveDown"),
        testId: "ctx-move-down",
        disabled: down === null,
        onClick: () => down?.(),
      },
    );
  }

  if (isDeveloperMode()) {
    top.push({
      label: shellText("channel.copyId"),
      testId: "ctx-copy-channel-id",
      onClick: () =>
        copyWithToast(String(channel.id), "toast.channelIdCopied", "toast.channelIdCopyFailed"),
    });
  }

  const manage: ContextMenuItem[] = [];
  const onEdit = req.onEdit;
  if (show.edit && onEdit !== undefined) {
    manage.push({
      label: shellText("channel.edit"),
      testId: "ctx-edit-channel",
      onClick: () => onEdit(channel),
    });
  }
  const onDelete = req.onDelete;
  if (show.delete && onDelete !== undefined) {
    manage.push({
      label: shellText("channel.delete"),
      testId: "ctx-delete-channel",
      danger: true,
      onClick: () => onDelete(channel),
    });
  }

  return top.length > 0 && manage.length > 0
    ? [...top, { separator: true }, ...manage]
    : [...top, ...manage];
}

export function openChannelSheet(req: ChannelSheetRequest): void {
  const { channel } = req;
  const onPurge = req.onPurge;
  openMenuSheet({
    items: channelSheetItems(req),
    label: shellText("channel.sheetLabel", { name: channel.name }),
    testId: "channel-sheet",
    signal: req.signal,
    fallbackFocus: req.fallbackFocus,
    ...(req.show.purge && onPurge !== undefined
      ? {
          footer: (card: HTMLElement, close: () => void, signal: AbortSignal): void => {
            appendPurgeSection(card, {
              itemClass: "msg-sheet-action",
              dangerItemClass: "msg-sheet-action danger",
              separatorClass: "",
              onPurge: (count) => onPurge(channel, count),
              signal,
              onDone: close,
            });
            // Plain buttons in a sheet, not rows of a menu.
            for (const el of card.querySelectorAll('[role="menuitem"]')) {
              el.removeAttribute("role");
              el.removeAttribute("tabindex");
            }
          },
        }
      : {}),
  });
}

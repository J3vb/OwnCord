/**
 * Pure builders for the text channel row and category group models: the
 * inputs in, the drawn values out. No builder reads a store, a preference or
 * the mute list; the sidebar hands them a `ChannelListInputs` snapshot and the
 * injected `isMuted`, and `tests/unit/channel-row-model.test.ts` runs them
 * under the store-read guard. `isMuted` is not a store, so the guard cannot see
 * it: no builder may import `lib/channel-mutes`.
 *
 * Voice channels share the one keyed list. Their wrapper keeps its own chrome
 * model (`voiceRowModel.ts`); `VoiceChannelRowModel` here is only what makes
 * the wrapper rebuild: the create-only chrome and the handler bindings.
 */

import { categoryGroups, groupLabel } from "../../stores/channels.store";
import type { Channel, ChannelsState } from "../../stores/channels.store";
import { mutedRowHidden } from "../../lib/hide-muted-channels";
import {
  hasPermission,
  memberHasPermissionIn,
  permissionsForMemberIn,
} from "../../lib/permissions";
import { Permission } from "../../lib/types";
import type { FollowedThreadRow } from "../../stores/followedThreads.store";
import type {
  CategoryGroupModel,
  ChannelAccess,
  TextChannelRowModel,
  ThreadMoreRowModel,
  ThreadRowModel,
} from "./channelRow.view";
import type { VoiceRowInputs } from "./voiceRowModel";

export type { ChannelAccess };

/** Everything the channel list draws from, as one snapshot. */
export interface ChannelListInputs {
  /** `channelsStore.channels` (identity). */
  readonly channels: ReadonlyMap<number, Channel>;
  readonly activeChannelId: number | null;
  /** The signed-in user's role name; "" when signed out. */
  readonly selfRole: string;
  /** Every role the signed-in user holds (identity); undefined on an older
   *  server, where `selfRole` is the only role. Permissions are their OR. */
  readonly selfRoleIds?: readonly number[] | undefined;
  /** The role list from `ready` (identity). */
  readonly roles: ChannelsState["roles"];
  /** `channelsStore.categories` (identity): the manager's list, empty for everyone else. */
  readonly categories: ChannelsState["categories"];
  /** `uiStore.collapsedCategories` (identity). */
  readonly collapsed: ReadonlySet<string>;
  /** The Hide Muted Channels preference. */
  readonly hideMuted: boolean;
  /** A fresh token per mute event: `isMuted` answers differ after it. */
  readonly mute: object;
  /** `followedThreadsStore.byParent` (identity): open followed threads under each parent. */
  readonly threads: ReadonlyMap<number, readonly FollowedThreadRow[]>;
  /** The thread open in the side panel, or null. */
  readonly focusedThreadId: number | null;
}

/** What the builders need beyond the snapshot, injected by the sidebar. */
export interface ChannelListContext {
  /** Whether a channel is muted (`isChannelMuted`). */
  readonly isMuted: (channelId: number) => boolean;
  /** The page wired the category "+" (`onCreateChannel`). */
  readonly canCreate: boolean;
  /** The page wired reordering (`onReorderChannel`). */
  readonly canReorder: boolean;
  /** The page wired category reordering (`onReorderCategory`). */
  readonly canReorderCategories: boolean;
}

/** One category's channels in display order. */
export type ChannelGroup = {
  /**
   * The group's key: `cat:<id>` for a real category (so a rename keeps it), the
   * category name on a server that sends no ids, the synthetic Voice key, or
   * null for uncategorized text. Collapse state is saved under it.
   */
  readonly key: string | null;
  /** The category's name; null for the uncategorized group. */
  readonly name: string | null;
  /** The category's id; 0 for a group that is not a real category. */
  readonly categoryId: number;
  readonly channels: readonly Channel[];
  readonly orderIds: string;
};

/** A voice channel's wrapper: what rebuilds it. `active`, `muted` and `unread`
 *  are not drawn on it; the capacity and the mention badge are chrome patches
 *  (`updateVoiceRow`), so a mention never rebuilds the roster. */
export type VoiceChannelRowModel = {
  readonly kind: "voice";
  readonly channelId: number;
  readonly name: string;
  readonly nsfw: boolean;
  readonly private: boolean;
  /** Drawn on the wrapper by the drag handlers. */
  readonly draggable: boolean;
  /** Not drawn: a reorder must rebind the drag and Move handlers. */
  readonly orderIds: string;
  /** Not drawn: decides which menu entries the wrapper binds. */
  readonly access: ChannelAccess;
};

export type ChannelRowModel = TextChannelRowModel | VoiceChannelRowModel;

/** Every row the keyed list holds: a channel, a followed thread, or a parent's "N more". */
export type SidebarRowModel = ChannelRowModel | ThreadRowModel | ThreadMoreRowModel;

/** What one row of the keyed list stands for. */
export type SidebarEntry =
  | { readonly kind: "channel"; readonly channel: Channel }
  | { readonly kind: "thread"; readonly row: FollowedThreadRow }
  | { readonly kind: "threadMore"; readonly parentId: number; readonly count: number };

/** Followed threads shown under a parent before the rest fold into "N more". */
export const MAX_THREAD_ROWS = 5;

/** Row key: channel ids, thread ids and "more" rows never collide. */
export function entryKey(e: SidebarEntry): string {
  if (e.kind === "channel") return String(e.channel.id);
  return e.kind === "thread" ? `t${e.row.id}` : `m${e.parentId}`;
}

type Occupancy = Pick<VoiceRowInputs, "voiceUsers" | "currentChannelId">;

/** The role's channel permissions. `manageMessages` has no legacy owner/admin
 *  fallback, exactly as the Purge gate has always read it; the other two do. */
export function channelAccess(
  list: Pick<ChannelListInputs, "roles" | "selfRole" | "selfRoleIds">,
): ChannelAccess {
  const { roles, selfRole, selfRoleIds } = list;
  return {
    manageChannels: memberHasPermissionIn(roles, selfRoleIds, selfRole, Permission.MANAGE_CHANNELS),
    manageMessages: hasPermission(
      permissionsForMemberIn(roles, selfRoleIds, selfRole) ?? 0,
      Permission.MANAGE_MESSAGES,
    ),
    manageInvites: memberHasPermissionIn(roles, selfRoleIds, selfRole, Permission.MANAGE_INVITES),
  };
}

/** One entry per group, in sidebar order (D7); the null key is the uncategorized
 *  group. A manager's empty categories are groups with no channels. */
export function channelGroups(
  list: Pick<ChannelListInputs, "channels" | "categories" | "roles" | "selfRole" | "selfRoleIds">,
): ChannelGroup[] {
  // The list is the managers'; a viewer who lost MANAGE_CHANNELS mid-session
  // still holds it in the store, so it only counts while the role has the bit.
  const categories = channelAccess(list).manageChannels ? list.categories : [];
  return categoryGroups(list.channels, categories).map((g) => ({
    ...g,
    orderIds: g.channels.map((c) => c.id).join(","),
  }));
}

/** Whether a voice channel has people in it, or is the one you are connected to. */
function occupied(voice: Occupancy, channelId: number): boolean {
  return voice.currentChannelId === channelId || (voice.voiceUsers.get(channelId)?.size ?? 0) > 0;
}

/** Whether a text-style row has unread messages; voice rows never do. */
function rowIsUnread(channel: Channel): boolean {
  return channel.type !== "voice" && channel.unreadCount > 0;
}

/**
 * Whether a channel row still shows under a collapsed category: the channel
 * you are viewing, any mention (muted or not, a mention always shows), an
 * unread row that is not muted, and voice channels you are in or that have
 * people in them (Discord parity, so a live call stays visible).
 */
function rowVisibleWhenCollapsed(
  channel: Channel,
  activeChannelId: number | null,
  voice: Occupancy,
  ctx: ChannelListContext,
): boolean {
  if (channel.id === activeChannelId) return true;
  if (channel.mentionCount > 0) return true;
  if (channel.type === "voice") return occupied(voice, channel.id);
  return rowIsUnread(channel) && !ctx.isMuted(channel.id);
}

/**
 * A group's rows that show: Hide Muted Channels drops muted rows here, not
 * from `g.channels`, so the header (kept even when every row is hidden) and
 * the drag-reorder maths still see the whole category; a collapsed category
 * keeps only the rows `rowVisibleWhenCollapsed` allows.
 */
export function visibleRows(
  g: ChannelGroup,
  list: ChannelListInputs,
  voice: Occupancy,
  ctx: ChannelListContext,
): Channel[] {
  const collapsed = g.key !== null && list.collapsed.has(g.key);
  return g.channels.filter(
    (ch) =>
      !mutedRowHidden(
        ch,
        list.activeChannelId,
        list.hideMuted,
        ctx.isMuted(ch.id),
        occupied(voice, ch.id),
      ) &&
      (!collapsed || rowVisibleWhenCollapsed(ch, list.activeChannelId, voice, ctx)),
  );
}

/**
 * The keyed list for a group: each shown channel, followed by its open followed
 * threads (newest activity first, at most `MAX_THREAD_ROWS`, then an "N more"
 * row). A collapsed category shows none, and a parent that is not shown (hidden
 * muted, collapsed away) shows none. A voice channel has no threads. A parent
 * absent from `list.channels` (it became unreadable) has no row to hang them on.
 */
export function sidebarEntries(
  shown: readonly Channel[],
  g: ChannelGroup,
  list: ChannelListInputs,
): SidebarEntry[] {
  const collapsed = g.key !== null && list.collapsed.has(g.key);
  return shown.flatMap((channel): SidebarEntry[] => {
    const threads =
      collapsed || channel.type === "voice" ? undefined : list.threads.get(channel.id);
    if (threads === undefined || threads.length === 0) return [{ kind: "channel", channel }];
    const rows: SidebarEntry[] = threads
      .slice(0, MAX_THREAD_ROWS)
      .map((row) => ({ kind: "thread", row }));
    if (threads.length > MAX_THREAD_ROWS) {
      rows.push({
        kind: "threadMore",
        parentId: channel.id,
        count: threads.length - MAX_THREAD_ROWS,
      });
    }
    return [{ kind: "channel", channel }, ...rows];
  });
}

/** A followed thread's row model: it looks as quiet or as loud as its parent. */
function threadRowModel(
  row: FollowedThreadRow,
  list: ChannelListInputs,
  ctx: ChannelListContext,
): ThreadRowModel {
  const muted = ctx.isMuted(row.parentId);
  return {
    kind: "thread",
    threadId: row.id,
    parentId: row.parentId,
    name: row.name,
    active: row.id === list.focusedThreadId,
    unread: row.unread > 0 && (!muted || row.mentions > 0),
    mentionCount: row.mentions,
    muted,
  };
}

/** The model of any row in the keyed list. */
export function sidebarRowModel(
  entry: SidebarEntry,
  g: ChannelGroup,
  list: ChannelListInputs,
  ctx: ChannelListContext,
): SidebarRowModel {
  if (entry.kind === "channel") return channelRowModel(entry.channel, g, list, ctx);
  if (entry.kind === "thread") return threadRowModel(entry.row, list, ctx);
  return { kind: "threadMore", parentId: entry.parentId, count: entry.count };
}

/** A group header's model. The uncategorized group draws nothing but its
 *  container, so every drawn field is forced to its neutral value. */
export function categoryGroupModel(
  g: ChannelGroup,
  list: ChannelListInputs,
  ctx: ChannelListContext,
): CategoryGroupModel {
  if (g.key === null || g.name === null) {
    return {
      key: null,
      name: null,
      categoryId: 0,
      label: "",
      collapsed: false,
      showCreate: false,
      draggable: false,
    };
  }
  return {
    key: g.key,
    name: g.name,
    categoryId: g.categoryId,
    label: groupLabel(g),
    collapsed: list.collapsed.has(g.key),
    showCreate: ctx.canCreate && channelAccess(list).manageChannels,
    // Only a real category has a place in the order to move.
    draggable: ctx.canReorderCategories && g.categoryId > 0 && channelAccess(list).manageChannels,
  };
}

/** One row's model: text and announcement draw it all, a voice wrapper only
 *  the part that rebuilds it. */
export function channelRowModel(
  channel: Channel,
  g: ChannelGroup,
  list: ChannelListInputs,
  ctx: ChannelListContext,
): ChannelRowModel {
  const access = channelAccess(list);
  const draggable = access.manageChannels && ctx.canReorder;
  if (channel.type === "voice") {
    return {
      kind: "voice",
      channelId: channel.id,
      name: channel.name,
      nsfw: channel.nsfw,
      private: channel.isPrivate,
      draggable,
      orderIds: g.orderIds,
      access,
    };
  }
  const muted = ctx.isMuted(channel.id);
  return {
    kind: channel.type === "announcement" || channel.type === "forum" ? channel.type : "text",
    channelId: channel.id,
    name: channel.name,
    nsfw: channel.nsfw,
    private: channel.isPrivate,
    active: channel.id === list.activeChannelId,
    // A muted channel is quiet: no bold name and no pill for plain unread.
    // A mention is addressed to the reader, so it still lights the row.
    unread: rowIsUnread(channel) && (!muted || channel.mentionCount > 0),
    mentionCount: channel.mentionCount,
    muted,
    draggable,
    orderIds: g.orderIds,
    access,
  };
}

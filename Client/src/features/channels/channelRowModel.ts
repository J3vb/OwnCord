/**
 * Pure builders for the text channel row and category group models (5.4d): the
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

import { groupChannelsByCategory, categoryLabel } from "../../stores/channels.store";
import type { Channel, ChannelsState } from "../../stores/channels.store";
import { mutedRowHidden } from "../../lib/hide-muted-channels";
import { hasPermission, permissionsForRoleIn, roleHasPermissionIn } from "../../lib/permissions";
import { Permission } from "../../lib/types";
import type { CategoryGroupModel, ChannelAccess, TextChannelRowModel } from "./channelRow.view";
import type { VoiceRowInputs } from "./voiceRowModel";

export type { ChannelAccess };

/** Everything the channel list draws from, as one snapshot. */
export interface ChannelListInputs {
  /** `channelsStore.channels` (identity). */
  readonly channels: ReadonlyMap<number, Channel>;
  readonly activeChannelId: number | null;
  /** The signed-in user's role name; "" when signed out. */
  readonly selfRole: string;
  /** The role list from `ready` (identity). */
  readonly roles: ChannelsState["roles"];
  /** `uiStore.collapsedCategories` (identity). */
  readonly collapsed: ReadonlySet<string>;
  /** The Hide Muted Channels preference. */
  readonly hideMuted: boolean;
  /** A fresh token per mute event: `isMuted` answers differ after it. */
  readonly mute: object;
}

/** What the builders need beyond the snapshot, injected by the sidebar. */
export interface ChannelListContext {
  /** Whether a channel is muted (`isChannelMuted`). */
  readonly isMuted: (channelId: number) => boolean;
  /** The page wired the category "+" (`onCreateChannel`). */
  readonly canCreate: boolean;
  /** The page wired reordering (`onReorderChannel`). */
  readonly canReorder: boolean;
}

/** One category's channels in display order. */
export type ChannelGroup = {
  /** Category name, or null for the uncategorized group. */
  readonly name: string | null;
  readonly channels: readonly Channel[];
  readonly orderIds: string;
};

/** A voice channel's wrapper: what rebuilds it. `active`, `muted` and
 *  `unread` are not drawn on it (the mention count is), and the capacity is a chrome
 *  patch (`updateVoiceRow`). */
export type VoiceChannelRowModel = {
  readonly kind: "voice";
  readonly channelId: number;
  readonly name: string;
  readonly nsfw: boolean;
  readonly private: boolean;
  /** Drawn on the wrapper by the drag handlers. */
  readonly draggable: boolean;
  /** Drawn as the mention badge; unread is never drawn on a voice row. */
  readonly mentionCount: number;
  /** Not drawn: a reorder must rebind the drag and Move handlers. */
  readonly orderIds: string;
  /** Not drawn: decides which menu entries the wrapper binds. */
  readonly access: ChannelAccess;
};

export type ChannelRowModel = TextChannelRowModel | VoiceChannelRowModel;

type Occupancy = Pick<VoiceRowInputs, "voiceUsers" | "currentChannelId">;

/** The role's channel permissions. `manageMessages` has no legacy owner/admin
 *  fallback, exactly as the Purge gate has always read it; the other two do. */
export function channelAccess(list: Pick<ChannelListInputs, "roles" | "selfRole">): ChannelAccess {
  return {
    manageChannels: roleHasPermissionIn(list.roles, list.selfRole, Permission.MANAGE_CHANNELS),
    manageMessages: hasPermission(
      permissionsForRoleIn(list.roles, list.selfRole) ?? 0,
      Permission.MANAGE_MESSAGES,
    ),
    manageInvites: roleHasPermissionIn(list.roles, list.selfRole, Permission.MANAGE_INVITES),
  };
}

/** One entry per category, in the map's order; the null name is the
 *  uncategorized group. */
export function channelGroups(list: Pick<ChannelListInputs, "channels">): ChannelGroup[] {
  const groups: ChannelGroup[] = [];
  for (const [name, channels] of groupChannelsByCategory(list.channels)) {
    groups.push({ name, channels, orderIds: channels.map((c) => c.id).join(",") });
  }
  return groups;
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
  const collapsed = g.name !== null && list.collapsed.has(g.name);
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

/** A group header's model. The uncategorized group draws nothing but its
 *  container, so every drawn field is forced to its neutral value. */
export function categoryGroupModel(
  g: ChannelGroup,
  list: ChannelListInputs,
  ctx: ChannelListContext,
): CategoryGroupModel {
  if (g.name === null) return { name: null, label: "", collapsed: false, showCreate: false };
  return {
    name: g.name,
    label: categoryLabel(g.name),
    collapsed: list.collapsed.has(g.name),
    showCreate: ctx.canCreate && channelAccess(list).manageChannels,
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
      mentionCount: channel.mentionCount,
      draggable,
      orderIds: g.orderIds,
      access,
    };
  }
  const muted = ctx.isMuted(channel.id);
  return {
    kind: channel.type === "announcement" ? "announcement" : "text",
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

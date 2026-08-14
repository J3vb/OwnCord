/**
 * Single entry point for "open this channel", so every affordance that can
 * navigate (sidebar item, quick switcher, #channel link in a message) clears
 * the same badges and leaves the app in the same state.
 */

import { setActiveChannel, clearUnread, channelsStore } from "@stores/channels.store";
import { clearDmUnread, dmStore, dmDisplayName } from "@stores/dm.store";
// lib -> pages import: addDmToChannelsStore is the only place that
// synthesizes a DM's channelsStore mirror row. dispatcher.ts already crosses
// this same boundary for exactly this reason (see its DM_CHANNEL_CLOSE
// handler) — a DM that `ready` reported in dmStore but that the user has not
// yet opened this session has no mirror row until one of these two call
// sites creates it.
import { addDmToChannelsStore } from "@pages/main-page/SidebarDmHelpers";

/**
 * Activate `channelId`, clearing its unread and mention badges.
 *
 * A channel absent from channelsStore is not necessarily invisible to the
 * user: a DM's row there is only synthesized on open (addDmToChannelsStore),
 * while dmStore carries every DM the user is a member of from the moment
 * `ready` lands. Fall back to dmStore and synthesize the mirror row so a
 * jump (permalink, search hit, pinned, reply) into a DM the user has not
 * clicked yet this session still lands, instead of degrading as if the
 * channel did not exist. True no-op only when neither store has it: the
 * caller resolved an id that no longer exists, and blanking the active
 * channel would be worse than staying put.
 */
export function navigateToChannel(channelId: number): void {
  if (!channelsStore.getState().channels.has(channelId)) {
    const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
    if (dm === undefined) return;
    addDmToChannelsStore(dm);
  }
  setActiveChannel(channelId);
  clearUnread(channelId);
  // findChannelById does not filter out DM mirrors, so a jump (permalink,
  // search, pinned, reply) can land on a `type: "dm"` channel. Its unread
  // badge lives in dmStore, not channelsStore — clearUnread alone leaves the
  // DM sidebar row lit while the user is reading it. No-op for a non-DM id
  // (dmStore has no matching channel), mirroring markChannelRead's dual
  // clear (read-state.ts).
  clearDmUnread(channelId);
}

/**
 * Resolve a visible channel by id, for affordances that carry an id rather
 * than a name (message permalinks). Returns null when the channel is not in
 * this user's channel list — a permalink to somewhere they cannot see must
 * degrade quietly, not render a chip that goes nowhere.
 *
 * Falls back to dmStore when channelsStore has no row: a DM's channelsStore
 * mirror is synthesized only on open (addDmToChannelsStore), but dmStore
 * already knows every DM the user belongs to from `ready`. Without this, a
 * jump into a DM never opened this session reads as "not visible" even
 * though the user is a member and the server will happily serve its
 * messages.
 */
export function findChannelById(channelId: number): { id: number; name: string } | null {
  const ch = channelsStore.getState().channels.get(channelId);
  if (ch !== undefined) return { id: ch.id, name: ch.name };
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  return dm === undefined ? null : { id: dm.channelId, name: dmDisplayName(dm) };
}

/**
 * Resolve a channel by name (case-insensitive), as written in a `#name` token.
 * DM channels are excluded — they are addressed through the DM sidebar and
 * have no user-visible `#name`.
 */
export function findChannelByName(name: string): { id: number; name: string } | null {
  const wanted = name.toLowerCase();
  for (const ch of channelsStore.getState().channels.values()) {
    if (ch.type === "dm") continue;
    if (ch.name.toLowerCase() === wanted) return { id: ch.id, name: ch.name };
  }
  return null;
}

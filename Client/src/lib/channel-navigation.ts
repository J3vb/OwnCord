/**
 * Single entry point for "open this channel", so every affordance that can
 * navigate (sidebar item, quick switcher, #channel link in a message) clears
 * the same badges and leaves the app in the same state.
 */

import {
  setActiveChannel,
  clearUnread,
  channelsStore,
  getChannelsByCategory,
} from "@stores/channels.store";
import { addDmToChannelsStore, clearDmUnread, dmStore, dmDisplayName } from "@stores/dm.store";
import { isCategoryCollapsed } from "@stores/ui.store";
import { hasUnread } from "./read-state";

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
export function findChannelById(
  channelId: number,
): { id: number; name: string; isDm: boolean } | null {
  const ch = channelsStore.getState().channels.get(channelId);
  if (ch !== undefined) return { id: ch.id, name: ch.name, isDm: ch.type === "dm" };
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  return dm === undefined ? null : { id: dm.channelId, name: dmDisplayName(dm), isDm: true };
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

/**
 * The channels Alt+↑/↓ steps through, in the order they appear on screen:
 * the grouped channel list (categories as headers, rows by position), with
 * collapsed categories' hidden rows skipped. Voice channels are skipped too:
 * opening one means joining the call, which a keyboard step must never do,
 * and a bare setActiveChannel would mount its chat unjoined (F8).
 */
function navigableChannelIds(): number[] {
  const ids: number[] = [];
  for (const [category, channels] of getChannelsByCategory()) {
    if (category !== null && isCategoryCollapsed(category)) continue;
    for (const ch of channels) if (ch.type !== "voice") ids.push(ch.id);
  }
  return ids;
}

/**
 * DP-35: Alt+↑/↓ moves to the previous or next channel, Alt+Shift+↑/↓ to the
 * previous or next unread channel. `direction` is 1 (down/next) or -1
 * (up/previous); the steps wrap at the ends, matching Discord.
 *
 * Unread is what a badge counts (`hasUnread`): an unread or mention count in
 * either store. No-op when nothing matches — an up step with the active
 * channel already at the top, or an unread step when nothing is unread.
 */
export function stepChannel(direction: 1 | -1, unreadOnly = false): void {
  const ids = navigableChannelIds();
  if (ids.length === 0) return;
  const current = channelsStore.getState().activeChannelId;
  const from = current === null ? (direction === 1 ? -1 : 0) : ids.indexOf(current);
  // An active channel that is not in the list (a DM, or a channel filtered
  // out) steps from the edge rather than bailing: Alt+↓ from a DM lands on the
  // first channel, Alt+↑ on the last.
  const start = from === -1 ? (direction === 1 ? -1 : ids.length) : from;
  for (let step = 1; step <= ids.length; step++) {
    const idx = (((start + direction * step) % ids.length) + ids.length) % ids.length;
    const id = ids[idx]!;
    if (!unreadOnly || hasUnread(id)) {
      navigateToChannel(id);
      return;
    }
  }
}

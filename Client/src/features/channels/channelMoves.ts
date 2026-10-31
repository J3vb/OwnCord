/**
 * Move Up / Move Down for a channel: the swap with the neighbour of the same
 * kind. The right-click menu and the phone sheet both offer it, so the rule
 * lives here once.
 */

import { channelsStore, updateChannelPosition, type Channel } from "../../stores/channels.store";
import type { ChannelReorderData } from "../../components/ChannelSidebar";

export interface ChannelMoves {
  /** Null when the channel is already first in its group. */
  readonly up: (() => void) | null;
  /** Null when the channel is already last in its group. */
  readonly down: (() => void) | null;
}

/**
 * The moves available to `channel` among `channels` (its category's rows),
 * read from the channels store as it is now.
 */
export function channelMoves(
  channel: Channel,
  channels: readonly Channel[],
  onReorder: (reorders: readonly ChannelReorderData[]) => void,
): ChannelMoves {
  const live = channelsStore.getState().channels;
  // Text rows sit above voice rows in a category, so a move only swaps
  // with the neighbour of the same kind; crossing the boundary would swap
  // positions without changing what the user sees.
  const isVoice = channel.type === "voice";
  const group = channels
    .map((c) => live.get(c.id))
    .filter((c): c is Channel => c !== undefined && (c.type === "voice") === isVoice);
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
      { channelId: self.id, newPosition: theirs, previousPosition: mine },
      { channelId: other.id, newPosition: mine, previousPosition: other.position },
    ]);
  };
  return {
    up: index > 0 ? () => move(-1) : null,
    down: index !== -1 && index < group.length - 1 ? () => move(1) : null,
  };
}

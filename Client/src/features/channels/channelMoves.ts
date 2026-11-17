/**
 * Move Up / Move Down for a channel: the swap with the neighbour of the same
 * kind. The right-click menu and the phone sheet both offer it, so the rule
 * lives here once.
 */

import { channelsStore, type Channel } from "../../stores/channels.store";
import type { ChannelReorderData } from "./channelSidebarTypes";
import { applyOptimistic, planNeighbourSwap } from "./sidebar/dragPlan";

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
  // The same slot assignment a drag onto the neighbour makes, so rows that
  // share a position (newly created channels) are nudged apart rather than
  // jumping several places.
  const move = (delta: number): void => {
    const reorders = planNeighbourSwap(group, index, delta);
    if (reorders.length === 0) return;
    applyOptimistic(reorders);
    onReorder(reorders);
  };
  return {
    up: index > 0 ? () => move(-1) : null,
    down: index !== -1 && index < group.length - 1 ? () => move(1) : null,
  };
}

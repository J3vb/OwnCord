/**
 * Single entry point for "open this channel", so every affordance that can
 * navigate (sidebar item, quick switcher, #channel link in a message) clears
 * the same badges and leaves the app in the same state.
 */

import { setActiveChannel, clearUnread, channelsStore } from "@stores/channels.store";

/**
 * Activate `channelId`, clearing its unread and mention badges.
 *
 * No-op for an id the channel store does not know: the caller resolved a name
 * that no longer exists, and blanking the active channel would be worse than
 * staying put.
 */
export function navigateToChannel(channelId: number): void {
  if (!channelsStore.getState().channels.has(channelId)) return;
  setActiveChannel(channelId);
  clearUnread(channelId);
}

/**
 * Resolve a visible channel by id, for affordances that carry an id rather
 * than a name (message permalinks). Returns null when the channel is not in
 * this user's channel list — a permalink to somewhere they cannot see must
 * degrade quietly, not render a chip that goes nowhere.
 */
export function findChannelById(channelId: number): { id: number; name: string } | null {
  const ch = channelsStore.getState().channels.get(channelId);
  return ch === undefined ? null : { id: ch.id, name: ch.name };
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

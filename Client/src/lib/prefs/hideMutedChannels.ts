/**
 * "Hide Muted Channels" — a per-device channel-list display preference, like
 * Discord's server-menu toggle.
 *
 * While on, a muted channel drops out of the channel list and out of the
 * Alt+Arrow channel steps (the Quick Switcher still finds it). A mute is still
 * "stop telling me about the chatter", so a muted row stays when something
 * needs it: it is the channel being viewed, it holds an unread mention, or it
 * is a voice channel with people in it (or the one you are in).
 *
 * The preference is a plain device-wide boolean under the shared settings
 * prefix; `savePref` announces the change on `owncord:pref-change`, which the
 * sidebar redraws on. "Is it muted" is the one source the dimmed row already
 * uses, `isChannelMuted`.
 */

import { isChannelMuted } from "./channelMutes";
import { loadPref, savePref } from "./preferences";
import type { Channel } from "@stores/channels.store";

/** localStorage key (under the shared settings prefix). */
export const HIDE_MUTED_CHANNELS_KEY = "hideMutedChannels";

/** Whether muted channels are currently hidden from the channel list. */
export function isHideMutedChannels(): boolean {
  return loadPref<boolean>(HIDE_MUTED_CHANNELS_KEY, false);
}

/** Turn the preference on or off. */
export function setHideMutedChannels(hide: boolean): void {
  savePref(HIDE_MUTED_CHANNELS_KEY, hide);
}

/**
 * Whether the channel list leaves `channel` out because it is muted. False
 * when the preference is off, for an unmuted channel, and for the exceptions
 * above. `activeChannelId` is the channel being viewed. `voiceOccupied` says
 * whether a voice channel has people in it; it is a parameter so this module
 * stays free of the voice store (the channel-step code reaches it without
 * pulling the voice and auth stores in, and never offers a voice row anyway).
 * Without it, a muted voice channel counts as empty.
 */
export function hiddenByMute(
  channel: Channel,
  activeChannelId: number | null,
  voiceOccupied: (channelId: number) => boolean = () => false,
): boolean {
  if (!isHideMutedChannels() || !isChannelMuted(channel.id)) return false;
  return mutedRowHidden(
    channel,
    activeChannelId,
    true,
    true,
    channel.type === "voice" && voiceOccupied(channel.id),
  );
}

/**
 * `hiddenByMute` over values the caller already holds (the preference, the
 * mute, whether the voice channel has people), so a builder fed by a snapshot
 * reads nothing itself. `voiceOccupied` only matters for a voice channel.
 */
export function mutedRowHidden(
  channel: Channel,
  activeChannelId: number | null,
  hide: boolean,
  muted: boolean,
  voiceOccupied: boolean,
): boolean {
  if (!hide || !muted) return false;
  if (channel.id === activeChannelId || channel.mentionCount > 0) return false;
  return !(channel.type === "voice" && voiceOccupied);
}

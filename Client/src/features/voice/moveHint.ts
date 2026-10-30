/**
 * The channel a moderator just moved this client to (voice_moved), so the
 * voice UI sounds can play the moved tone for that connect instead of the
 * join one. Its own leaf module: the dispatcher's voice handlers are in the
 * startup chunk, the sounds are not.
 */

import { registerSessionReset } from "@lib/net/sessionRegistry";

let pendingMoveChannelId: number | null = null;

/** A moderator moved this client to `channelId`. */
export function noteVoiceMoved(channelId: number): void {
  pendingMoveChannelId = channelId;
}

/** Whether a move is noted and not yet settled. */
export function isVoiceMovePending(): boolean {
  return pendingMoveChannelId !== null;
}

/** Whether the connect to `channelId` is the move noted above; clears the note
 *  either way, since any connect or teardown settles it. */
export function takeVoiceMoved(channelId: number | null): boolean {
  const moved = channelId !== null && pendingMoveChannelId === channelId;
  pendingMoveChannelId = null;
  return moved;
}

let pendingAfkChannelId: number | null = null;

/** The AFK sweep moved this client to `channelId`; its toast waits for the
 *  join to be acknowledged. A newer move replaces an older one. */
export function noteAfkMove(channelId: number): void {
  pendingAfkChannelId = channelId;
}

/** Whether `channelId` is the noted AFK move. Any self join acknowledgement
 *  settles the note, so one for a different channel (the user clicked away
 *  first) does not leave it to fire on a later manual join. */
export function takeAfkMove(channelId: number): boolean {
  const matched = pendingAfkChannelId === channelId;
  pendingAfkChannelId = null;
  return matched;
}

/** Forget a noted AFK move whose join was refused, abandoned or superseded. */
export function clearAfkMove(): void {
  pendingAfkChannelId = null;
}

void registerSessionReset(
  "voice:move-hint",
  () => {
    pendingMoveChannelId = null;
    pendingAfkChannelId = null;
  },
  { phase: "cache" },
); // app-lifetime

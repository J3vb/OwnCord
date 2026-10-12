/**
 * The channel a moderator just moved this client to (voice_moved), so the
 * voice UI sounds can play the moved tone for that connect instead of the
 * join one. Its own leaf module: the dispatcher's voice handlers are in the
 * startup chunk, the sounds are not.
 */

let pendingMoveChannelId: number | null = null;

/** A moderator moved this client to `channelId`. */
export function noteVoiceMoved(channelId: number): void {
  pendingMoveChannelId = channelId;
}

/** Whether the connect to `channelId` is the move noted above; clears the note
 *  either way, since any connect or teardown settles it. */
export function takeVoiceMoved(channelId: number | null): boolean {
  const moved = channelId !== null && pendingMoveChannelId === channelId;
  pendingMoveChannelId = null;
  return moved;
}

/**
 * 1:1 DMs closed locally while their call is live.
 *
 * Closing a conversation hides its row, which takes the DM out of `dmStore`.
 * The voice reconnect loop (`canKeepRetrying`) treats a channel that is
 * neither a server channel nor a known DM as gone and gives up, so a network
 * blip after the close would end a call the user never left. Remembering the
 * closed channel here lets the loop keep retrying for as long as that call is
 * the live voice session.
 *
 * Only a local close of a 1:1 is recorded. Leaving a group is a membership
 * change the server enforces (it evicts the leaver from the call), so a group
 * never lands in this set and its call still ends.
 *
 * Session scoped: pruned when the voice session leaves the channel, and
 * cleared on sign-out.
 */

import { registerSessionReset } from "@lib/net/sessionRegistry";
import { voiceStore } from "@stores/voice.store";

const kept = new Set<number>();
let stopPruning: (() => void) | null = null;

/**
 * Prune on every edge of the voice channel: once the session is elsewhere or
 * gone, the closed DM has nothing left to keep alive. Subscribed only while
 * something is kept, so loading this module touches no store.
 */
function startPruning(): void {
  if (stopPruning !== null) return;
  stopPruning = voiceStore.subscribeSelector(
    (state) => state.currentChannelId,
    (current) => {
      for (const id of kept) if (id !== current) kept.delete(id);
      if (kept.size === 0) stopPruning?.();
      if (kept.size === 0) stopPruning = null;
    },
  );
}

/** Remember a just-closed 1:1 DM whose call is the live voice session. */
export function keepDmForCall(channelId: number): void {
  if (voiceStore.getState().currentChannelId !== channelId) return;
  kept.add(channelId);
  startPruning();
}

/** Forget one channel (the server refused the close, so the DM is back). */
export function releaseKeptDm(channelId: number): void {
  kept.delete(channelId);
}

/** True while the closed 1:1's call is still the live session. */
export function isDmKeptForCall(channelId: number): boolean {
  return kept.has(channelId) && voiceStore.getState().currentChannelId === channelId;
}

/** Forget everything (sign-out, tests). */
export function resetKeptCallDms(): void {
  kept.clear();
  stopPruning?.();
  stopPruning = null;
}

void registerSessionReset("dm:kept-calls", resetKeptCallDms, { phase: "session" }); // app-lifetime reset hook, registered at module load

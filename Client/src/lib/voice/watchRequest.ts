// Remembers the envelope ids of voice_watch frames just sent, so an error
// reply to one (a server from before 6.6 does not know the type) is dropped
// instead of toasting: the watch list is a courtesy to the streamer, never
// something the viewer must be told failed.
import { registerSessionReset } from "../net/sessionRegistry";

/** Few are ever in flight; a stale id is dropped from the front. */
const MAX_PENDING = 16;
const pending: string[] = [];

/** Records the envelope id of the voice_watch just sent. */
export function noteWatchSent(id: string | undefined): void {
  if (id === undefined) return;
  pending.push(id);
  if (pending.length > MAX_PENDING) pending.shift();
}

/** True (and consumed) when this error answers a voice_watch we sent. */
export function takeWatchRefusal(id: string | undefined): boolean {
  if (id === undefined) return false;
  const at = pending.indexOf(id);
  if (at < 0) return false;
  pending.splice(at, 1);
  return true;
}

/** Test seam: forget every pending id. */
export function resetWatchRequest(): void {
  pending.length = 0;
}

// App-lifetime: ids belong to one socket, so a session end forgets them.
void registerSessionReset("voice:watch-request", resetWatchRequest, { phase: "voice" });

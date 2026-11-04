/**
 * Where a share from another app waits for its composer. The "Send to" sheet
 * hands the share here and opens the channel; that channel's composer takes it
 * when it mounts, or at once when it is already open. One share waits at a
 * time: a newer one replaces it, and one no composer took within a minute
 * (the channel never opened) is dropped, so it never turns up in a chat
 * opened much later.
 */

import { registerSessionReset } from "@lib/net/sessionRegistry";
import type { ReceivedShare } from "../../platform/contracts/shareSheet";

/** How long a share waits for its channel's composer. */
export const SHARE_WAIT_MS = 60_000;

interface Inbox {
  readonly channelId: number;
  readonly accept: (share: ReceivedShare) => void;
}

/** Mounted composers, oldest first; each removes itself when it goes. */
const inboxes: Inbox[] = [];
let waiting: {
  readonly channelId: number;
  readonly share: ReceivedShare;
  readonly at: number;
} | null = null;

// Module-lifetime: a share waiting for a channel of the server just left
// must not land in a channel of the next one.
void registerSessionReset("share-inbox", () => {
  waiting = null;
});

/** Hand `share` to the composer of `channelId`: now when it is mounted, else when it mounts. */
export function sendShareTo(channelId: number, share: ReceivedShare, now = Date.now()): void {
  const inbox = inboxes.findLast((i) => i.channelId === channelId);
  if (inbox !== undefined) {
    waiting = null;
    inbox.accept(share);
    return;
  }
  waiting = { channelId, share, at: now };
}

/** A mounted composer of `channelId` takes the shares sent to it, a waiting
 *  one first. The returned release removes only this composer. */
export function acceptSharesFor(
  channelId: number,
  accept: (share: ReceivedShare) => void,
  now = Date.now(),
): () => void {
  const inbox: Inbox = { channelId, accept };
  inboxes.push(inbox);
  const held = waiting;
  if (held !== null && (held.channelId === channelId || now - held.at > SHARE_WAIT_MS)) {
    waiting = null;
    if (held.channelId === channelId && now - held.at <= SHARE_WAIT_MS) accept(held.share);
  }
  return () => {
    const index = inboxes.indexOf(inbox);
    if (index !== -1) inboxes.splice(index, 1);
  };
}

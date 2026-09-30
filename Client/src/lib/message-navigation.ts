/**
 * Single entry point for "jump to this message", mirroring channel-navigation.
 *
 * Every affordance that can jump — a search hit, a pinned entry, a reply bar,
 * an `owncord://message/…` permalink pasted into chat, a permalink opened from
 * the OS — routes through jumpToMessage so they all share one implementation:
 * open the channel if needed, fetch the around-window when the target is not
 * loaded, scroll to it and flash it.
 *
 * The real implementation lives in the main page (it needs the API client and
 * the mounted MessageList), so it registers itself here at mount time. Before
 * registration — and in unit tests that never mount a page — jumping is a
 * logged no-op rather than a crash.
 */

import { createLogger } from "./logger";
import { getChannelMutesHost } from "./channel-mutes";

const log = createLogger("message-nav");

export type MessageJumpHandler = (channelId: number, messageId: number) => void;

let handler: MessageJumpHandler | null = null;

/**
 * A deep link / notification click that arrived before the main page was live
 * (a Windows toast launching the app on cold start, before any MainPage has
 * registered a handler and while the host is not yet known). Exactly one target
 * is retained — the last click wins, as the user's latest intent — and it is
 * dropped at handoff if it named a different server than the one now signed in.
 */
let pending: { channelId: number; messageId: number; host?: string } | null = null;

/**
 * The cross-server guard: a source that named a `host` may only open when it
 * matches the signed-in server (or the signed-in server is not known yet, in
 * which case the target is buffered instead of dropped). A link that named no
 * server — a permalink pasted into chat — is always opened.
 */
function mayOpenNow(host: string | undefined): boolean {
  if (host === undefined) return true;
  const signedIn = getChannelMutesHost();
  return signedIn === null || host === signedIn;
}

/**
 * Install the jump implementation. Returns an unregister function; calling it
 * only clears the handler if it is still the one installed here, so a late
 * teardown cannot wipe a newer page's handler. A click buffered before any
 * handler existed is flushed once, after the registering page finishes its
 * synchronous mount (the handler is installed before the page's channel
 * controller exists), if that page is still registered and the target may
 * open against the server then signed in.
 */
export function setMessageJumpHandler(fn: MessageJumpHandler): () => void {
  handler = fn;
  const held = pending;
  pending = null;
  if (held !== null) {
    queueMicrotask(() => {
      if (handler === fn && mayOpenNow(held.host)) fn(held.channelId, held.messageId);
    });
  }
  return () => {
    if (handler === fn) handler = null;
  };
}

/** Jump to a message. Buffered until a page registers a handler. */
export function jumpToMessage(channelId: number, messageId: number, host?: string): void {
  if (handler === null) {
    pending = { channelId, messageId, host };
    log.debug("Jump requested with no handler registered — buffered", { channelId, messageId });
    return;
  }
  if (!mayOpenNow(host)) {
    log.debug("Message target from another server ignored", { host });
    return;
  }
  handler(channelId, messageId);
}

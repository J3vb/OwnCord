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

const log = createLogger("message-nav");

export type MessageJumpHandler = (channelId: number, messageId: number) => void;

let handler: MessageJumpHandler | null = null;

/**
 * Install the jump implementation. Returns an unregister function; calling it
 * only clears the handler if it is still the one installed here, so a late
 * teardown cannot wipe a newer page's handler.
 */
export function setMessageJumpHandler(fn: MessageJumpHandler): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/** Jump to a message. No-op (logged) when no page has registered a handler. */
export function jumpToMessage(channelId: number, messageId: number): void {
  if (handler === null) {
    log.debug("Jump requested with no handler registered", { channelId, messageId });
    return;
  }
  handler(channelId, messageId);
}

/** Whether a jump would currently reach a handler. Used by tests and guards. */
export function hasMessageJumpHandler(): boolean {
  return handler !== null;
}

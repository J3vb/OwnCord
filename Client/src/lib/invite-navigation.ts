/**
 * Single entry point for "join the server this invite names", mirroring
 * message-navigation: an `owncord://invite/…` link pasted into chat reaches the
 * app shell's invite flow (app/deepLinks.ts) without components importing the entry.
 * Before a handler registers — and in unit tests that never boot the shell —
 * the request is a no-op.
 */

export type InviteJoinHandler = (code: string, host?: string) => void;

let handler: InviteJoinHandler | null = null;

/** Install the invite flow. Returns an unregister that only clears its own handler. */
export function setInviteJoinHandler(fn: InviteJoinHandler): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/** Run the invite flow for `code` (and the server `host` it names, if any). */
export function requestInviteJoin(code: string, host?: string): void {
  handler?.(code, host);
}

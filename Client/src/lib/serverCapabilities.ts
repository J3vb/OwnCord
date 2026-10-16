/**
 * What the connected server said it supports, from the last full `ready`.
 *
 * `ready` is the only frame that carries `capabilities`, and several places
 * that are far from the socket need one answer ("does this server keep a read
 * pointer?"). A store would be reactive for nothing: every reader asks at the
 * moment it acts. The dispatcher is the only writer, per session: its cleanup
 * resets this, so a different server never inherits the previous one's
 * answer. Until a full `ready` arrives every capability reads false, and so
 * does one a server leaves out.
 */

/** The last full `ready`'s capabilities; null until one arrives. */
let caps: { readonly read_pointer?: boolean } | null = null;

/** Record the capabilities of a full `ready`. An absent field means false. */
export function applyReadyCapabilities(
  next: { readonly read_pointer?: boolean } | undefined,
): void {
  caps = next ?? {};
}

/** Forget everything: the session that learned it is gone. */
export function resetServerCapabilities(): void {
  caps = null;
}

/** Whether a full `ready` has been applied this session. */
export function hasReceivedReady(): boolean {
  return caps !== null;
}

/**
 * Whether the server keeps a read pointer (WP 3D-5): focus without marking
 * read, `mark_read` by message id, `mark_unread` and `read_state`. False keeps
 * today's behaviour: mark on focus and on switch, a count-based NEW line.
 */
export function readPointerEnabled(): boolean {
  return caps?.read_pointer === true;
}

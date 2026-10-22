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

/** The flags a full `ready` can carry that this module answers for. */
export interface ReadyCapabilityFlags {
  readonly read_pointer?: boolean;
  readonly user_notes?: boolean;
  readonly profile_banners?: boolean;
  readonly dm_privacy?: boolean;
  readonly polls?: boolean;
  readonly threads?: boolean;
}

/** The last full `ready`'s capabilities; null until one arrives. */
let caps: ReadyCapabilityFlags | null = null;

/** Record the capabilities of a full `ready`. An absent field means false. */
export function applyReadyCapabilities(next: ReadyCapabilityFlags | undefined): void {
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

/**
 * Whether the server keeps private profile notes (WP 6.11a): `GET` and `PUT`
 * `/users/me/notes/{userId}`. False keeps today's behaviour: the note lives in
 * `localStorage` on this device only.
 */
export function userNotesEnabled(): boolean {
  return caps?.user_notes === true;
}

/**
 * Whether the server keeps a profile banner (WP 6.11b): an uploaded image
 * and/or a colour. False hides every banner control. True does not promise the
 * upload route exists: a server with attachment storage off advertises it too
 * and answers the upload with 404.
 */
export function profileBannersEnabled(): boolean {
  return caps?.profile_banners === true;
}

/**
 * Whether the server stores the two direct message privacy settings (WP 6.8b):
 * `GET` and `PUT` `/users/me/privacy`. False hides Settings > Safety > Direct
 * messages.
 */
export function dmPrivacyEnabled(): boolean {
  return caps?.dm_privacy === true;
}

/**
 * Whether the server understands polls (WP 6.9b): `poll_create`, `poll_vote`
 * and `poll_end`, and the `poll_update` it sends. False hides the composer's
 * Poll button; a poll message that still arrives is drawn as its fallback text
 * only by a client that predates this, and as a card by this one.
 */
export function pollsEnabled(): boolean {
  return caps?.polls === true;
}

/**
 * Whether the server supports threads (WP 6.9c): the `thread_*` frames and `GET
 * /channels/{id}/threads`. False hides Create Thread, the header's Threads
 * button and the chip.
 */
export function threadsEnabled(): boolean {
  return caps?.threads === true;
}

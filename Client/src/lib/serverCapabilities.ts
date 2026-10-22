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
  readonly forums?: boolean;
  readonly multi_role?: boolean;
  readonly manage_nicknames?: boolean;
  readonly id_mentions?: boolean;
  readonly thread_follows?: boolean;
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

/**
 * Whether the server supports forum channels (WP 6.9d): `forum_post_create` and
 * a forum's posts. False hides the Forum option in Create Channel.
 */
export function forumsEnabled(): boolean {
  return caps?.forums === true;
}

/**
 * Whether a member can hold several roles (WP 6.3c): `role_ids` on members, a
 * `hoist` flag on roles and the add/remove role routes. False keeps today's
 * single-role picker and per-role member-list groups.
 */
export function multiRoleEnabled(): boolean {
  return caps?.multi_role === true;
}

/**
 * Whether the server lets a moderator set another member's nickname (WP 6.4):
 * `PUT /moderation/users/{id}/nickname`. An older server can still hold the
 * MANAGE_NICKNAMES bit in an Admin mask without the route, so the menu item
 * needs this flag as well as the bit.
 */
export function manageNicknamesEnabled(): boolean {
  return caps?.manage_nicknames === true;
}

/**
 * Whether the server resolves `<@id>` and `<@&id>` mention tokens (WP 6.3f):
 * the composer then sends the mentions the user picked as tokens, and offers
 * roles. False keeps today's plain `@name` text and a user-only popup.
 */
export function idMentionsEnabled(): boolean {
  return caps?.id_mentions === true;
}

/**
 * Whether the server lets a member follow a thread (WP 6.9c): `thread_follow`,
 * `thread_follow_update` and `ready.threads`. False hides the panel's Follow
 * toggle and the sidebar's thread rows.
 */
export function threadFollowsEnabled(): boolean {
  return caps?.thread_follows === true && caps.threads === true;
}

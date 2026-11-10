/**
 * Members store model — the member shapes, the wire-to-store activity
 * converters and the patch types. Pure types and functions; the store in
 * `members.store.ts` re-exports every name.
 */

import type { GameActivity, ListeningActivity, UserStatus } from "@lib/types";

/** The game a member is playing. Session state: a presence event, a
 *  full presence snapshot or `ready.activities` set it, and a new roster or
 *  sign-out clears it with the rest of the store. */
export interface MemberActivity {
  readonly name: string;
  /** Unix milliseconds the game started. */
  readonly startedAt: number;
}

/** The wire shape as the store keeps it; a blank name is no game. */
export function toMemberActivity(raw: GameActivity | null | undefined): MemberActivity | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw.name !== "string" || raw.name.trim() === "") return null;
  return { name: raw.name, startedAt: raw.started_at };
}

/** The song a member is listening to. Session state, set and cleared
 *  the same ways as `MemberActivity`. */
export interface MemberListening {
  readonly title: string;
  /** May be empty. */
  readonly artist: string;
  readonly player: string;
  /** Unix milliseconds the song would have started at. */
  readonly startedAt: number;
  /** The song's length in milliseconds; 0 = unknown. */
  readonly durationMs: number;
}

/** The wire shape as the store keeps it; a blank title or player is no song. */
export function toMemberListening(
  raw: ListeningActivity | null | undefined,
): MemberListening | null {
  if (raw === null || raw === undefined) return null;
  if (!raw.title?.trim() || !raw.player?.trim()) return null;
  return {
    title: raw.title,
    artist: raw.artist ?? "",
    player: raw.player,
    startedAt: raw.started_at,
    durationMs: raw.duration_ms > 0 ? raw.duration_ms : 0,
  };
}

export interface Member {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly role: string;
  /** Every role the member holds, top first. Undefined = an older
   *  server that sends none, where `role` is the only role. */
  readonly roleIds?: readonly number[];
  readonly status: UserStatus;
  /** On the Android app. False or undefined = not; the store sets it on every
   *  roster, presence and batch write (optional only for the inline test
   *  fixtures). The server never sends it for an offline member. */
  readonly mobile?: boolean;
  /** Nickname to render instead of `username`. Null = unset. Optional only so
   *  the many inline Member test fixtures need not restate it. Mentions still
   *  resolve against `username` — it is the unique handle. */
  readonly displayName?: string | null;
  /** Free-text status line shown under the name. Null = unset. */
  readonly customStatus?: string | null;
  /** RFC 3339 instant the custom status clears itself. Only the owner is ever
   *  told it, so it is set on your own entry alone. Null = no expiry,
   *  undefined = not known (use auth_ok's). */
  readonly customStatusExpiresAt?: string | null;
  /** The game being played. Null or undefined = none. */
  readonly activity?: MemberActivity | null;
  /** The song being listened to. Null or undefined = none. */
  readonly listening?: MemberListening | null;
  /** Profile text. Null = unset, undefined = never sent (older server). */
  readonly about?: string | null;
  /** Banner image path. Null = none, undefined = none or never sent. */
  readonly banner?: string | null;
  /** Banner colour. Null = none, undefined = none or never sent. */
  readonly banner_color?: string | null;
  /** Account creation time (RFC3339) for "Member since"; undefined = older server. */
  readonly createdAt?: string;
  /** Long-term E2EE identity public key (base64) for voice TOFU (F3). The store
   *  always sets it (null when the user has not published one); optional only so
   *  the many inline Member test fixtures need not restate it. */
  readonly identityPublicKey?: string | null;
}

export interface MembersState {
  readonly members: ReadonlyMap<number, Member>;
  readonly typingUsers: ReadonlyMap<number, ReadonlySet<number>>; // channelId -> Set<userId>
  /** Monotonic counter bumped when membership, a member's role, or a member's
   *  profile (username/displayName/avatar) changes (setMembers/addMember/
   *  removeMember/updateMemberRole/updateMemberProfile). Subscribers that only
   *  care about identity, not presence/typing (e.g. MessageList repainting
   *  author names and avatars), select this instead of rebuilding on every
   *  presence/typing update. Optional only so the many inline test fixtures
   *  need not restate it. */
  readonly roleRevision?: number;
  /** Bumped only by setMembers (a ready snapshot replacing the roster), so a
   *  watcher can tell "the roster was replaced" from "someone's presence
   *  changed" even when other updates land in the same store flush. */
  readonly snapshotRevision?: number;
}

/** One member's roles as a member_update or member_update_batch entry carries them. */
export interface MemberRoleUpdate {
  readonly userId: number;
  readonly role: string;
  readonly roleIds?: readonly number[] | undefined;
}

/** The profile fields a user_update event replaces. `identityPublicKey` and
 *  `displayName` are only applied when provided, so an older server's payload
 *  (or a partial one) doesn't clobber a pinned key or a nickname. */
export interface MemberProfilePatch {
  readonly username: string;
  readonly avatar: string | null;
  readonly displayName?: string | null;
  readonly identityPublicKey?: string | null;
  /** Only applied when provided; null clears it. */
  readonly about?: string | null;
  /** Only applied when provided (an old server sends neither); null clears. */
  readonly banner?: string | null;
  readonly banner_color?: string | null;
}

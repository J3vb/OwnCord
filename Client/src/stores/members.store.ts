/**
 * Members store — holds all server members, presence, and typing state.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import { registerSessionReset } from "@lib/sessionRegistry";
import type {
  GameActivity,
  ListeningActivity,
  ReadyActivity,
  ReadyListening,
  ReadyMember,
  MemberJoinPayload,
  PresenceBatchEntry,
  UserStatus,
} from "@lib/types";

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

const INITIAL_STATE: MembersState = {
  members: new Map(),
  typingUsers: new Map(),
  roleRevision: 0,
  snapshotRevision: 0,
};

export const membersStore = createStore<MembersState>(INITIAL_STATE);

/** Track active typing timeouts so they can be cleared. */
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function typingKey(channelId: number, userId: number): string {
  return `${channelId}:${userId}`;
}

/** Bulk set members from the ready payload.
 *  Also clears typing state and timers — a fresh ready means all typing
 *  indicators from the previous session are stale. */
export function setMembers(members: readonly ReadyMember[]): void {
  const map = new Map<number, Member>();
  for (const m of members) {
    map.set(m.id, {
      id: m.id,
      username: m.username,
      avatar: m.avatar,
      role: m.role,
      ...(m.role_ids === undefined ? {} : { roleIds: m.role_ids }),
      status: m.status,
      displayName: m.display_name ?? null,
      customStatus: m.custom_status ?? null,
      identityPublicKey: m.identity_public_key ?? null,
      ...(m.about === undefined ? {} : { about: m.about }),
      ...(m.banner === undefined ? {} : { banner: m.banner }),
      ...(m.banner_color === undefined ? {} : { banner_color: m.banner_color }),
      ...(m.created_at === undefined ? {} : { createdAt: m.created_at }),
    });
  }
  // Clear all outstanding typing timers
  for (const timer of typingTimers.values()) {
    clearTimeout(timer);
  }
  typingTimers.clear();
  membersStore.setState((prev) => ({
    members: map,
    typingUsers: new Map(),
    roleRevision: (prev.roleRevision ?? 0) + 1,
    snapshotRevision: (prev.snapshotRevision ?? 0) + 1,
  }));
}

/** A rejoining member keeps the game their last presence told us about. */
function keepActivity(existing: Member | undefined): {
  activity?: MemberActivity | null;
  listening?: MemberListening | null;
} {
  return {
    ...(existing?.activity === undefined ? {} : { activity: existing.activity }),
    ...(existing?.listening === undefined ? {} : { listening: existing.listening }),
  };
}

/** Add a member from a member_join event.
 *  status comes from the payload's viewer-safe field, never assumed —
 *  an invisible user's join broadcasts "offline", and a server old enough to
 *  omit the field entirely must fail safe the same way rather than flash the
 *  member online. */
export function addMember(payload: MemberJoinPayload): void {
  membersStore.setState((prev) => {
    const next = new Map(prev.members);
    next.set(payload.user.id, {
      id: payload.user.id,
      username: payload.user.username,
      avatar: payload.user.avatar,
      role: payload.user.role,
      ...(payload.user.role_ids === undefined ? {} : { roleIds: payload.user.role_ids }),
      status: payload.status ?? "offline",
      displayName: payload.user.display_name ?? null,
      // member_join carries no custom status; a presence event follows it and
      // is what fills this in.
      customStatus: prev.members.get(payload.user.id)?.customStatus ?? null,
      ...keepActivity(prev.members.get(payload.user.id)),
      identityPublicKey: payload.user.identity_public_key ?? null,
      ...(payload.user.about === undefined ? {} : { about: payload.user.about }),
      ...(payload.user.banner === undefined ? {} : { banner: payload.user.banner }),
      ...(payload.user.banner_color === undefined
        ? {}
        : { banner_color: payload.user.banner_color }),
      ...(payload.user.created_at === undefined ? {} : { createdAt: payload.user.created_at }),
    });
    return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
  });
}

/** Remove a member from a member_ban event. */
export function removeMember(userId: number): void {
  membersStore.setState((prev) => {
    const next = new Map(prev.members);
    next.delete(userId);
    return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
  });
}

/** Update a member's role from a member_update event. `roleIds` is every held
 *  role; omitted by an older server, which also drops any stale list. */
export function updateMemberRole(userId: number, role: string, roleIds?: readonly number[]): void {
  membersStore.setState((prev) => {
    const existing = prev.members.get(userId);
    if (!existing) return prev;
    const next = new Map(prev.members);
    const updated: Member = { ...existing, role };
    // Rebuilt without the old list so an absent field cannot keep a stale one.
    const { roleIds: _old, ...withoutIds } = updated;
    next.set(userId, roleIds === undefined ? withoutIds : { ...withoutIds, roleIds });
    return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
  });
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

/** Update a member's profile from a user_update event. */
export function updateMemberProfile(userId: number, patch: MemberProfilePatch): void {
  membersStore.setState((prev) => {
    const existing = prev.members.get(userId);
    if (!existing) return prev;
    const next = new Map(prev.members);
    next.set(userId, {
      ...existing,
      username: patch.username,
      avatar: patch.avatar,
      displayName: patch.displayName === undefined ? existing.displayName : patch.displayName,
      identityPublicKey:
        patch.identityPublicKey === undefined
          ? existing.identityPublicKey
          : patch.identityPublicKey,
      ...(patch.about === undefined ? {} : { about: patch.about }),
      ...(patch.banner === undefined ? {} : { banner: patch.banner }),
      ...(patch.banner_color === undefined ? {} : { banner_color: patch.banner_color }),
    });
    return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
  });
}

/** The expiry that goes with a member's custom status after an update. A new
 *  text drops the old expiry (the server does the same), unless the caller
 *  states one; the same text, or no text in the event, keeps it. */
function nextCustomStatusExpiry(
  existing: Member,
  customStatus: string | null | undefined,
  provided: string | null | undefined,
): { customStatusExpiresAt?: string | null } {
  if (provided !== undefined) return { customStatusExpiresAt: provided };
  if (customStatus === undefined) return {};
  const same = (existing.customStatus ?? "") === (customStatus ?? "");
  return same || existing.customStatusExpiresAt === undefined
    ? {}
    : { customStatusExpiresAt: null };
}

/** Update a member's presence status, and the custom status line that rides
 *  along with it. `customStatus` is only applied when the event carried the
 *  field — a bare status flip must not blank the text. `customStatusExpiresAt`
 *  is passed only for your own optimistic send, where the client knows it. */
export function updatePresence(
  userId: number,
  status: UserStatus,
  customStatus?: string | null,
  customStatusExpiresAt?: string | null,
  activity?: GameActivity | null,
  listening?: ListeningActivity | null,
): void {
  membersStore.setState((prev) => {
    const existing = prev.members.get(userId);
    if (!existing) return prev;
    const next = new Map(prev.members);
    next.set(userId, {
      ...existing,
      status,
      customStatus: customStatus === undefined ? existing.customStatus : customStatus,
      ...nextCustomStatusExpiry(existing, customStatus, customStatusExpiresAt),
      // Absent = an older server (or your own optimistic status flip): the shown game stays.
      ...(activity === undefined ? {} : { activity: toMemberActivity(activity) }),
      ...(listening === undefined ? {} : { listening: toMemberListening(listening) }),
    });
    return { ...prev, members: next };
  });
}

/** Apply a presence_batch in one store update. An entry only updates a member
 *  the list already has (a new member arrives first as member_join). A `full`
 *  snapshot also marks everyone it leaves out offline, clearing their text
 *  (what ready shows for an offline member). */
export function applyPresenceBatch(updates: readonly PresenceBatchEntry[], full: boolean): void {
  membersStore.setState((prev) => {
    const next = new Map(prev.members);
    if (full) {
      const listed = new Set(updates.map((u) => u.user_id));
      for (const [id, m] of next) {
        if (!listed.has(id)) {
          next.set(id, {
            ...m,
            status: "offline",
            customStatus: null,
            activity: null,
            listening: null,
          });
        }
      }
    }
    for (const u of updates) {
      const existing = next.get(u.user_id);
      if (existing === undefined) continue;
      next.set(u.user_id, {
        ...existing,
        status: u.status,
        customStatus: u.custom_status,
        ...nextCustomStatusExpiry(existing, u.custom_status, undefined),
        ...(u.activity === undefined ? {} : { activity: toMemberActivity(u.activity) }),
        ...(u.listening === undefined ? {} : { listening: toMemberListening(u.listening) }),
      });
    }
    return { ...prev, members: next };
  });
}

/** Apply `ready.activities`: the listed members play those games and everyone
 *  else plays nothing. Run after `setMembers` has put the roster in. */
export function applyReadyActivities(list: readonly ReadyActivity[]): void {
  const byUser = new Map<number, MemberActivity>();
  for (const a of list) {
    const activity = toMemberActivity(a);
    if (activity !== null) byUser.set(a.user_id, activity);
  }
  membersStore.setState((prev) => {
    const next = new Map(prev.members);
    for (const [id, m] of next) {
      const activity = byUser.get(id) ?? null;
      const current = m.activity ?? null;
      const same = current?.name === activity?.name && current?.startedAt === activity?.startedAt;
      // A member a roster snapshot just made has no activity key yet: state it.
      if (same && m.activity !== undefined) continue;
      next.set(id, { ...m, activity });
    }
    return { ...prev, members: next };
  });
}

/** Apply `ready.listening`: the listed members listen to those songs and
 *  everyone else to nothing. Run after `setMembers` has put the roster in. */
export function applyReadyListening(list: readonly ReadyListening[]): void {
  const byUser = new Map<number, MemberListening>();
  for (const l of list) {
    const listening = toMemberListening(l);
    if (listening !== null) byUser.set(l.user_id, listening);
  }
  membersStore.setState((prev) => {
    const next = new Map(prev.members);
    for (const [id, m] of next) {
      const listening = byUser.get(id) ?? null;
      // A member a roster snapshot just made has no listening key yet: state it.
      if (m.listening !== undefined && JSON.stringify(m.listening) === JSON.stringify(listening)) {
        continue;
      }
      next.set(id, { ...m, listening });
    }
    return { ...prev, members: next };
  });
}

/** The name to render for a member: display name when set, username otherwise.
 *  The one place that answers it, so the member list, message rows and the
 *  profile popup cannot disagree. */
export function memberDisplayName(member: Pick<Member, "username" | "displayName">): string {
  const display = member.displayName;
  if (typeof display === "string" && display.trim().length > 0) return display;
  return member.username;
}

/** Mark a user as typing in a channel. Auto-clears after 5 seconds. */
export function setTyping(channelId: number, userId: number): void {
  const key = typingKey(channelId, userId);

  // Clear any existing timer for this user+channel
  const existing = typingTimers.get(key);
  if (existing !== undefined) {
    clearTimeout(existing);
  }

  membersStore.setState((prev) => {
    const nextTyping = new Map(prev.typingUsers);
    const channelSet = prev.typingUsers.get(channelId);
    const nextSet = new Set(channelSet ?? []);
    nextSet.add(userId);
    nextTyping.set(channelId, nextSet);
    return { ...prev, typingUsers: nextTyping };
  });

  // Auto-clear after 5 seconds
  const timer = setTimeout(() => {
    typingTimers.delete(key);
    clearTyping(channelId, userId);
  }, 5000);
  typingTimers.set(key, timer);
}

/** Remove a user from the typing set for a channel. */
export function clearTyping(channelId: number, userId: number): void {
  const key = typingKey(channelId, userId);
  const existing = typingTimers.get(key);
  if (existing !== undefined) {
    clearTimeout(existing);
    typingTimers.delete(key);
  }

  membersStore.setState((prev) => {
    const channelSet = prev.typingUsers.get(channelId);
    if (!channelSet || !channelSet.has(userId)) return prev;

    const nextTyping = new Map(prev.typingUsers);
    const nextSet = new Set(channelSet);
    nextSet.delete(userId);

    if (nextSet.size === 0) {
      nextTyping.delete(channelId);
    } else {
      nextTyping.set(channelId, nextSet);
    }

    return { ...prev, typingUsers: nextTyping };
  });
}

/**
 * Selector: members who read as online to everybody, including, in the
 * member list, to themselves — invisible folds into offline,
 * matching MemberList's isAwayStatus/statusPriority grouping.
 */
export function getOnlineMembers(): readonly Member[] {
  return membersStore.select((s) => {
    const result: Member[] = [];
    for (const member of s.members.values()) {
      if (member.status !== "offline" && member.status !== "invisible") {
        result.push(member);
      }
    }
    return result;
  });
}

/** Selector: array of Member objects currently typing in a channel. */
export function getTypingUsers(channelId: number): readonly Member[] {
  return membersStore.select((s) => {
    const userIds = s.typingUsers.get(channelId);
    if (!userIds || userIds.size === 0) return [];

    const result: Member[] = [];
    for (const userId of userIds) {
      const member = s.members.get(userId);
      if (member) {
        result.push(member);
      }
    }
    return result;
  });
}

/** Forget the previous server's roster, presence and typing (with live timers)
 *  on sign-out or server switch. The revisions bump rather than reset, as
 *  emoji's `rev` does, so a watcher cannot mistake the next snapshot for the
 *  one it already saw. */
export function resetMembersStore(): void {
  for (const timer of typingTimers.values()) {
    clearTimeout(timer);
  }
  typingTimers.clear();
  membersStore.setState((prev) => ({
    ...INITIAL_STATE,
    roleRevision: (prev.roleRevision ?? 0) + 1,
    snapshotRevision: (prev.snapshotRevision ?? 0) + 1,
  }));
}

void registerSessionReset("members:store", resetMembersStore); // app-lifetime

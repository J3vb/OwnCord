/**
 * Members store — holds all server members, presence, and typing state.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type { ReadyMember, MemberJoinPayload, UserStatus } from "@lib/types";

export interface Member {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly role: string;
  readonly status: UserStatus;
  /** Nickname to render instead of `username`. Null = unset. Optional only so
   *  the many inline Member test fixtures need not restate it. Mentions still
   *  resolve against `username` — it is the unique handle. */
  readonly displayName?: string | null;
  /** Free-text status line shown under the name. Null = unset. */
  readonly customStatus?: string | null;
  /** Long-term E2EE identity public key (base64) for voice TOFU (F3). The store
   *  always sets it (null when the user has not published one); optional only so
   *  the many inline Member test fixtures need not restate it. */
  readonly identityPublicKey?: string | null;
}

export interface MembersState {
  readonly members: ReadonlyMap<number, Member>;
  readonly typingUsers: ReadonlyMap<number, ReadonlySet<number>>; // channelId -> Set<userId>
  /** Monotonic counter bumped only when membership or a member's role changes
   *  (setMembers/addMember/removeMember/updateMemberRole). Subscribers that
   *  only care about role composition (e.g. MessageList role colors) select
   *  this instead of rebuilding a role map on every presence/typing update.
   *  Optional only so the many inline test fixtures need not restate it. */
  readonly roleRevision?: number;
}

const INITIAL_STATE: MembersState = {
  members: new Map(),
  typingUsers: new Map(),
  roleRevision: 0,
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
      status: m.status,
      displayName: m.display_name ?? null,
      customStatus: m.custom_status ?? null,
      identityPublicKey: m.identity_public_key ?? null,
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
  }));
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
      status: payload.status ?? "offline",
      displayName: payload.user.display_name ?? null,
      // member_join carries no custom status; a presence event follows it and
      // is what fills this in.
      customStatus: prev.members.get(payload.user.id)?.customStatus ?? null,
      identityPublicKey: payload.user.identity_public_key ?? null,
    });
    return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
  });
}

/** Remove a member from a member_leave event. */
export function removeMember(userId: number): void {
  membersStore.setState((prev) => {
    const next = new Map(prev.members);
    next.delete(userId);
    return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
  });
}

/** Update a member's role from a member_update event. */
export function updateMemberRole(userId: number, role: string): void {
  membersStore.setState((prev) => {
    const existing = prev.members.get(userId);
    if (!existing) return prev;
    const next = new Map(prev.members);
    next.set(userId, { ...existing, role });
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
    });
    return { ...prev, members: next };
  });
}

/** Update a member's presence status, and the custom status line that rides
 *  along with it. `customStatus` is only applied when the event carried the
 *  field — a bare status flip must not blank the text. */
export function updatePresence(
  userId: number,
  status: UserStatus,
  customStatus?: string | null,
): void {
  membersStore.setState((prev) => {
    const existing = prev.members.get(userId);
    if (!existing) return prev;
    const next = new Map(prev.members);
    next.set(userId, {
      ...existing,
      status,
      customStatus: customStatus === undefined ? existing.customStatus : customStatus,
    });
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

/** Selector: members where status is not "offline". */
export function getOnlineMembers(): readonly Member[] {
  return membersStore.select((s) => {
    const result: Member[] = [];
    for (const member of s.members.values()) {
      if (member.status !== "offline") {
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

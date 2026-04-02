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
}

export interface MembersState {
  readonly members: ReadonlyMap<number, Member>;
  readonly typingUsers: ReadonlyMap<number, ReadonlySet<number>>; // channelId -> Set<userId>
}

const INITIAL_STATE: MembersState = {
  members: new Map(),
  typingUsers: new Map(),
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
    });
  }
  // Clear all outstanding typing timers
  for (const timer of typingTimers.values()) {
    clearTimeout(timer);
  }
  typingTimers.clear();
  membersStore.setState(() => ({
    members: map,
    typingUsers: new Map(),
  }));
}

/** Add a member from a member_join event. */
export function addMember(payload: MemberJoinPayload): void {
  membersStore.setState((prev) => {
    const next = new Map(prev.members);
    next.set(payload.user.id, {
      id: payload.user.id,
      username: payload.user.username,
      avatar: payload.user.avatar,
      role: payload.user.role,
      status: "online" as UserStatus,
    });
    return { ...prev, members: next };
  });
}

/** Remove a member from a member_leave event. */
export function removeMember(userId: number): void {
  membersStore.setState((prev) => {
    const next = new Map(prev.members);
    next.delete(userId);
    return { ...prev, members: next };
  });
}

/** Update a member's role from a member_update event. */
export function updateMemberRole(userId: number, role: string): void {
  membersStore.setState((prev) => {
    const existing = prev.members.get(userId);
    if (!existing) return prev;
    const next = new Map(prev.members);
    next.set(userId, { ...existing, role });
    return { ...prev, members: next };
  });
}

/** Update a member's profile (username, avatar) from a user_update event. */
export function updateMemberProfile(userId: number, username: string, avatar: string | null): void {
  membersStore.setState((prev) => {
    const existing = prev.members.get(userId);
    if (!existing) return prev;
    const next = new Map(prev.members);
    next.set(userId, { ...existing, username, avatar });
    return { ...prev, members: next };
  });
}

/** Update a member's presence status. */
export function updatePresence(userId: number, status: UserStatus): void {
  membersStore.setState((prev) => {
    const existing = prev.members.get(userId);
    if (!existing) return prev;
    const next = new Map(prev.members);
    next.set(userId, { ...existing, status });
    return { ...prev, members: next };
  });
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

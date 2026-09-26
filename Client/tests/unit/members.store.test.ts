import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  membersStore,
  setMembers,
  addMember,
  removeMember,
  updateMemberRole,
  updateMemberProfile,
  updatePresence,
  setTyping,
  clearTyping,
  getOnlineMembers,
  getTypingUsers,
} from "../../src/stores/members.store";
import type { ReadyMember, MemberJoinPayload, UserStatus } from "../../src/lib/types";

const MEMBER_ALICE: ReadyMember = {
  id: 1,
  username: "alice",
  avatar: "alice.png",
  role: "admin",
  status: "online",
};

const MEMBER_BOB: ReadyMember = {
  id: 2,
  username: "bob",
  avatar: null,
  role: "member",
  status: "idle",
};

const MEMBER_CAROL: ReadyMember = {
  id: 3,
  username: "carol",
  avatar: "carol.png",
  role: "member",
  status: "offline",
};

function resetStore(): void {
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
}

describe("members store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("has empty members map", () => {
      // Reset already applied; check fresh state
      expect(membersStore.getState().members.size).toBe(0);
    });

    it("has empty typingUsers map", () => {
      expect(membersStore.getState().typingUsers.size).toBe(0);
    });
  });

  describe("setMembers", () => {
    it("populates members from ready payload", () => {
      setMembers([MEMBER_ALICE, MEMBER_BOB]);
      const state = membersStore.getState();
      expect(state.members.size).toBe(2);
      expect(state.members.get(1)).toEqual({
        id: 1,
        username: "alice",
        avatar: "alice.png",
        role: "admin",
        status: "online",
        displayName: null,
        customStatus: null,
        identityPublicKey: null,
      });
    });

    it("replaces existing members entirely", () => {
      setMembers([MEMBER_ALICE, MEMBER_BOB]);
      setMembers([MEMBER_CAROL]);
      const state = membersStore.getState();
      expect(state.members.size).toBe(1);
      expect(state.members.has(1)).toBe(false);
      expect(state.members.has(3)).toBe(true);
    });

    it("produces a new state object", () => {
      const before = membersStore.getState();
      setMembers([MEMBER_ALICE]);
      const after = membersStore.getState();
      expect(before).not.toBe(after);
    });
  });

  describe("addMember", () => {
    it("adds a new member from member_join payload, using the payload's status", () => {
      const payload: MemberJoinPayload = {
        user: { id: 10, username: "newuser", avatar: null, role: "member" },
        status: "online",
      };
      addMember(payload);
      const member = membersStore.getState().members.get(10);
      expect(member).toEqual({
        id: 10,
        username: "newuser",
        avatar: null,
        role: "member",
        status: "online",
        displayName: null,
        customStatus: null,
        identityPublicKey: null,
      });
    });

    it("renders an invisible join as offline", () => {
      // The server collapses an invisible connector's status to "offline"
      // before broadcasting member_join; the store must pass that through
      // rather than assuming a join always means online.
      addMember({
        user: { id: 11, username: "ghost", avatar: null, role: "member" },
        status: "offline",
      });
      expect(membersStore.getState().members.get(11)?.status).toBe("offline");
    });

    it("defaults to offline when the payload omits status (older server)", () => {
      // Fail safe: a server that has not shipped the status field yet must
      // not cause a hidden user to render as online.
      addMember({
        user: { id: 12, username: "legacy-server-user", avatar: null, role: "member" },
      });
      expect(membersStore.getState().members.get(12)?.status).toBe("offline");
    });

    it("does not remove existing members", () => {
      setMembers([MEMBER_ALICE]);
      addMember({
        user: { id: 10, username: "newuser", avatar: null, role: "member" },
        status: "online",
      });
      expect(membersStore.getState().members.size).toBe(2);
      expect(membersStore.getState().members.has(1)).toBe(true);
    });
  });

  describe("removeMember", () => {
    it("removes a member by userId", () => {
      setMembers([MEMBER_ALICE, MEMBER_BOB]);
      removeMember(1);
      const state = membersStore.getState();
      expect(state.members.size).toBe(1);
      expect(state.members.has(1)).toBe(false);
    });

    it("is a no-op for non-existent userId", () => {
      setMembers([MEMBER_ALICE]);
      const before = membersStore.getState();
      removeMember(999);
      // Map was still rebuilt, but size unchanged
      expect(membersStore.getState().members.size).toBe(1);
    });
  });

  describe("updateMemberRole", () => {
    it("updates role of an existing member", () => {
      setMembers([MEMBER_BOB]);
      updateMemberRole(2, "admin");
      expect(membersStore.getState().members.get(2)?.role).toBe("admin");
    });

    it("preserves other fields", () => {
      setMembers([MEMBER_BOB]);
      updateMemberRole(2, "admin");
      const member = membersStore.getState().members.get(2)!;
      expect(member.username).toBe("bob");
      expect(member.status).toBe("idle");
    });

    it("returns same state for unknown userId", () => {
      setMembers([MEMBER_ALICE]);
      const before = membersStore.getState();
      updateMemberRole(999, "admin");
      expect(membersStore.getState()).toBe(before);
    });
  });

  describe("updateMemberProfile", () => {
    it("bumps roleRevision so MessageList's only members subscription re-renders", () => {
      // MessageList subscribes solely to roleRevision (MessageList.ts:897-903)
      // to know when to repaint rendered rows. A username/avatar/nickname
      // change must bump it the same as every other mutator does, or a
      // rename never repaints already-rendered messages.
      setMembers([MEMBER_ALICE]);
      const before = membersStore.getState().roleRevision ?? 0;
      updateMemberProfile(1, { username: "alice2", avatar: "alice2.png" });
      expect(membersStore.getState().roleRevision ?? 0).toBe(before + 1);
    });

    it("updates username, avatar, and displayName of an existing member", () => {
      setMembers([MEMBER_ALICE]);
      updateMemberProfile(1, { username: "alice2", avatar: "alice2.png", displayName: "Al" });
      const member = membersStore.getState().members.get(1)!;
      expect(member.username).toBe("alice2");
      expect(member.avatar).toBe("alice2.png");
      expect(member.displayName).toBe("Al");
    });

    it("returns same state for unknown userId", () => {
      setMembers([MEMBER_ALICE]);
      const before = membersStore.getState();
      updateMemberProfile(999, { username: "ghost", avatar: null });
      expect(membersStore.getState()).toBe(before);
    });
  });

  describe("updatePresence", () => {
    it("updates status of an existing member", () => {
      setMembers([MEMBER_ALICE]);
      updatePresence(1, "dnd");
      expect(membersStore.getState().members.get(1)?.status).toBe("dnd");
    });

    it("preserves other fields", () => {
      setMembers([MEMBER_ALICE]);
      updatePresence(1, "idle");
      const member = membersStore.getState().members.get(1)!;
      expect(member.username).toBe("alice");
      expect(member.role).toBe("admin");
    });

    it("returns same state for unknown userId", () => {
      setMembers([MEMBER_ALICE]);
      const before = membersStore.getState();
      updatePresence(999, "online");
      expect(membersStore.getState()).toBe(before);
    });
  });

  describe("setTyping / clearTyping", () => {
    it("adds a user to the typing set for a channel", () => {
      setMembers([MEMBER_ALICE]);
      setTyping(100, 1);
      const typingSet = membersStore.getState().typingUsers.get(100);
      expect(typingSet).toBeDefined();
      expect(typingSet!.has(1)).toBe(true);
    });

    it("supports multiple users typing in the same channel", () => {
      setMembers([MEMBER_ALICE, MEMBER_BOB]);
      setTyping(100, 1);
      setTyping(100, 2);
      const typingSet = membersStore.getState().typingUsers.get(100);
      expect(typingSet!.size).toBe(2);
    });

    it("clearTyping removes a user from the channel", () => {
      setMembers([MEMBER_ALICE, MEMBER_BOB]);
      setTyping(100, 1);
      setTyping(100, 2);
      clearTyping(100, 1);
      const typingSet = membersStore.getState().typingUsers.get(100);
      expect(typingSet!.has(1)).toBe(false);
      expect(typingSet!.has(2)).toBe(true);
    });

    it("removes the channel entry when last user clears", () => {
      setTyping(100, 1);
      clearTyping(100, 1);
      expect(membersStore.getState().typingUsers.has(100)).toBe(false);
    });

    it("auto-clears typing after 5 seconds", () => {
      setMembers([MEMBER_ALICE]);
      setTyping(100, 1);
      expect(membersStore.getState().typingUsers.get(100)?.has(1)).toBe(true);

      vi.advanceTimersByTime(5000);

      expect(membersStore.getState().typingUsers.has(100)).toBe(false);
    });

    it("resets the auto-clear timer when setTyping is called again", () => {
      setMembers([MEMBER_ALICE]);
      setTyping(100, 1);

      // Advance 3 seconds, then set typing again
      vi.advanceTimersByTime(3000);
      setTyping(100, 1);

      // Advance another 3 seconds — original timer would have expired
      vi.advanceTimersByTime(3000);
      expect(membersStore.getState().typingUsers.get(100)?.has(1)).toBe(true);

      // Advance remaining 2 seconds to hit the new 5s timer
      vi.advanceTimersByTime(2000);
      expect(membersStore.getState().typingUsers.has(100)).toBe(false);
    });

    it("clearTyping is a no-op for non-typing user", () => {
      setMembers([MEMBER_ALICE]);
      const before = membersStore.getState();
      clearTyping(100, 1);
      expect(membersStore.getState()).toBe(before);
    });
  });

  describe("getOnlineMembers", () => {
    it("returns members where status is not offline", () => {
      setMembers([MEMBER_ALICE, MEMBER_BOB, MEMBER_CAROL]);
      const online = getOnlineMembers();
      expect(online).toHaveLength(2);
      expect(online.map((m) => m.id).sort()).toEqual([1, 2]);
    });

    it("returns empty array when all members are offline", () => {
      setMembers([MEMBER_CAROL]);
      expect(getOnlineMembers()).toHaveLength(0);
    });

    it("returns empty array when no members exist", () => {
      expect(getOnlineMembers()).toHaveLength(0);
    });

    it("excludes invisible members, matching MemberList's offline grouping (OC-0348)", () => {
      const invisibleSelf: ReadyMember = { ...MEMBER_BOB, status: "invisible" };
      setMembers([MEMBER_ALICE, invisibleSelf]);
      const online = getOnlineMembers();
      expect(online).toHaveLength(1);
      expect(online.map((m) => m.id)).toEqual([1]);
    });
  });

  describe("getTypingUsers", () => {
    it("returns Member objects for users typing in a channel", () => {
      setMembers([MEMBER_ALICE, MEMBER_BOB]);
      setTyping(100, 1);
      const typing = getTypingUsers(100);
      expect(typing).toHaveLength(1);
      expect(typing[0]?.username).toBe("alice");
    });

    it("returns empty array for a channel with no typing users", () => {
      setMembers([MEMBER_ALICE]);
      expect(getTypingUsers(100)).toHaveLength(0);
    });

    it("skips userId not found in members", () => {
      setTyping(100, 999);
      expect(getTypingUsers(100)).toHaveLength(0);
    });
  });

  describe("subscribe", () => {
    it("notifies on setMembers", () => {
      const listener = vi.fn();
      const unsub = membersStore.subscribe(listener);
      setMembers([MEMBER_ALICE]);
      membersStore.flush();
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
    });

    it("does not notify after unsubscribe", () => {
      const listener = vi.fn();
      const unsub = membersStore.subscribe(listener);
      unsub();
      setMembers([MEMBER_ALICE]);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});

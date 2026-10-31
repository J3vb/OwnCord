import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  addMember,
  applyPresenceBatch,
  applyReadyActivities,
  applyReadyListening,
  clearTyping,
  getOnlineMembers,
  getTypingUsers,
  memberDisplayName,
  membersStore,
  removeMember,
  resetMembersStore,
  setMembers,
  setTyping,
  toMemberActivity,
  toMemberListening,
  updateMemberProfile,
  updateMemberRole,
  updatePresence,
  type Member,
} from "@stores/members.store";
import { listSessionResets, runSessionResets } from "@lib/net/sessionRegistry";
import type { ListeningActivity, ReadyMember } from "@lib/types";
import { resetMembersState } from "../helpers/storeResets";

const ALICE: ReadyMember = {
  id: 1,
  username: "alice",
  avatar: "alice.png",
  role: "admin",
  status: "online",
};
const BOB: ReadyMember = { id: 2, username: "bob", avatar: null, role: "member", status: "idle" };

const SONG: ListeningActivity = {
  title: "Song",
  artist: "Band",
  player: "VLC",
  started_at: 100,
  duration_ms: 3000,
};

function member(id: number): Member | undefined {
  return membersStore.getState().members.get(id);
}

function roleRevision(): number {
  return membersStore.getState().roleRevision ?? 0;
}

describe("members store presence and profile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMembersStore();
  });

  afterEach(() => {
    resetMembersStore();
    vi.useRealTimers();
  });

  describe("toMemberActivity", () => {
    it("is null for a missing or blank game", () => {
      expect(toMemberActivity(null)).toBeNull();
      expect(toMemberActivity(undefined)).toBeNull();
      expect(toMemberActivity({ name: "", started_at: 1 })).toBeNull();
      expect(toMemberActivity({ name: "   ", started_at: 1 })).toBeNull();
      expect(toMemberActivity({ name: 5 as unknown as string, started_at: 1 })).toBeNull();
    });

    it("keeps the name as sent and maps the start time", () => {
      expect(toMemberActivity({ name: " Factorio ", started_at: 42 })).toEqual({
        name: " Factorio ",
        startedAt: 42,
      });
    });
  });

  describe("toMemberListening", () => {
    it("is null for a missing song or one without a title or player", () => {
      expect(toMemberListening(null)).toBeNull();
      expect(toMemberListening(undefined)).toBeNull();
      expect(toMemberListening({ ...SONG, title: "" })).toBeNull();
      expect(toMemberListening({ ...SONG, title: "  " })).toBeNull();
      expect(toMemberListening({ ...SONG, player: "" })).toBeNull();
      expect(toMemberListening({ ...SONG, player: " " })).toBeNull();
      expect(toMemberListening({ ...SONG, title: undefined as unknown as string })).toBeNull();
      expect(toMemberListening({ ...SONG, player: undefined as unknown as string })).toBeNull();
    });

    it("maps every field", () => {
      expect(toMemberListening(SONG)).toEqual({
        title: "Song",
        artist: "Band",
        player: "VLC",
        startedAt: 100,
        durationMs: 3000,
      });
    });

    it("reads a missing artist as empty", () => {
      expect(toMemberListening({ ...SONG, artist: undefined as unknown as string })?.artist).toBe(
        "",
      );
    });

    it("reads an unknown or negative length as 0", () => {
      expect(toMemberListening({ ...SONG, duration_ms: 0 })?.durationMs).toBe(0);
      expect(toMemberListening({ ...SONG, duration_ms: -5 })?.durationMs).toBe(0);
      expect(toMemberListening({ ...SONG, duration_ms: 1 })?.durationMs).toBe(1);
    });
  });

  describe("setMembers", () => {
    it("maps the profile fields and leaves out the ones an older server never sent", () => {
      setMembers([ALICE]);
      expect(member(1)).toEqual({
        id: 1,
        username: "alice",
        avatar: "alice.png",
        role: "admin",
        status: "online",
        displayName: null,
        customStatus: null,
        identityPublicKey: null,
      });
      const keys = Object.keys(member(1) ?? {});
      for (const absent of ["roleIds", "about", "banner", "banner_color", "createdAt"]) {
        expect(keys).not.toContain(absent);
      }
    });

    it("carries every optional field that was sent", () => {
      setMembers([
        {
          ...ALICE,
          role_ids: [3, 1],
          display_name: "Al",
          custom_status: "busy",
          identity_public_key: "KEY",
          about: "hi",
          banner: "/b.png",
          banner_color: "#fff",
          created_at: "2024-01-01T00:00:00Z",
        },
      ]);
      expect(member(1)).toEqual({
        id: 1,
        username: "alice",
        avatar: "alice.png",
        role: "admin",
        roleIds: [3, 1],
        status: "online",
        displayName: "Al",
        customStatus: "busy",
        identityPublicKey: "KEY",
        about: "hi",
        banner: "/b.png",
        banner_color: "#fff",
        createdAt: "2024-01-01T00:00:00Z",
      });
    });

    it("keeps a null about, banner and colour as sent", () => {
      setMembers([{ ...ALICE, about: null, banner: null, banner_color: null }]);
      expect(member(1)?.about).toBeNull();
      expect(member(1)?.banner).toBeNull();
      expect(member(1)?.banner_color).toBeNull();
    });

    it("bumps both revisions by one", () => {
      const before = membersStore.getState();
      setMembers([ALICE]);
      const after = membersStore.getState();
      expect(after.roleRevision).toBe((before.roleRevision ?? 0) + 1);
      expect(after.snapshotRevision).toBe((before.snapshotRevision ?? 0) + 1);
    });

    it("counts revisions from 0 when the state never had them", () => {
      resetMembersState();
      setMembers([ALICE]);
      expect(membersStore.getState().roleRevision).toBe(1);
      expect(membersStore.getState().snapshotRevision).toBe(1);
    });

    it("drops typing state and its timers from the previous session", () => {
      setMembers([ALICE]);
      setTyping(5, 1);
      expect(vi.getTimerCount()).toBe(1);
      setMembers([ALICE]);
      expect(vi.getTimerCount()).toBe(0);
      expect(membersStore.getState().typingUsers.size).toBe(0);
    });
  });

  describe("addMember", () => {
    it("carries role ids, profile fields and the identity key", () => {
      addMember({
        user: {
          id: 7,
          username: "g",
          avatar: "g.png",
          role: "mod",
          role_ids: [4],
          display_name: "Gee",
          identity_public_key: "K",
          about: "a",
          banner: "/b",
          banner_color: "#000",
          created_at: "2023-05-05T00:00:00Z",
        },
        status: "dnd",
      });
      expect(member(7)).toEqual({
        id: 7,
        username: "g",
        avatar: "g.png",
        role: "mod",
        roleIds: [4],
        status: "dnd",
        displayName: "Gee",
        customStatus: null,
        identityPublicKey: "K",
        about: "a",
        banner: "/b",
        banner_color: "#000",
        createdAt: "2023-05-05T00:00:00Z",
      });
    });

    it("keeps a null about, banner and colour as sent", () => {
      addMember({
        user: {
          id: 7,
          username: "g",
          avatar: null,
          role: "member",
          about: null,
          banner: null,
          banner_color: null,
        },
      });
      expect(member(7)?.about).toBeNull();
      expect(member(7)?.banner).toBeNull();
      expect(member(7)?.banner_color).toBeNull();
    });

    it("leaves out the fields an older server never sent", () => {
      addMember({ user: { id: 7, username: "g", avatar: null, role: "member" } });
      const keys = Object.keys(member(7) ?? {});
      for (const absent of ["roleIds", "about", "banner", "banner_color", "createdAt"]) {
        expect(keys).not.toContain(absent);
      }
    });

    it("keeps the custom status a rejoining member already had", () => {
      setMembers([{ ...ALICE, custom_status: "lunch" }]);
      addMember({
        user: { id: 1, username: "alice", avatar: null, role: "admin" },
        status: "online",
      });
      expect(member(1)?.customStatus).toBe("lunch");
    });

    it("bumps the role revision", () => {
      const before = roleRevision();
      addMember({ user: { id: 7, username: "g", avatar: null, role: "member" } });
      expect(roleRevision()).toBe(before + 1);
    });

    it("counts from 0 when the revision was never set", () => {
      resetMembersState();
      addMember({ user: { id: 7, username: "g", avatar: null, role: "member" } });
      expect(roleRevision()).toBe(1);
    });
  });

  describe("removeMember", () => {
    it("bumps the role revision", () => {
      setMembers([ALICE]);
      const before = roleRevision();
      removeMember(1);
      expect(roleRevision()).toBe(before + 1);
      expect(member(1)).toBeUndefined();
    });

    it("counts from 0 when the revision was never set", () => {
      resetMembersState();
      removeMember(1);
      expect(roleRevision()).toBe(1);
    });
  });

  describe("updateMemberRole", () => {
    it("sets the role and every held role id", () => {
      setMembers([{ ...ALICE, role_ids: [9] }]);
      updateMemberRole(1, "mod", [4, 2]);
      expect(member(1)?.role).toBe("mod");
      expect(member(1)?.roleIds).toEqual([4, 2]);
    });

    it("drops a stale id list when the event carries none", () => {
      setMembers([{ ...ALICE, role_ids: [9] }]);
      updateMemberRole(1, "mod");
      expect(member(1)?.role).toBe("mod");
      expect(Object.keys(member(1) ?? {})).not.toContain("roleIds");
    });

    it("bumps the role revision, and not for an unknown member", () => {
      setMembers([ALICE]);
      const before = roleRevision();
      updateMemberRole(99, "x");
      expect(roleRevision()).toBe(before);
      updateMemberRole(1, "x");
      expect(roleRevision()).toBe(before + 1);
    });

    it("counts from 0 when the revision was never set", () => {
      setMembers([ALICE]);
      membersStore.setState((prev) => ({ ...prev, roleRevision: undefined }));
      updateMemberRole(1, "x");
      expect(roleRevision()).toBe(1);
    });
  });

  describe("updateMemberProfile", () => {
    beforeEach(() => {
      setMembers([
        {
          ...ALICE,
          display_name: "Al",
          identity_public_key: "OLD",
          about: "old about",
          banner: "/old",
          banner_color: "#111",
        },
      ]);
    });

    it("keeps the nickname and pinned key when the patch omits them", () => {
      updateMemberProfile(1, { username: "alice2", avatar: null });
      expect(member(1)?.username).toBe("alice2");
      expect(member(1)?.avatar).toBeNull();
      expect(member(1)?.displayName).toBe("Al");
      expect(member(1)?.identityPublicKey).toBe("OLD");
      expect(member(1)?.about).toBe("old about");
      expect(member(1)?.banner).toBe("/old");
      expect(member(1)?.banner_color).toBe("#111");
    });

    it("replaces the nickname and key when given, and clears them with null", () => {
      updateMemberProfile(1, {
        username: "alice",
        avatar: "a",
        displayName: "New",
        identityPublicKey: "NEW",
        about: "new about",
        banner: "/new",
        banner_color: "#222",
      });
      expect(member(1)).toMatchObject({
        displayName: "New",
        identityPublicKey: "NEW",
        about: "new about",
        banner: "/new",
        banner_color: "#222",
      });
      updateMemberProfile(1, {
        username: "alice",
        avatar: "a",
        displayName: null,
        identityPublicKey: null,
        about: null,
        banner: null,
        banner_color: null,
      });
      expect(member(1)?.displayName).toBeNull();
      expect(member(1)?.identityPublicKey).toBeNull();
      expect(member(1)?.about).toBeNull();
      expect(member(1)?.banner).toBeNull();
      expect(member(1)?.banner_color).toBeNull();
    });

    it("bumps the role revision by one", () => {
      const before = roleRevision();
      updateMemberProfile(1, { username: "x", avatar: null });
      expect(roleRevision()).toBe(before + 1);
    });

    it("counts from 0 when the revision was never set", () => {
      membersStore.setState((prev) => ({ ...prev, roleRevision: undefined }));
      updateMemberProfile(1, { username: "x", avatar: null });
      expect(roleRevision()).toBe(1);
    });
  });

  describe("updatePresence", () => {
    beforeEach(() => {
      setMembers([{ ...ALICE, custom_status: "lunch" }]);
    });

    it("keeps the status text on a bare status flip", () => {
      updatePresence(1, "dnd");
      expect(member(1)?.status).toBe("dnd");
      expect(member(1)?.customStatus).toBe("lunch");
    });

    it("sets or clears the status text when the event carries it", () => {
      updatePresence(1, "online", "walk");
      expect(member(1)?.customStatus).toBe("walk");
      updatePresence(1, "online", null);
      expect(member(1)?.customStatus).toBeNull();
    });

    it("stores an expiry the caller states, null included", () => {
      updatePresence(1, "online", "walk", "2030-01-01T00:00:00Z");
      expect(member(1)?.customStatusExpiresAt).toBe("2030-01-01T00:00:00Z");
      updatePresence(1, "online", "walk", null);
      expect(member(1)?.customStatusExpiresAt).toBeNull();
    });

    it("drops the old expiry when the text changes and none is stated", () => {
      updatePresence(1, "online", "lunch", "2030-01-01T00:00:00Z");
      updatePresence(1, "online", "dinner");
      expect(member(1)?.customStatus).toBe("dinner");
      expect(member(1)?.customStatusExpiresAt).toBeNull();
    });

    it("keeps the expiry when the text is the same or absent", () => {
      updatePresence(1, "online", "lunch", "2030-01-01T00:00:00Z");
      updatePresence(1, "idle", "lunch");
      expect(member(1)?.customStatusExpiresAt).toBe("2030-01-01T00:00:00Z");
      updatePresence(1, "idle");
      expect(member(1)?.customStatusExpiresAt).toBe("2030-01-01T00:00:00Z");
    });

    it("treats an unset text and an empty one as the same text", () => {
      setMembers([{ ...ALICE, custom_status: null }]);
      updatePresence(1, "online", "", "2030-01-01T00:00:00Z");
      updatePresence(1, "online", null);
      expect(member(1)?.customStatusExpiresAt).toBe("2030-01-01T00:00:00Z");
    });

    it("keeps the expiry when a member with no status text gets another null", () => {
      setMembers([{ ...ALICE, custom_status: null }]);
      updatePresence(1, "online", null, "2030-01-01T00:00:00Z");
      expect(member(1)?.customStatus).toBeNull();
      updatePresence(1, "online", null);
      expect(member(1)?.customStatusExpiresAt).toBe("2030-01-01T00:00:00Z");
    });

    it("drops the expiry when a member with no status text gets one", () => {
      setMembers([{ ...ALICE, custom_status: null }]);
      updatePresence(1, "online", null, "2030-01-01T00:00:00Z");
      updatePresence(1, "online", "new");
      expect(member(1)?.customStatusExpiresAt).toBeNull();
    });

    it("states no expiry key when the member never had one and the text changes", () => {
      updatePresence(1, "online", "dinner");
      expect(Object.keys(member(1) ?? {})).not.toContain("customStatusExpiresAt");
    });

    it("sets the game and the song, clears them with null, and keeps them when absent", () => {
      updatePresence(1, "online", undefined, undefined, { name: "Chess", started_at: 9 }, SONG);
      expect(member(1)?.activity).toEqual({ name: "Chess", startedAt: 9 });
      expect(member(1)?.listening).toMatchObject({ title: "Song", player: "VLC" });
      updatePresence(1, "idle");
      expect(member(1)?.activity).toEqual({ name: "Chess", startedAt: 9 });
      expect(member(1)?.listening).toMatchObject({ title: "Song" });
      updatePresence(1, "idle", undefined, undefined, null, null);
      expect(member(1)?.activity).toBeNull();
      expect(member(1)?.listening).toBeNull();
    });

    it("adds no activity or listening key when the event has neither", () => {
      updatePresence(1, "idle");
      expect(Object.keys(member(1) ?? {})).not.toContain("activity");
      expect(Object.keys(member(1) ?? {})).not.toContain("listening");
    });

    it("does not touch the role revision", () => {
      const before = roleRevision();
      updatePresence(1, "dnd");
      expect(roleRevision()).toBe(before);
    });
  });

  describe("applyPresenceBatch", () => {
    beforeEach(() => {
      setMembers([
        { ...ALICE, custom_status: "a-text" },
        { ...BOB, custom_status: "b-text" },
      ]);
      updatePresence(
        2,
        "idle",
        "b-text",
        "2030-01-01T00:00:00Z",
        { name: "G", started_at: 1 },
        SONG,
      );
    });

    it("updates the listed members and leaves the rest of a delta alone", () => {
      applyPresenceBatch([{ user_id: 1, status: "dnd", custom_status: "new" }], false);
      expect(member(1)?.status).toBe("dnd");
      expect(member(1)?.customStatus).toBe("new");
      expect(member(2)?.status).toBe("idle");
      expect(member(2)?.customStatus).toBe("b-text");
      expect(member(2)?.activity).toEqual({ name: "G", startedAt: 1 });
    });

    it("ignores an entry for a member the roster does not have", () => {
      applyPresenceBatch([{ user_id: 99, status: "online", custom_status: null }], false);
      expect(membersStore.getState().members.has(99)).toBe(false);
      expect(membersStore.getState().members.size).toBe(2);
    });

    it("marks everyone a full snapshot leaves out offline and clears their text and activity", () => {
      applyPresenceBatch([{ user_id: 1, status: "online", custom_status: "a-text" }], true);
      expect(member(1)?.status).toBe("online");
      expect(member(2)).toMatchObject({
        status: "offline",
        customStatus: null,
        activity: null,
        listening: null,
      });
    });

    it("keeps a listed member's game and song when a full snapshot entry omits them", () => {
      applyPresenceBatch([{ user_id: 2, status: "idle", custom_status: "b-text" }], true);
      expect(member(2)?.activity).toEqual({ name: "G", startedAt: 1 });
      expect(member(2)?.listening).toMatchObject({ title: "Song" });
      expect(member(1)?.status).toBe("offline");
    });

    it("keeps the members a full snapshot lists", () => {
      applyPresenceBatch(
        [
          { user_id: 1, status: "online", custom_status: null },
          { user_id: 2, status: "dnd", custom_status: "b-text" },
        ],
        true,
      );
      expect(member(1)?.status).toBe("online");
      expect(member(2)?.status).toBe("dnd");
      expect(member(2)?.customStatus).toBe("b-text");
    });

    it("sets and clears the game and song from the entry, and keeps them when absent", () => {
      applyPresenceBatch([{ user_id: 2, status: "idle", custom_status: "b-text" }], false);
      expect(member(2)?.activity).toEqual({ name: "G", startedAt: 1 });
      expect(member(2)?.listening).toMatchObject({ title: "Song" });
      applyPresenceBatch(
        [
          {
            user_id: 2,
            status: "idle",
            custom_status: "b-text",
            activity: { name: "H", started_at: 2 },
            listening: { ...SONG, title: "Other" },
          },
        ],
        false,
      );
      expect(member(2)?.activity).toEqual({ name: "H", startedAt: 2 });
      expect(member(2)?.listening).toMatchObject({ title: "Other" });
      applyPresenceBatch(
        [{ user_id: 2, status: "idle", custom_status: "b-text", activity: null, listening: null }],
        false,
      );
      expect(member(2)?.activity).toBeNull();
      expect(member(2)?.listening).toBeNull();
    });

    it("drops a member's old expiry when the entry changes their text, and keeps it otherwise", () => {
      applyPresenceBatch([{ user_id: 2, status: "idle", custom_status: "b-text" }], false);
      expect(member(2)?.customStatusExpiresAt).toBe("2030-01-01T00:00:00Z");
      applyPresenceBatch([{ user_id: 2, status: "idle", custom_status: "other" }], false);
      expect(member(2)?.customStatusExpiresAt).toBeNull();
    });

    it("is one store update for the whole batch", () => {
      const listener = vi.fn();
      const unsub = membersStore.subscribe(listener);
      applyPresenceBatch(
        [
          { user_id: 1, status: "dnd", custom_status: null },
          { user_id: 2, status: "dnd", custom_status: null },
        ],
        false,
      );
      membersStore.flush();
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
    });
  });

  describe("applyReadyActivities", () => {
    beforeEach(() => {
      setMembers([ALICE, BOB]);
    });

    it("gives the listed members their game and everyone else none", () => {
      applyReadyActivities([{ user_id: 1, name: "Chess", started_at: 4 }]);
      expect(member(1)?.activity).toEqual({ name: "Chess", startedAt: 4 });
      expect(member(2)?.activity).toBeNull();
    });

    it("ignores a blank game name", () => {
      applyReadyActivities([{ user_id: 1, name: " ", started_at: 4 }]);
      expect(member(1)?.activity).toBeNull();
    });

    it("clears a game the new list no longer has", () => {
      applyReadyActivities([{ user_id: 1, name: "Chess", started_at: 4 }]);
      applyReadyActivities([]);
      expect(member(1)?.activity).toBeNull();
    });

    it("replaces a game whose start time or name changed", () => {
      applyReadyActivities([{ user_id: 1, name: "Chess", started_at: 4 }]);
      applyReadyActivities([{ user_id: 1, name: "Chess", started_at: 5 }]);
      expect(member(1)?.activity).toEqual({ name: "Chess", startedAt: 5 });
      applyReadyActivities([{ user_id: 1, name: "Go", started_at: 5 }]);
      expect(member(1)?.activity).toEqual({ name: "Go", startedAt: 5 });
    });

    it("leaves an unchanged member's entry untouched", () => {
      applyReadyActivities([{ user_id: 1, name: "Chess", started_at: 4 }]);
      const before = member(1);
      const bob = member(2);
      applyReadyActivities([{ user_id: 1, name: "Chess", started_at: 4 }]);
      expect(member(1)).toBe(before);
      expect(member(2)).toBe(bob);
    });

    it("states an explicit null for a member that had no activity key yet", () => {
      expect(Object.keys(member(2) ?? {})).not.toContain("activity");
      applyReadyActivities([]);
      expect(Object.keys(member(2) ?? {})).toContain("activity");
      expect(member(2)?.activity).toBeNull();
    });
  });

  describe("applyReadyListening", () => {
    beforeEach(() => {
      setMembers([ALICE, BOB]);
    });

    it("gives the listed members their song and everyone else none", () => {
      applyReadyListening([{ user_id: 1, ...SONG }]);
      expect(member(1)?.listening).toEqual({
        title: "Song",
        artist: "Band",
        player: "VLC",
        startedAt: 100,
        durationMs: 3000,
      });
      expect(member(2)?.listening).toBeNull();
    });

    it("ignores a song without a title", () => {
      applyReadyListening([{ user_id: 1, ...SONG, title: "" }]);
      expect(member(1)?.listening).toBeNull();
    });

    it("replaces a changed song and clears one the list dropped", () => {
      applyReadyListening([{ user_id: 1, ...SONG }]);
      applyReadyListening([{ user_id: 1, ...SONG, started_at: 101 }]);
      expect(member(1)?.listening?.startedAt).toBe(101);
      applyReadyListening([]);
      expect(member(1)?.listening).toBeNull();
    });

    it("leaves an unchanged member's entry untouched", () => {
      applyReadyListening([{ user_id: 1, ...SONG }]);
      const before = member(1);
      const bob = member(2);
      applyReadyListening([{ user_id: 1, ...SONG }]);
      expect(member(1)).toBe(before);
      expect(member(2)).toBe(bob);
    });

    it("states an explicit null for a member that had no listening key yet", () => {
      expect(Object.keys(member(2) ?? {})).not.toContain("listening");
      applyReadyListening([]);
      expect(Object.keys(member(2) ?? {})).toContain("listening");
      expect(member(2)?.listening).toBeNull();
    });
  });

  describe("memberDisplayName", () => {
    it("prefers a non-blank nickname and falls back to the username", () => {
      expect(memberDisplayName({ username: "u", displayName: "Nick" })).toBe("Nick");
      expect(memberDisplayName({ username: "u", displayName: "" })).toBe("u");
      expect(memberDisplayName({ username: "u", displayName: "   " })).toBe("u");
      expect(memberDisplayName({ username: "u", displayName: null })).toBe("u");
      expect(memberDisplayName({ username: "u" })).toBe("u");
    });

    it("returns the nickname untrimmed", () => {
      expect(memberDisplayName({ username: "u", displayName: " Nick " })).toBe(" Nick ");
    });
  });

  describe("typing", () => {
    beforeEach(() => {
      setMembers([ALICE, BOB]);
    });

    it("clears after exactly five seconds", () => {
      setTyping(5, 1);
      vi.advanceTimersByTime(4999);
      expect(getTypingUsers(5)).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(getTypingUsers(5)).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps separate timers for the same user in different channels", () => {
      setTyping(5, 1);
      setTyping(6, 1);
      expect(vi.getTimerCount()).toBe(2);
      clearTyping(5, 1);
      expect(vi.getTimerCount()).toBe(1);
      expect(getTypingUsers(6)).toHaveLength(1);
    });

    it("does not mix up channel and user ids that join to the same digits", () => {
      setMembers([
        { ...ALICE, id: 23 },
        { ...BOB, id: 3 },
      ]);
      setTyping(1, 23);
      setTyping(12, 3);
      expect(vi.getTimerCount()).toBe(2);
      clearTyping(12, 3);
      expect(getTypingUsers(1).map((m) => m.id)).toEqual([23]);
      expect(getTypingUsers(12)).toEqual([]);
    });

    it("restarts the five seconds when the same user types again", () => {
      setTyping(5, 1);
      vi.advanceTimersByTime(3000);
      setTyping(5, 1);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(4000);
      expect(getTypingUsers(5)).toHaveLength(1);
      vi.advanceTimersByTime(1000);
      expect(getTypingUsers(5)).toHaveLength(0);
    });

    it("cancels the timer when the user is cleared", () => {
      setTyping(5, 1);
      clearTyping(5, 1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps the channel's other typists when one is cleared", () => {
      setTyping(5, 1);
      setTyping(5, 2);
      clearTyping(5, 1);
      expect(getTypingUsers(5).map((m) => m.id)).toEqual([2]);
      expect(membersStore.getState().typingUsers.has(5)).toBe(true);
    });

    it("drops the channel entry when its last typist is cleared", () => {
      setTyping(5, 1);
      clearTyping(5, 1);
      expect(membersStore.getState().typingUsers.has(5)).toBe(false);
    });

    it("returns the same state when the cleared user was not typing", () => {
      setTyping(5, 1);
      const before = membersStore.getState();
      clearTyping(5, 2);
      clearTyping(9, 1);
      expect(membersStore.getState()).toBe(before);
    });

    it("lists no typists for a channel whose set is empty", () => {
      membersStore.setState((prev) => ({
        ...prev,
        typingUsers: new Map([[5, new Set<number>()]]),
      }));
      expect(getTypingUsers(5)).toEqual([]);
    });
  });

  describe("getOnlineMembers", () => {
    it("includes online, idle and dnd members and leaves out offline and invisible", () => {
      setMembers([
        { ...ALICE, status: "online" },
        { ...BOB, status: "idle" },
        { ...ALICE, id: 3, username: "c", status: "dnd" },
        { ...ALICE, id: 4, username: "d", status: "offline" },
        { ...ALICE, id: 5, username: "e", status: "invisible" },
      ]);
      expect(getOnlineMembers().map((m) => m.id)).toEqual([1, 2, 3]);
    });
  });

  describe("resetMembersStore", () => {
    it("forgets the roster, typing and timers and bumps both revisions", () => {
      setMembers([ALICE]);
      setTyping(5, 1);
      const before = membersStore.getState();
      resetMembersStore();
      const after = membersStore.getState();
      expect(after.members.size).toBe(0);
      expect(after.typingUsers.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(after.roleRevision).toBe((before.roleRevision ?? 0) + 1);
      expect(after.snapshotRevision).toBe((before.snapshotRevision ?? 0) + 1);
    });

    it("counts revisions from 0 when the state never had them", () => {
      resetMembersState();
      resetMembersStore();
      expect(membersStore.getState().roleRevision).toBe(1);
      expect(membersStore.getState().snapshotRevision).toBe(1);
    });

    it("runs on sign-out through the session registry", () => {
      setMembers([ALICE]);
      expect(listSessionResets()).toContain("members:store");
      expect(runSessionResets("user")).toEqual([]);
      expect(membersStore.getState().members.size).toBe(0);
    });
  });
});

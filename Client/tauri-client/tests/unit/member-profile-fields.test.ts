import { describe, it, expect, beforeEach } from "vitest";
import {
  membersStore,
  memberDisplayName,
  setMembers,
  updateMemberProfile,
  updatePresence,
} from "@stores/members.store";
import type { ReadyMember } from "@lib/types";

/**
 * Display names and custom statuses through the member store. Two rules carry
 * the weight: the display name falls back to the username everywhere, and a
 * partial update must not blank a field it did not mention (the auto-idle
 * timer sends a bare status flip several times an hour).
 */

const alice: ReadyMember = {
  id: 1,
  username: "alice",
  avatar: null,
  role: "member",
  status: "online",
  display_name: "Alice A.",
  custom_status: "shipping phase 6",
};

const bob: ReadyMember = {
  id: 2,
  username: "bob",
  avatar: null,
  role: "member",
  status: "idle",
};

describe("memberDisplayName", () => {
  it("prefers the display name and falls back to the username", () => {
    expect(memberDisplayName({ username: "alice", displayName: "Alice A." })).toBe("Alice A.");
    expect(memberDisplayName({ username: "bob", displayName: null })).toBe("bob");
    expect(memberDisplayName({ username: "bob" })).toBe("bob");
    expect(memberDisplayName({ username: "bob", displayName: "  " })).toBe("bob");
  });
});

describe("members store profile fields", () => {
  beforeEach(() => {
    setMembers([]);
  });

  it("carries display name and custom status from ready", () => {
    setMembers([alice, bob]);
    const a = membersStore.getState().members.get(1)!;
    expect(a.displayName).toBe("Alice A.");
    expect(a.customStatus).toBe("shipping phase 6");

    // A member the server sent neither field for is explicitly null, not
    // undefined — the store normalises so renderers only handle one absence.
    const b = membersStore.getState().members.get(2)!;
    expect(b.displayName).toBeNull();
    expect(b.customStatus).toBeNull();
  });

  it("a bare presence update leaves the custom status alone", () => {
    setMembers([alice]);
    updatePresence(1, "idle");
    const a = membersStore.getState().members.get(1)!;
    expect(a.status).toBe("idle");
    expect(a.customStatus).toBe("shipping phase 6");
  });

  it("a presence update carrying the field replaces it, null included", () => {
    setMembers([alice]);
    updatePresence(1, "online", "back");
    expect(membersStore.getState().members.get(1)!.customStatus).toBe("back");

    updatePresence(1, "online", null);
    expect(membersStore.getState().members.get(1)!.customStatus).toBeNull();
  });

  it("accepts invisible as a status (the signed-in user's own)", () => {
    setMembers([alice]);
    updatePresence(1, "invisible");
    expect(membersStore.getState().members.get(1)!.status).toBe("invisible");
  });

  it("user_update replaces the display name, and omitting it preserves it", () => {
    setMembers([alice]);

    updateMemberProfile(1, { username: "alice", avatar: null, displayName: "Ada" });
    expect(membersStore.getState().members.get(1)!.displayName).toBe("Ada");

    // An older server's user_update has no display_name; it must not wipe one.
    updateMemberProfile(1, { username: "alice", avatar: null });
    expect(membersStore.getState().members.get(1)!.displayName).toBe("Ada");

    // An explicit null is a clear.
    updateMemberProfile(1, { username: "alice", avatar: null, displayName: null });
    expect(membersStore.getState().members.get(1)!.displayName).toBeNull();
  });

  it("user_update does not clobber a pinned identity key when omitted", () => {
    setMembers([{ ...alice, identity_public_key: "KEY" }]);
    updateMemberProfile(1, { username: "alice", avatar: "/api/v1/files/x" });
    const a = membersStore.getState().members.get(1)!;
    expect(a.identityPublicKey).toBe("KEY");
    expect(a.avatar).toBe("/api/v1/files/x");
  });

  it("keeps state immutable across updates", () => {
    setMembers([alice]);
    const before = membersStore.getState();
    updatePresence(1, "dnd");
    const after = membersStore.getState();
    expect(after).not.toBe(before);
    expect(after.members).not.toBe(before.members);
    expect(before.members.get(1)!.status).toBe("online");
  });
});

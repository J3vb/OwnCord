import { describe, it, expect, vi, beforeEach } from "vitest";

const { createPopupMock } = vi.hoisted(() => ({
  createPopupMock: vi.fn((_opts: unknown) => ({
    mount: vi.fn(),
    destroy: vi.fn(),
    isOpen: () => true,
  })),
}));
vi.mock("@components/UserProfilePopup", () => ({ createUserProfilePopup: createPopupMock }));

import { openUserProfilePopup } from "../../src/features/profiles/openUserProfilePopup";
import { handleUserUpdate } from "../../src/features/channels/wsHandlers";
import { membersStore, setMembers, addMember } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import type { ReadyMember, MemberJoinPayload } from "../../src/lib/types";

const CREATED = "2025-03-04T10:00:00Z";

const BOB: ReadyMember = {
  id: 7,
  username: "bob",
  avatar: null,
  role: "member",
  status: "online",
  about: "Hello there",
  created_at: CREATED,
};

describe("about and created_at on members (3C-7a)", () => {
  beforeEach(() => {
    setMembers([]);
    authStore.setState((p) => ({ ...p, user: { ...(p.user as object), id: 1 } as never }));
  });

  it("ready stores about and created_at", () => {
    setMembers([BOB]);
    const m = membersStore.getState().members.get(7)!;
    expect(m.about).toBe("Hello there");
    expect(m.createdAt).toBe(CREATED);
  });

  it("member_join stores about and created_at", () => {
    const payload: MemberJoinPayload = {
      user: {
        id: 8,
        username: "cy",
        avatar: null,
        role: "member",
        about: null,
        created_at: CREATED,
      },
      status: "online",
    };
    addMember(payload);
    const m = membersStore.getState().members.get(8)!;
    expect(m.about).toBeNull();
    expect(m.createdAt).toBe(CREATED);
  });

  it("an older server (fields absent) leaves them undefined", () => {
    setMembers([{ id: 9, username: "old", avatar: null, role: "member", status: "online" }]);
    const m = membersStore.getState().members.get(9)!;
    expect(m.about).toBeUndefined();
    expect(m.createdAt).toBeUndefined();
  });

  it("user_update changes another member's about, and null clears it", () => {
    setMembers([BOB]);
    handleUserUpdate({ user_id: 7, username: "bob", avatar: null, about: "New text" });
    expect(membersStore.getState().members.get(7)!.about).toBe("New text");
    handleUserUpdate({ user_id: 7, username: "bob", avatar: null, about: null });
    expect(membersStore.getState().members.get(7)!.about).toBeNull();
  });

  it("user_update without about leaves it untouched", () => {
    setMembers([BOB]);
    handleUserUpdate({ user_id: 7, username: "bobby", avatar: null });
    const m = membersStore.getState().members.get(7)!;
    expect(m.username).toBe("bobby");
    expect(m.about).toBe("Hello there");
  });
});

describe("banner on user_update", () => {
  beforeEach(() => {
    setMembers([{ ...BOB, banner: "/api/v1/files/5", banner_color: "#123456" }]);
    authStore.setState((p) => ({
      ...p,
      user: { id: 7, username: "bob", avatar: null, role: "member", banner: "/api/v1/files/5" },
    }));
  });

  it("an old server's user_update (no banner keys) keeps the banner", () => {
    handleUserUpdate({ user_id: 7, username: "bobby", avatar: null });
    expect(membersStore.getState().members.get(7)).toMatchObject({
      banner: "/api/v1/files/5",
      banner_color: "#123456",
    });
    expect(authStore.getState().user?.banner).toBe("/api/v1/files/5");
  });

  it("a new server's null clears the banner, on the member and on the signed-in user", () => {
    handleUserUpdate({
      user_id: 7,
      username: "bob",
      avatar: null,
      banner: null,
      banner_color: null,
    });
    expect(membersStore.getState().members.get(7)).toMatchObject({
      banner: null,
      banner_color: null,
    });
    expect(authStore.getState().user?.banner).toBeNull();
    expect(authStore.getState().user?.banner_color).toBeNull();
  });
});

describe("profile popup receives about and join date (3C-7a)", () => {
  beforeEach(() => {
    createPopupMock.mockClear();
    authStore.setState((p) => ({ ...p, user: { ...(p.user as object), id: 1 } as never }));
  });

  async function open(): Promise<{ user: Record<string, unknown> }> {
    openUserProfilePopup({ userId: 7, anchorX: 1, anchorY: 1 });
    await vi.waitFor(() => expect(createPopupMock).toHaveBeenCalled());
    return createPopupMock.mock.calls[0]![0] as { user: Record<string, unknown> };
  }

  it("passes about and a formatted joinDate", async () => {
    setMembers([BOB]);
    const { user } = await open();
    expect(user["about"]).toBe("Hello there");
    expect(typeof user["joinDate"]).toBe("string");
    expect(user["joinDate"]).toBe("March 4, 2025");
  });

  it("omits both when the server did not send them", async () => {
    setMembers([{ id: 7, username: "bob", avatar: null, role: "member", status: "online" }]);
    const { user } = await open();
    expect("about" in user).toBe(false);
    expect("joinDate" in user).toBe(false);
  });
});

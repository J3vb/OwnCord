import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemberList } from "@components/MemberList";
import type { MemberListOptions } from "@components/MemberList";
import { membersStore, updatePresence, updateMemberRole } from "@stores/members.store";
import type { Member } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { channelsStore, setRoles } from "@stores/channels.store";
import { Permission, type UserStatus } from "../../src/lib/types";

function resetStore(): void {
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
  // Role list drives member-list grouping/colors — reset so tests that seed
  // roles don't leak into the ones asserting the fallback groups.
  setRoles([]);
}

function makeMember(overrides: Partial<Member> & { id: number; username: string }): Member {
  return {
    avatar: null,
    role: "member",
    status: "online" as UserStatus,
    ...overrides,
  };
}

function setTestMembers(members: Member[]): void {
  const map = new Map<number, Member>();
  for (const m of members) {
    map.set(m.id, m);
  }
  membersStore.setState((prev) => ({ ...prev, members: map }));
}

const testMembers: Member[] = [
  makeMember({ id: 1, username: "Alice", role: "owner", status: "online" as UserStatus }),
  makeMember({ id: 2, username: "Bob", role: "admin", status: "idle" as UserStatus }),
  makeMember({ id: 3, username: "Charlie", role: "moderator", status: "online" as UserStatus }),
  makeMember({ id: 4, username: "Dave", role: "member", status: "offline" as UserStatus }),
  makeMember({ id: 5, username: "Eve", role: "member", status: "online" as UserStatus }),
  makeMember({ id: 6, username: "Frank", role: "admin", status: "online" as UserStatus }),
];

function defaultOpts(): MemberListOptions {
  return {
    currentUserRole: "admin",
    onKick: vi.fn().mockResolvedValue(undefined),
    onBan: vi.fn().mockResolvedValue(undefined),
    onChangeRole: vi.fn().mockResolvedValue(undefined),
    onToggleBlock: vi.fn().mockResolvedValue(undefined),
  };
}

describe("MemberList", () => {
  let container: HTMLDivElement;
  let memberList: ReturnType<typeof createMemberList>;

  beforeEach(() => {
    resetStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    memberList = createMemberList(defaultOpts());
  });

  afterEach(() => {
    memberList.destroy?.();
    container.remove();
  });

  it("mounts with member-list class", () => {
    setTestMembers(testMembers);
    memberList.mount(container);

    const root = container.querySelector(".member-list");
    expect(root).not.toBeNull();
    expect(root!.getAttribute("data-testid")).toBe("member-list");
  });

  it("groups members by role (OWNER, ADMIN, MODERATOR, MEMBER)", () => {
    setTestMembers(testMembers);
    memberList.mount(container);

    const headers = container.querySelectorAll(".member-role-group");
    const headerTexts = Array.from(headers).map((h) => h.textContent);

    // Should have all 4 role groups
    expect(headers.length).toBe(4);
    expect(headerTexts[0]).toContain("OWNER");
    expect(headerTexts[1]).toContain("ADMIN");
    expect(headerTexts[2]).toContain("MODERATOR");
    expect(headerTexts[3]).toContain("MEMBER");
  });

  it("sorts by status within groups (online first)", () => {
    // Two admins: Frank (online) and Bob (idle)
    setTestMembers(testMembers);
    memberList.mount(container);

    const memberItems = container.querySelectorAll(".member-item");
    const adminItems: HTMLDivElement[] = [];
    let inAdminGroup = false;

    // Walk items in DOM order to extract admin group members
    const allElements = container.querySelectorAll(".member-role-group, .member-item");
    for (const el of allElements) {
      if (el.classList.contains("member-role-group")) {
        inAdminGroup = el.textContent?.includes("ADMIN") ?? false;
      } else if (inAdminGroup && el.classList.contains("member-item")) {
        adminItems.push(el as HTMLDivElement);
      }
    }

    expect(adminItems.length).toBe(2);
    // Frank (online, priority 0) should come before Bob (idle, priority 1)
    expect(adminItems[0]!.getAttribute("data-testid")).toBe("member-6"); // Frank
    expect(adminItems[1]!.getAttribute("data-testid")).toBe("member-2"); // Bob
  });

  it("shows role group headers with count", () => {
    setTestMembers(testMembers);
    memberList.mount(container);

    const headers = container.querySelectorAll(".member-role-group");
    const headerTexts = Array.from(headers).map((h) => h.textContent);

    // OWNER has 1, ADMIN has 2, MODERATOR has 1, MEMBER has 2
    expect(headerTexts[0]).toContain("1");
    expect(headerTexts[1]).toContain("2");
    expect(headerTexts[2]).toContain("1");
    expect(headerTexts[3]).toContain("2");
  });

  it("shows member avatars with first letter", () => {
    setTestMembers(testMembers);
    memberList.mount(container);

    const avatars = container.querySelectorAll(".mi-avatar");
    const letters = Array.from(avatars).map((a) => a.textContent?.trim());

    expect(letters).toContain("A"); // Alice
    expect(letters).toContain("B"); // Bob
    expect(letters).toContain("C"); // Charlie
  });

  it("offline members have offline class", () => {
    setTestMembers(testMembers);
    memberList.mount(container);

    // Dave (id 4) is offline
    const daveItem = container.querySelector('[data-testid="member-4"]');
    expect(daveItem).not.toBeNull();
    expect(daveItem!.classList.contains("offline")).toBe(true);

    // Eve (id 5) is online, should NOT have offline class
    const eveItem = container.querySelector('[data-testid="member-5"]');
    expect(eveItem).not.toBeNull();
    expect(eveItem!.classList.contains("offline")).toBe(false);
  });

  it("empty store renders no groups", () => {
    memberList.mount(container);

    const headers = container.querySelectorAll(".member-role-group");
    expect(headers.length).toBe(0);

    const items = container.querySelectorAll(".member-item");
    expect(items.length).toBe(0);
  });

  it("destroy removes DOM", () => {
    setTestMembers(testMembers);
    memberList.mount(container);

    expect(container.querySelector(".member-list")).not.toBeNull();
    memberList.destroy?.();
    expect(container.querySelector(".member-list")).toBeNull();
  });

  it("reacts to store changes", () => {
    memberList.mount(container);
    expect(container.querySelectorAll(".member-item").length).toBe(0);

    // Add members after mount
    setTestMembers(testMembers);
    membersStore.flush();

    expect(container.querySelectorAll(".member-item").length).toBe(6);
  });

  it("shows empty state message when no members", () => {
    memberList.mount(container);

    const emptyState = container.querySelector(".member-list-empty");
    expect(emptyState).not.toBeNull();
    const emptyText = container.querySelector(".member-list-empty-text");
    expect(emptyText?.textContent).toBe("No members online");
  });

  it("skips role groups that have no members", () => {
    // Only add an owner — other groups should not render
    setTestMembers([
      makeMember({ id: 1, username: "Alice", role: "owner", status: "online" as UserStatus }),
    ]);
    memberList.mount(container);

    const headers = container.querySelectorAll(".member-role-group");
    expect(headers.length).toBe(1);
    expect(headers[0]!.textContent).toContain("OWNER");
  });

  it("applies status color to the status dot", () => {
    setTestMembers([
      makeMember({ id: 1, username: "Alice", role: "member", status: "online" as UserStatus }),
      makeMember({ id: 2, username: "Bob", role: "member", status: "dnd" as UserStatus }),
    ]);
    memberList.mount(container);

    const statusDots = container.querySelectorAll(".mi-status");
    const aliceDot = statusDots[0] as HTMLDivElement;
    const bobDot = statusDots[1] as HTMLDivElement;

    expect(aliceDot.style.background).toBe("var(--green)");
    expect(bobDot.style.background).toBe("var(--red)");
  });

  it("offers the server's own roles in the Change Role submenu", () => {
    // A hardcoded list left custom roles unassignable — and unresolvable to a
    // role id, so choosing one silently did nothing.
    setRoles([
      { id: 1, name: "Owner", color: null, permissions: 0 },
      { id: 2, name: "Staff", color: null, permissions: 0 },
      { id: 3, name: "VIP", color: null, permissions: 0 },
    ]);
    authStore.setState(() => ({
      token: "tok",
      user: { id: 99, username: "Admin", avatar: null, role: "admin" },
      serverName: "Test",
      motd: null,
      isAuthenticated: true,
    }));
    setTestMembers(testMembers);
    memberList.mount(container);

    const memberItem = container.querySelector('[data-testid="member-3"]') as HTMLDivElement;
    memberItem.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    const submenu = document.body.querySelector(".context-menu__submenu");
    expect(submenu).not.toBeNull();
    const roleLabels = Array.from(submenu!.querySelectorAll(".context-menu__item")).map(
      (i) => i.textContent,
    );
    // "owner" is not a context-menu action.
    expect(roleLabels).toEqual(["staff", "vip"]);

    document.body.querySelector(".context-menu")?.remove();
  });

  it("re-renders groups when a roles_update replaces the role list", () => {
    // Role management makes the list mutable mid-session. Before this the list
    // only re-rendered on a member change, so a rename/recolor/delete sat
    // invisible until unrelated traffic arrived.
    setRoles([
      { id: 1, name: "Owner", color: "#E74C3C", permissions: 0 },
      { id: 2, name: "Staff", color: "#00FF00", permissions: 0 },
    ]);
    setTestMembers([
      makeMember({ id: 2, username: "Stan", role: "staff", status: "online" as UserStatus }),
    ]);
    memberList.mount(container);
    expect(
      Array.from(container.querySelectorAll(".member-role-group")).map((h) => h.textContent),
    ).toContainEqual(expect.stringContaining("STAFF"));

    setRoles([
      { id: 1, name: "Owner", color: "#E74C3C", permissions: 0, position: 100 },
      { id: 2, name: "Staff", color: "#0000FF", permissions: 0, position: 50 },
    ]);
    // Store notifications are batched onto a microtask.
    channelsStore.flush();

    const stanName = container.querySelector('[data-testid="member-2"] .mi-name');
    expect((stanName as HTMLSpanElement).style.color).toBe("rgb(0, 0, 255)");
  });

  it("renders groups for custom server roles, colored by the server's role color", () => {
    setRoles([
      { id: 1, name: "Owner", color: "#E74C3C", permissions: 0 },
      { id: 2, name: "Staff", color: "#00FF00", permissions: 0 },
    ]);
    setTestMembers([
      makeMember({ id: 1, username: "Alice", role: "owner", status: "online" as UserStatus }),
      makeMember({ id: 2, username: "Stan", role: "staff", status: "online" as UserStatus }),
    ]);
    memberList.mount(container);

    const headers = Array.from(container.querySelectorAll(".member-role-group")).map(
      (h) => h.textContent,
    );
    expect(headers[0]).toContain("OWNER");
    expect(headers[1]).toContain("STAFF");

    const stanName = container.querySelector('[data-testid="member-2"] .mi-name');
    expect((stanName as HTMLSpanElement).style.color).toBe("rgb(0, 255, 0)");
  });

  it("members with a role missing from the server list still render", () => {
    setRoles([{ id: 1, name: "Owner", color: null, permissions: 0 }]);
    setTestMembers([
      makeMember({ id: 1, username: "Alice", role: "owner", status: "online" as UserStatus }),
      makeMember({ id: 2, username: "Ghost", role: "phantom", status: "online" as UserStatus }),
    ]);
    memberList.mount(container);

    expect(container.querySelector('[data-testid="member-2"]')).not.toBeNull();
    const headers = Array.from(container.querySelectorAll(".member-role-group")).map(
      (h) => h.textContent,
    );
    expect(headers.some((h) => h?.includes("PHANTOM"))).toBe(true);
  });

  it("non-admin context menu shows only Block, no admin actions", () => {
    setTestMembers(testMembers);
    const opts: MemberListOptions = {
      currentUserRole: "member",
      onKick: vi.fn().mockResolvedValue(undefined),
      onBan: vi.fn().mockResolvedValue(undefined),
      onChangeRole: vi.fn().mockResolvedValue(undefined),
      onToggleBlock: vi.fn().mockResolvedValue(undefined),
    };
    memberList.destroy?.();
    memberList = createMemberList(opts);
    memberList.mount(container);

    const memberItem = container.querySelector('[data-testid="member-3"]') as HTMLDivElement;
    memberItem.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    const contextMenu = document.body.querySelector(".context-menu");
    expect(contextMenu).not.toBeNull();
    const labels = Array.from(contextMenu!.querySelectorAll(".context-menu__item")).map(
      (i) => i.textContent,
    );
    expect(labels).toEqual(["Block"]);

    document.body.querySelector(".context-menu")?.remove();
  });

  // The menu used to gate on the role NAME (owner/admin), so the seeded
  // Moderator role — which holds KICK_MEMBERS and BAN_MEMBERS — got nothing,
  // and a custom role holding those bits got nothing either.
  describe("permission-driven moderation items", () => {
    /** Mirrors the seeded Moderator mask (0x000FFFFF): MANAGE_MESSAGES,
     *  MANAGE_CHANNELS, KICK_MEMBERS, BAN_MEMBERS — no MANAGE_ROLES. */
    const MODERATOR_MASK = 0x000fffff;

    function openMenuAs(roleName: string, permissions: number): string[] {
      setRoles([{ id: 7, name: roleName, color: null, permissions }]);
      setTestMembers(testMembers);
      const opts: MemberListOptions = { ...defaultOpts(), currentUserRole: roleName };
      memberList.destroy?.();
      memberList = createMemberList(opts);
      memberList.mount(container);

      const memberItem = container.querySelector('[data-testid="member-3"]') as HTMLDivElement;
      memberItem.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      const menu = document.body.querySelector(".context-menu");
      expect(menu).not.toBeNull();
      // Submenu role options share the item class; only top-level items count.
      return Array.from(menu!.children)
        .filter((el) => el.classList.contains("context-menu__item"))
        .map((el) => el.firstChild?.textContent ?? "");
    }

    afterEach(() => {
      document.body.querySelector(".context-menu")?.remove();
    });

    it("shows Force Logout and Ban but not Change Role for a moderator mask", () => {
      const labels = openMenuAs("moderator", MODERATOR_MASK);
      expect(labels).toContain("Force Logout");
      expect(labels).toContain("Ban");
      expect(labels).not.toContain("Change Role");
      expect(labels).toContain("Block");
    });

    it("shows Change Role only when MANAGE_ROLES is held", () => {
      const labels = openMenuAs("staff", Permission.MANAGE_ROLES | Permission.KICK_MEMBERS);
      expect(labels).toContain("Change Role");
      expect(labels).toContain("Force Logout");
      expect(labels).not.toContain("Ban");
    });

    it("shows every moderation item for the ADMINISTRATOR bit", () => {
      const labels = openMenuAs("admin", Permission.ADMINISTRATOR);
      expect(labels).toEqual(
        expect.arrayContaining(["Change Role", "Force Logout", "Ban", "Block"]),
      );
    });

    it("shows only Block for a role whose mask holds no moderation bits", () => {
      const labels = openMenuAs("member", Permission.SEND_MESSAGES | Permission.READ_MESSAGES);
      expect(labels).toEqual(["Block"]);
    });
  });

  it("context menu does not appear when right-clicking yourself", () => {
    // Set authStore so current user is id=1 (Alice)
    authStore.setState(() => ({
      token: "tok",
      user: { id: 1, username: "Alice", avatar: null, role: "owner" },
      serverName: "Test",
      motd: null,
      isAuthenticated: true,
    }));

    setTestMembers(testMembers);
    const opts: MemberListOptions = {
      currentUserRole: "owner",
      onKick: vi.fn().mockResolvedValue(undefined),
      onBan: vi.fn().mockResolvedValue(undefined),
      onChangeRole: vi.fn().mockResolvedValue(undefined),
      onToggleBlock: vi.fn().mockResolvedValue(undefined),
    };
    memberList.destroy?.();
    memberList = createMemberList(opts);
    memberList.mount(container);

    // Right-click on Alice (user id 1 = self)
    const selfItem = container.querySelector('[data-testid="member-1"]') as HTMLDivElement;
    selfItem.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    // No context menu should appear for yourself
    const contextMenu = document.body.querySelector(".admin-context-menu, .context-menu");
    expect(contextMenu).toBeNull();
  });

  it("displays member names with role-colored text", () => {
    setTestMembers([
      makeMember({ id: 1, username: "OwnerUser", role: "owner", status: "online" as UserStatus }),
    ]);
    memberList.mount(container);

    const nameEl = container.querySelector(".mi-name") as HTMLSpanElement;
    expect(nameEl.textContent).toBe("OwnerUser");
    // Owner role has specific color var
    expect(nameEl.style.color).toBe("var(--role-owner, #e74c3c)");
  });

  it("uses '?' as avatar fallback for empty username", () => {
    setTestMembers([
      makeMember({ id: 1, username: "", role: "member", status: "online" as UserStatus }),
    ]);
    memberList.mount(container);

    const avatar = container.querySelector(".mi-avatar");
    // Empty string charAt(0) is "", toUpperCase is "" => fallback "?"
    expect(avatar?.textContent).toContain("?");
  });

  it("sorts dnd between idle and offline within a group", () => {
    setTestMembers([
      makeMember({ id: 1, username: "Offline", role: "member", status: "offline" as UserStatus }),
      makeMember({ id: 2, username: "Dnd", role: "member", status: "dnd" as UserStatus }),
      makeMember({ id: 3, username: "Online", role: "member", status: "online" as UserStatus }),
      makeMember({ id: 4, username: "Idle", role: "member", status: "idle" as UserStatus }),
    ]);
    memberList.mount(container);

    const items = container.querySelectorAll(".member-item");
    const names = Array.from(items).map((el) => el.querySelector(".mi-name")?.textContent);

    // Expected order: Online (0), Idle (1), Dnd (2), Offline (3)
    expect(names).toEqual(["Online", "Idle", "Dnd", "Offline"]);
  });

  it("patches a presence-only change in place, keeping row identity", () => {
    setTestMembers(testMembers);
    memberList.mount(container);

    const eveRowBefore = container.querySelector('[data-testid="member-5"]') as HTMLDivElement;
    expect(eveRowBefore).not.toBeNull();
    const allRowsBefore = Array.from(container.querySelectorAll(".member-item"));

    // Presence-only update (same username/role/avatar) — via the real action.
    updatePresence(5, "dnd");
    membersStore.flush();

    // Same DOM element — no rebuild, status dot patched in place.
    const eveRowAfter = container.querySelector('[data-testid="member-5"]');
    expect(eveRowAfter).toBe(eveRowBefore);
    const dot = eveRowAfter!.querySelector(".mi-status") as HTMLDivElement;
    expect(dot.style.background).toBe("var(--red)");
    expect(dot.getAttribute("aria-label")).toBe("dnd");
    expect(dot.title).toBe("dnd");

    // Every other row also kept its identity.
    const allRowsAfter = Array.from(container.querySelectorAll(".member-item"));
    expect(allRowsAfter).toEqual(allRowsBefore);
  });

  it("toggles the offline class in place when presence flips to/from offline", () => {
    setTestMembers(testMembers);
    memberList.mount(container);

    const eveRow = container.querySelector('[data-testid="member-5"]') as HTMLDivElement;
    expect(eveRow.classList.contains("offline")).toBe(false);

    updatePresence(5, "offline");
    membersStore.flush();
    expect(container.querySelector('[data-testid="member-5"]')).toBe(eveRow);
    expect(eveRow.classList.contains("offline")).toBe(true);

    updatePresence(5, "online");
    membersStore.flush();
    expect(container.querySelector('[data-testid="member-5"]')).toBe(eveRow);
    expect(eveRow.classList.contains("offline")).toBe(false);
  });

  it("still fully rebuilds when a member's role changes", () => {
    setTestMembers(testMembers);
    memberList.mount(container);

    const eveRowBefore = container.querySelector('[data-testid="member-5"]');

    updateMemberRole(5, "admin");
    membersStore.flush();

    // Structural change → rebuild: new row element, Eve now in the ADMIN group.
    const eveRowAfter = container.querySelector('[data-testid="member-5"]');
    expect(eveRowAfter).not.toBeNull();
    expect(eveRowAfter).not.toBe(eveRowBefore);
    const headerTexts = Array.from(container.querySelectorAll(".member-role-group")).map(
      (h) => h.textContent,
    );
    expect(headerTexts.find((t) => t?.includes("ADMIN"))).toContain("3");
  });

  it("re-renders when store updates to a different member set", () => {
    setTestMembers(testMembers);
    memberList.mount(container);

    expect(container.querySelectorAll(".member-item").length).toBe(6);

    // Remove all but one member
    setTestMembers([
      makeMember({ id: 99, username: "Solo", role: "member", status: "online" as UserStatus }),
    ]);
    membersStore.flush();

    expect(container.querySelectorAll(".member-item").length).toBe(1);
    expect(container.querySelector(".mi-name")?.textContent).toBe("Solo");
  });
});

// ─── Phase 6: display names, custom status, invisible ────────────────────────

describe("MemberList profile fields", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMemberList> | null = null;

  const opts: MemberListOptions = {
    currentUserRole: "member",
    onKick: vi.fn(),
    onBan: vi.fn(),
    onChangeRole: vi.fn(),
    onToggleBlock: vi.fn(),
  };

  beforeEach(() => {
    resetStore();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    list?.destroy?.();
    list = null;
    container.remove();
    resetStore();
  });

  it("renders the display name and falls back to the username", () => {
    setTestMembers([
      makeMember({ id: 1, username: "alice", displayName: "Alice A." }),
      makeMember({ id: 2, username: "bob", displayName: null }),
    ]);
    list = createMemberList(opts);
    list.mount(container);

    const names = Array.from(container.querySelectorAll(".mi-name")).map((el) => el.textContent);
    expect(names).toContain("Alice A.");
    expect(names).toContain("bob");
    // The username is not shown twice — the display name replaces it here.
    expect(names).not.toContain("alice");
  });

  it("shows a custom status under the name, and omits the line without one", () => {
    setTestMembers([
      makeMember({ id: 1, username: "alice", customStatus: "shipping phase 6" }),
      makeMember({ id: 2, username: "bob" }),
    ]);
    list = createMemberList(opts);
    list.mount(container);

    const withStatus = container.querySelector('[data-testid="member-custom-status-1"]');
    expect(withStatus?.textContent).toBe("shipping phase 6");
    expect(container.querySelector('[data-testid="member-custom-status-2"]')).toBeNull();
  });

  it("renders an invisible member the way it renders an offline one", () => {
    // Only ever the signed-in user's own row — everyone else is mapped to
    // offline server-side — but it has to look like what others see.
    setTestMembers([makeMember({ id: 1, username: "ghost", status: "invisible" as UserStatus })]);
    list = createMemberList(opts);
    list.mount(container);

    const row = container.querySelector('[data-testid="member-1"]');
    expect(row?.classList.contains("offline")).toBe(true);
  });

  it("re-renders (not just recolors) when a custom status changes", () => {
    setTestMembers([makeMember({ id: 1, username: "alice" })]);
    list = createMemberList(opts);
    list.mount(container);
    expect(container.querySelector('[data-testid="member-custom-status-1"]')).toBeNull();

    updatePresence(1, "online", "back in 5");
    membersStore.flush();
    // A custom status is its own line, so it needs a structural render — the
    // presence-only fast path would have left the row without it.
    expect(container.querySelector('[data-testid="member-custom-status-1"]')?.textContent).toBe(
      "back in 5",
    );
  });
});

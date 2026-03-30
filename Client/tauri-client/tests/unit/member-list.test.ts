import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemberList } from "@components/MemberList";
import type { MemberListOptions } from "@components/MemberList";
import { membersStore } from "@stores/members.store";
import type { Member } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import type { UserStatus } from "../../src/lib/types";

function resetStore(): void {
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
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
    setTestMembers([makeMember({ id: 1, username: "Alice", role: "owner", status: "online" as UserStatus })]);
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

  it("context menu does not appear for non-admin/non-owner roles", () => {
    setTestMembers(testMembers);
    const opts: MemberListOptions = {
      currentUserRole: "member",
      onKick: vi.fn().mockResolvedValue(undefined),
      onBan: vi.fn().mockResolvedValue(undefined),
      onChangeRole: vi.fn().mockResolvedValue(undefined),
    };
    memberList.destroy?.();
    memberList = createMemberList(opts);
    memberList.mount(container);

    const memberItem = container.querySelector('[data-testid="member-3"]') as HTMLDivElement;
    memberItem.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    // No context menu should be appended to body
    const contextMenu = document.body.querySelector(".admin-context-menu, .context-menu");
    expect(contextMenu).toBeNull();
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

  it("re-renders when store updates to a different member set", () => {
    setTestMembers(testMembers);
    memberList.mount(container);

    expect(container.querySelectorAll(".member-item").length).toBe(6);

    // Remove all but one member
    setTestMembers([makeMember({ id: 99, username: "Solo", role: "member", status: "online" as UserStatus })]);
    membersStore.flush();

    expect(container.querySelectorAll(".member-item").length).toBe(1);
    expect(container.querySelector(".mi-name")?.textContent).toBe("Solo");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemberList } from "@components/MemberList";
import { membersStore } from "@stores/members.store";
import type { Member } from "@stores/members.store";
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

describe("MemberList", () => {
  let container: HTMLDivElement;
  let memberList: ReturnType<typeof createMemberList>;

  beforeEach(() => {
    resetStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    memberList = createMemberList();
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
});

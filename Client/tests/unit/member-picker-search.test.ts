// WP 3B-5 (D13): the new-DM picker's search, sort, avatars, status labels and chips.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemberPickerModal } from "../../src/pages/main-page/MemberPickerModal";
import { membersStore } from "../../src/stores/members.store";
import { authStore } from "../../src/stores/auth.store";
import type { Member } from "../../src/stores/members.store";

vi.mock("../../src/components/message-list/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/components/message-list/attachments")>()),
  fetchImageAsObjectUrl: vi.fn().mockResolvedValue("blob:avatar-2"),
}));

function member(overrides: Partial<Member> & { id: number; username: string }): Member {
  return { avatar: null, role: "member", status: "online", ...overrides };
}

function setup(members: Member[]): void {
  membersStore.setState(() => ({
    members: new Map(members.map((m) => [m.id, m])),
    typingUsers: new Map(),
  }));
  authStore.setState(() => ({
    token: "t",
    user: { id: 1, username: "Me", avatar: null, role: "member" },
    serverName: "S",
    motd: null,
    isAuthenticated: true,
  }));
}

describe("member picker search, sort and chips", () => {
  let container: HTMLDivElement;
  let component: ReturnType<typeof createMemberPickerModal>;
  const onSelectGroup = vi.fn();

  const search = (): HTMLInputElement =>
    container.querySelector<HTMLInputElement>("[data-testid='dm-picker-search']")!;
  const rowIds = (): string[] =>
    [...container.querySelectorAll(".dm-member-picker-item")].map((r) =>
      r.getAttribute("data-testid")!.replace("dm-picker-member-", ""),
    );
  const type = (value: string): void => {
    search().value = value;
    search().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const row = (id: number): HTMLElement =>
    container.querySelector<HTMLElement>(`[data-testid='dm-picker-member-${id}']`)!;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    onSelectGroup.mockReset();
  });

  afterEach(() => {
    component.destroy?.();
    container.remove();
  });

  function mount(): void {
    component = createMemberPickerModal({
      onSelect: vi.fn(),
      onSelectGroup,
      onClose: vi.fn(),
    });
    component.mount(container);
  }

  it("focuses the search box on open", () => {
    setup([member({ id: 2, username: "alice" })]);
    mount();
    expect(document.activeElement).toBe(search());
  });

  it("filters by display name and username, case-insensitively", () => {
    setup([
      member({ id: 2, username: "alice", displayName: "Zed Zebra" }),
      member({ id: 3, username: "bob" }),
      member({ id: 4, username: "carol", displayName: "Carol Z" }),
    ]);
    mount();
    type("ZEB");
    expect(rowIds()).toEqual(["2"]);
    type("alice");
    expect(rowIds()).toEqual(["2"]);
    type("  BO ");
    expect(rowIds()).toEqual(["3"]);
    type("");
    expect(rowIds()).toHaveLength(3);
  });

  it("says no one matches when the search finds nobody", () => {
    setup([member({ id: 2, username: "alice" })]);
    mount();
    const empty = container.querySelector<HTMLElement>("[data-testid='dm-picker-empty']")!;
    expect(empty.hidden).toBe(true);
    type("zzz");
    expect(rowIds()).toEqual([]);
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe("No one matches");
    type("");
    expect(empty.hidden).toBe(true);
  });

  it("lists online, idle and dnd before offline, then by display name", () => {
    setup([
      member({ id: 2, username: "u2", displayName: "Yara", status: "offline" }),
      member({ id: 3, username: "u3", displayName: "Zoe", status: "online" }),
      member({ id: 4, username: "u4", displayName: "Abe", status: "offline" }),
      member({ id: 5, username: "u5", displayName: "mia", status: "dnd" }),
      member({ id: 6, username: "u6", displayName: "Bea", status: "idle" }),
    ]);
    mount();
    expect(rowIds()).toEqual(["6", "5", "3", "4", "2"]);
  });

  it("keeps the selection across filtering and shows removable chips", () => {
    setup([
      member({ id: 2, username: "alice" }),
      member({ id: 3, username: "bob" }),
      member({ id: 4, username: "carol" }),
    ]);
    mount();
    row(2).click();
    type("bob");
    row(3).click();
    expect(container.querySelector("[data-testid='dm-picker-chip-2']")).not.toBeNull();
    expect(container.querySelector("[data-testid='dm-picker-chip-3']")).not.toBeNull();

    type("");
    expect(row(2).classList.contains("selected")).toBe(true);
    expect(row(3).classList.contains("selected")).toBe(true);

    container.querySelector<HTMLElement>("[data-testid='dm-picker-chip-2']")!.click();
    expect(row(2).classList.contains("selected")).toBe(false);
    expect(container.querySelector("[data-testid='dm-picker-chip-2']")).toBeNull();

    row(4).click();
    container.querySelector<HTMLElement>("[data-testid='dm-picker-create']")!.click();
    expect(onSelectGroup).toHaveBeenCalledWith([3, 4], "");
  });

  it("labels each row with the status catalog, not the raw word", () => {
    setup([
      member({ id: 2, username: "a", status: "dnd" }),
      member({ id: 3, username: "b", status: "offline" }),
    ]);
    mount();
    expect(row(2).textContent).toContain("Do Not Disturb");
    expect(row(3).textContent).toContain("Offline");
  });

  it("draws the shared avatar element, loading the picture when there is one", async () => {
    setup([
      member({ id: 2, username: "alice", displayName: "Alice A", avatar: "/api/v1/files/9" }),
      member({ id: 3, username: "bob" }),
    ]);
    mount();
    const avatar = row(2).querySelector(".dm-member-picker-avatar");
    expect(avatar).not.toBeNull();
    expect(avatar!.querySelector(".avatar-initial")!.textContent).toBe("A");
    await vi.waitFor(() => {
      expect(avatar!.querySelector("img.avatar-img")?.getAttribute("src")).toBe("blob:avatar-2");
    });
    // Letter fallback colour is the shared per-username pick, not a fixed blue.
    expect(
      (row(3).querySelector(".dm-member-picker-avatar") as HTMLElement).style.background,
    ).not.toBe("");
  });
});

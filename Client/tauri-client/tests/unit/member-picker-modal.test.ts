import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemberPickerModal } from "../../src/pages/main-page/MemberPickerModal";
import { membersStore } from "../../src/stores/members.store";
import { authStore } from "../../src/stores/auth.store";
import type { Member } from "../../src/stores/members.store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMember(overrides: Partial<Member> & { id: number; username: string }): Member {
  return {
    avatar: null,
    role: "member",
    status: "online",
    ...overrides,
  };
}

function setStoreMembers(members: Member[]): void {
  const map = new Map<number, Member>();
  for (const m of members) {
    map.set(m.id, m);
  }
  membersStore.setState(() => ({
    members: map,
    typingUsers: new Map(),
  }));
}

function setCurrentUser(userId: number): void {
  authStore.setState(() => ({
    token: "test-token",
    user: { id: userId, username: "Me", avatar: null, role: "member" },
    serverName: "TestServer",
    motd: null,
    isAuthenticated: true,
  }));
}

function resetStores(): void {
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
  authStore.setState(() => ({
    token: null,
    user: null,
    serverName: null,
    motd: null,
    isAuthenticated: false,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMemberPickerModal", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    // Clean up any stray modal overlays
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
  });

  // --- Basic rendering ---

  it("returns a MountableComponent with mount and destroy methods", () => {
    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });

    expect(typeof component.mount).toBe("function");
    expect(typeof component.destroy).toBe("function");
  });

  it("mounts a modal overlay into the container", () => {
    setCurrentUser(1);
    setStoreMembers([]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const overlay = container.querySelector(".modal-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.classList.contains("visible")).toBe(true);

    component.destroy!();
  });

  it("renders the modal with dm-member-picker-modal class", () => {
    setCurrentUser(1);
    setStoreMembers([]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const modal = container.querySelector(".dm-member-picker-modal");
    expect(modal).not.toBeNull();

    component.destroy!();
  });

  it("shows 'New Direct Message' title", () => {
    setCurrentUser(1);
    setStoreMembers([]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const title = container.querySelector("h3");
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe("New Direct Message");

    component.destroy!();
  });

  it("shows subtitle text", () => {
    setCurrentUser(1);
    setStoreMembers([]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const subtitle = container.querySelector("p");
    expect(subtitle).not.toBeNull();
    expect(subtitle!.textContent).toBe("Select a member to start a conversation");

    component.destroy!();
  });

  // --- Member list rendering ---

  it("renders member items for non-current users", () => {
    setCurrentUser(1);
    setStoreMembers([
      makeMember({ id: 1, username: "Me" }),
      makeMember({ id: 2, username: "Alice" }),
      makeMember({ id: 3, username: "Bob" }),
    ]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const items = container.querySelectorAll(".dm-member-picker-item");
    expect(items.length).toBe(2); // "Me" excluded

    component.destroy!();
  });

  it("excludes the current user from the list", () => {
    setCurrentUser(5);
    setStoreMembers([
      makeMember({ id: 5, username: "CurrentUser" }),
      makeMember({ id: 10, username: "OtherUser" }),
    ]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const items = container.querySelectorAll(".dm-member-picker-item");
    expect(items.length).toBe(1);

    // The displayed item should be OtherUser, not CurrentUser
    const nameEl = items[0]!.querySelector("span");
    expect(nameEl!.textContent).not.toBe("CurrentUser");

    component.destroy!();
  });

  it("shows empty list when only the current user exists", () => {
    setCurrentUser(1);
    setStoreMembers([makeMember({ id: 1, username: "Me" })]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const items = container.querySelectorAll(".dm-member-picker-item");
    expect(items.length).toBe(0);

    component.destroy!();
  });

  it("shows empty list when no members exist", () => {
    setCurrentUser(1);
    setStoreMembers([]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const items = container.querySelectorAll(".dm-member-picker-item");
    expect(items.length).toBe(0);

    component.destroy!();
  });

  // --- Avatar rendering ---

  it("renders avatar with uppercased first letter of username", () => {
    setCurrentUser(1);
    setStoreMembers([makeMember({ id: 2, username: "alice" })]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const avatar = container.querySelector(".dm-avatar");
    expect(avatar).not.toBeNull();
    expect(avatar!.textContent).toBe("A");

    component.destroy!();
  });

  it("renders username text in the item", () => {
    setCurrentUser(1);
    setStoreMembers([makeMember({ id: 2, username: "Bob" })]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const item = container.querySelector(".dm-member-picker-item");
    expect(item!.textContent).toContain("Bob");

    component.destroy!();
  });

  // --- Status display ---

  it("renders member status text", () => {
    setCurrentUser(1);
    setStoreMembers([makeMember({ id: 2, username: "Alice", status: "online" })]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const item = container.querySelector(".dm-member-picker-item");
    expect(item!.textContent).toContain("online");

    component.destroy!();
  });

  it("renders offline status for offline members", () => {
    setCurrentUser(1);
    setStoreMembers([makeMember({ id: 2, username: "Alice", status: "offline" })]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const item = container.querySelector(".dm-member-picker-item");
    expect(item!.textContent).toContain("offline");

    component.destroy!();
  });

  it("applies green color for online status", () => {
    setCurrentUser(1);
    setStoreMembers([makeMember({ id: 2, username: "Alice", status: "online" })]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const item = container.querySelector(".dm-member-picker-item");
    const spans = item!.querySelectorAll("span");
    // Status span is the last span in the item
    const statusSpan = spans[spans.length - 1]!;
    expect(statusSpan.style.color).toContain("var(--green)");

    component.destroy!();
  });

  it("applies micro text color for non-online status", () => {
    setCurrentUser(1);
    setStoreMembers([makeMember({ id: 2, username: "Alice", status: "idle" })]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const item = container.querySelector(".dm-member-picker-item");
    const spans = item!.querySelectorAll("span");
    const statusSpan = spans[spans.length - 1]!;
    expect(statusSpan.style.color).toContain("var(--text-micro)");

    component.destroy!();
  });

  // --- Member selection ---

  it("calls onSelect with the member's user ID when a member item is clicked", () => {
    setCurrentUser(1);
    setStoreMembers([makeMember({ id: 42, username: "Alice" })]);

    const onSelect = vi.fn();
    const component = createMemberPickerModal({
      onSelect,
      onClose: vi.fn(),
    });
    component.mount(container);

    const item = container.querySelector(".dm-member-picker-item") as HTMLElement;
    item.click();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(42);

    component.destroy!();
  });

  it("closes the modal when a member is selected", () => {
    setCurrentUser(1);
    setStoreMembers([makeMember({ id: 2, username: "Alice" })]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const item = container.querySelector(".dm-member-picker-item") as HTMLElement;
    item.click();

    // Modal should be removed from DOM after selection
    const overlay = container.querySelector(".modal-overlay");
    expect(overlay).toBeNull();

    component.destroy!();
  });

  it("selects the correct member when multiple members are shown", () => {
    setCurrentUser(1);
    setStoreMembers([
      makeMember({ id: 10, username: "Alice" }),
      makeMember({ id: 20, username: "Bob" }),
      makeMember({ id: 30, username: "Charlie" }),
    ]);

    const onSelect = vi.fn();
    const component = createMemberPickerModal({
      onSelect,
      onClose: vi.fn(),
    });
    component.mount(container);

    const items = container.querySelectorAll(".dm-member-picker-item");
    // Click the second item (Bob, id=20) — order depends on Map iteration
    // We find the item that contains "Bob" text
    let bobItem: HTMLElement | null = null;
    for (const item of items) {
      if (item.textContent?.includes("Bob")) {
        bobItem = item as HTMLElement;
        break;
      }
    }
    expect(bobItem).not.toBeNull();
    bobItem!.click();

    expect(onSelect).toHaveBeenCalledWith(20);

    component.destroy!();
  });

  // --- Cancel button ---

  it("renders a Cancel button", () => {
    setCurrentUser(1);
    setStoreMembers([]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const cancelBtn = container.querySelector(".btn-secondary") as HTMLButtonElement;
    expect(cancelBtn).not.toBeNull();
    expect(cancelBtn.textContent).toBe("Cancel");

    component.destroy!();
  });

  it("clicking Cancel closes the modal", () => {
    setCurrentUser(1);
    setStoreMembers([]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const cancelBtn = container.querySelector(".btn-secondary") as HTMLButtonElement;
    cancelBtn.click();

    const overlay = container.querySelector(".modal-overlay");
    expect(overlay).toBeNull();

    component.destroy!();
  });

  it("clicking Cancel triggers the onClose callback", () => {
    setCurrentUser(1);
    setStoreMembers([]);

    const onClose = vi.fn();
    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose,
    });
    component.mount(container);

    const cancelBtn = container.querySelector(".btn-secondary") as HTMLButtonElement;
    cancelBtn.click();

    expect(onClose).toHaveBeenCalledTimes(1);

    component.destroy!();
  });

  // --- Backdrop click ---

  it("clicking the overlay backdrop closes the modal and calls onClose", () => {
    setCurrentUser(1);
    setStoreMembers([]);

    const onClose = vi.fn();
    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose,
    });
    component.mount(container);

    const overlay = container.querySelector(".modal-overlay") as HTMLElement;
    // Click directly on the overlay (not on the modal content)
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".modal-overlay")).toBeNull();

    component.destroy!();
  });

  // --- Escape key ---

  it("pressing Escape closes the modal and calls onClose", () => {
    setCurrentUser(1);
    setStoreMembers([]);

    const onClose = vi.fn();
    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose,
    });
    component.mount(container);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onClose).toHaveBeenCalledTimes(1);

    component.destroy!();
  });

  // --- Destroy lifecycle ---

  it("destroy removes the modal overlay from the DOM", () => {
    setCurrentUser(1);
    setStoreMembers([]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    expect(container.querySelector(".modal-overlay")).not.toBeNull();

    component.destroy!();

    expect(container.querySelector(".modal-overlay")).toBeNull();
  });

  it("destroy is safe to call multiple times", () => {
    setCurrentUser(1);
    setStoreMembers([]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    component.destroy!();
    // Should not throw
    component.destroy!();
  });

  it("destroy before mount does not throw", () => {
    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });

    // destroy before mount — modalInstance is null
    expect(() => component.destroy!()).not.toThrow();
  });

  // --- Edge case: no authenticated user ---

  it("handles missing auth user gracefully (defaults userId to 0)", () => {
    // No user set in auth store — user is null, so id defaults to 0
    authStore.setState(() => ({
      token: null,
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));
    setStoreMembers([
      makeMember({ id: 0, username: "SystemUser" }),
      makeMember({ id: 1, username: "Alice" }),
    ]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    // User id 0 should be excluded (matches the default fallback)
    const items = container.querySelectorAll(".dm-member-picker-item");
    expect(items.length).toBe(1);
    expect(items[0]!.textContent).toContain("Alice");

    component.destroy!();
  });

  // --- Item structure ---

  it("each member item has the channel-item class", () => {
    setCurrentUser(1);
    setStoreMembers([makeMember({ id: 2, username: "Alice" })]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const item = container.querySelector(".dm-member-picker-item");
    expect(item!.classList.contains("channel-item")).toBe(true);

    component.destroy!();
  });

  it("each member item has cursor pointer style", () => {
    setCurrentUser(1);
    setStoreMembers([makeMember({ id: 2, username: "Alice" })]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const item = container.querySelector(".dm-member-picker-item") as HTMLElement;
    expect(item.style.cursor).toBe("pointer");

    component.destroy!();
  });

  it("list container has max-height and overflow-y for scrollability", () => {
    setCurrentUser(1);
    setStoreMembers([]);

    const component = createMemberPickerModal({
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    component.mount(container);

    const list = container.querySelector(".dm-member-picker-list") as HTMLElement;
    expect(list).not.toBeNull();
    expect(list.style.maxHeight).toBe("300px");
    expect(list.style.overflowY).toBe("auto");

    component.destroy!();
  });
});

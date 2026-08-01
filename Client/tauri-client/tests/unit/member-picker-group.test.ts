import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemberPickerModal } from "../../src/pages/main-page/MemberPickerModal";
import { membersStore } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { MAX_GROUP_DM_PARTICIPANTS } from "@lib/constants";

function seedMembers(count: number): void {
  const members = new Map<number, ReturnType<typeof member>>();
  members.set(1, member(1, "me"));
  for (let i = 2; i <= count + 1; i++) {
    members.set(i, member(i, `user${i}`));
  }
  membersStore.setState((prev) => ({ ...prev, members }));
}

function member(id: number, username: string) {
  return {
    id,
    username,
    avatar: null,
    role: "member",
    status: "online" as const,
    displayName: null,
  };
}

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  authStore.setState((prev) => ({
    ...prev,
    user: { id: 1, username: "me", avatar: null, role: "member" } as never,
  }));
  seedMembers(4);
});

afterEach(() => {
  container.remove();
  document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
});

function open(opts: Partial<Parameters<typeof createMemberPickerModal>[0]> = {}) {
  const picker = createMemberPickerModal({
    onSelect: vi.fn(),
    onSelectGroup: vi.fn(),
    onClose: vi.fn(),
    ...opts,
  });
  picker.mount(container);
  return picker;
}

const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(".dm-member-picker-item"),
];
const confirm = (): HTMLElement =>
  document.querySelector('[data-testid="dm-picker-create"]') as HTMLElement;
const nameInput = (): HTMLInputElement =>
  document.querySelector('[data-testid="dm-group-name"]') as HTMLInputElement;

describe("member picker — multi-select", () => {
  it("excludes the current user from the list", () => {
    open();
    expect(rows()).toHaveLength(4);
    expect(document.querySelector('[data-testid="dm-picker-member-1"]')).toBeNull();
  });

  it("hides the confirm button until something is selected", () => {
    open();
    expect(confirm().style.display).toBe("none");
  });

  it("offers a plain DM for a single selection", () => {
    const onSelect = vi.fn();
    open({ onSelect });

    rows()[0]!.click();
    expect(confirm().style.display).toBe("");
    expect(confirm().textContent).toBe("Create DM");
    // A one-person selection is not a group, so it is not offered a name.
    expect(nameInput().style.display).toBe("none");

    confirm().click();
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("offers a group DM for two or more selections", () => {
    const onSelectGroup = vi.fn();
    open({ onSelectGroup });

    rows()[0]!.click();
    rows()[1]!.click();
    expect(confirm().textContent).toBe("Create Group DM (3)");
    expect(nameInput().style.display).toBe("");

    nameInput().value = "  Lunch crew  ";
    confirm().click();
    expect(onSelectGroup).toHaveBeenCalledWith([2, 3], "Lunch crew");
  });

  it("toggles a selection off on a second click", () => {
    open();
    rows()[0]!.click();
    expect(rows()[0]!.classList.contains("selected")).toBe(true);
    rows()[0]!.click();
    expect(rows()[0]!.classList.contains("selected")).toBe(false);
    expect(confirm().style.display).toBe("none");
  });

  // The server's cap counts the creator, so the picker allows one fewer.
  it("refuses selections past the participant cap", () => {
    seedMembers(MAX_GROUP_DM_PARTICIPANTS + 3);
    const picker = open();

    const all = rows();
    for (const row of all) row.click();

    const selected = all.filter((r) => r.classList.contains("selected"));
    expect(selected).toHaveLength(MAX_GROUP_DM_PARTICIPANTS - 1);
    expect(confirm().textContent).toBe(`Create Group DM (${MAX_GROUP_DM_PARTICIPANTS})`);

    picker.destroy?.();
  });

  it("stays single-select when no group callback is supplied", () => {
    const onSelect = vi.fn();
    createMemberPickerModal({ onSelect, onClose: vi.fn() }).mount(container);

    rows()[0]!.click();
    expect(onSelect).toHaveBeenCalledWith(2);
    // No confirm step: one click is the whole interaction.
    expect(document.querySelector(".modal-overlay.visible")).toBeNull();
  });

  it("closes the modal on confirm", () => {
    open();
    rows()[0]!.click();
    confirm().click();
    expect(document.querySelector(".modal-overlay.visible")).toBeNull();
  });
});

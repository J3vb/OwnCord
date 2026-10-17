/**
 * WP 3B-11a: the group DM member panel. Lists you plus the recipients with a
 * crown on the owner, offers Add People while there is room, and gives only the
 * owner Remove From Group / Make Group Owner (each behind a confirm).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createGroupDmMemberPanel,
  type GroupDmMemberPanelComponent,
  type GroupDmMemberPanelOptions,
} from "../../src/components/GroupDmMemberPanel";
import type {
  GroupMemberView,
  GroupPanelView,
} from "../../src/features/direct-messages/groupMembers";

const member = (
  id: number,
  name: string,
  over: Partial<GroupMemberView> = {},
): GroupMemberView => ({
  id,
  name,
  username: name.toLowerCase(),
  avatar: null,
  status: "online",
  isOwner: false,
  isSelf: false,
  ...over,
});

function view(over: Partial<GroupPanelView> = {}): GroupPanelView {
  return {
    channelId: 5,
    groupName: "Crew",
    members: [
      member(1, "Me", { isSelf: true, isOwner: true }),
      member(2, "Alice"),
      member(3, "Carol"),
    ],
    canAdd: true,
    slotsLeft: 7,
    canManage: true,
    ...over,
  };
}

describe("GroupDmMemberPanel", () => {
  let slot: HTMLDivElement;
  let panel: GroupDmMemberPanelComponent;
  let opts: GroupDmMemberPanelOptions;

  function open(v: GroupPanelView = view(), over: Partial<GroupDmMemberPanelOptions> = {}): void {
    opts = {
      view: v,
      onClose: vi.fn(),
      onAddPeople: vi.fn(),
      onOpenProfile: vi.fn(),
      onRemove: vi.fn(),
      onMakeOwner: vi.fn(),
      focus: false,
      ...over,
    };
    panel = createGroupDmMemberPanel(opts);
    panel.mount(slot);
  }
  const q = <T extends HTMLElement>(id: string): T | null =>
    slot.querySelector<T>(`[data-testid="${id}"]`);
  const menuItems = (): string[] =>
    [...document.querySelectorAll<HTMLElement>(".group-member-menu [role='menuitem']")].map(
      (el) => el.textContent ?? "",
    );

  beforeEach(() => {
    slot = document.createElement("div");
    document.body.appendChild(slot);
  });
  afterEach(() => {
    panel.destroy?.();
    slot.remove();
    document.querySelectorAll(".context-menu, .modal-overlay").forEach((el) => el.remove());
  });

  it("lists you plus the recipients, with a crown on the owner only", () => {
    open();
    expect(q("group-member-count")?.textContent).toBe("Members: 3");
    expect(slot.querySelectorAll(".group-member-item")).toHaveLength(3);
    expect(q("group-member-1")?.textContent).toContain("Me (you)");
    expect(q("group-owner-1")).not.toBeNull();
    expect(q("group-owner-2")).toBeNull();
    expect(q("group-owner-3")).toBeNull();
  });

  it("repaints on update: members added or removed, owner changed", () => {
    open();
    panel.update(
      view({
        members: [
          member(1, "Me", { isSelf: true }),
          member(2, "Alice", { isOwner: true }),
          member(4, "Dave"),
        ],
        canManage: false,
      }),
    );
    expect(q("group-member-count")?.textContent).toBe("Members: 3");
    expect(q("group-member-3")).toBeNull();
    expect(q("group-member-4")).not.toBeNull();
    expect(q("group-owner-1")).toBeNull();
    expect(q("group-owner-2")).not.toBeNull();
    expect(q("group-member-actions-4")).toBeNull();
  });

  it("clicking a member asks for their profile", () => {
    open();
    q("group-member-2")!.click();
    expect(opts.onOpenProfile).toHaveBeenCalledTimes(1);
    expect((opts.onOpenProfile as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      id: 2,
    });
  });

  it("Add People shows only while there is room", () => {
    open();
    q("group-add-people")!.click();
    expect(opts.onAddPeople).toHaveBeenCalledTimes(1);
    panel.update(view({ canAdd: false, slotsLeft: 0 }));
    expect(q("group-add-people")).toBeNull();
  });

  it("the owner gets a menu on other members, and none on themselves", () => {
    open();
    expect(q("group-member-actions-2")).not.toBeNull();
    expect(q("group-member-actions-1")).toBeNull();
    q("group-member-1")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    expect(menuItems()).toEqual([]);
    q("group-member-2")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 3, clientY: 3 }),
    );
    expect(menuItems()).toEqual(["Make Group Owner", "Remove From Group"]);
  });

  it("a plain member sees no owner actions at all", () => {
    open(view({ canManage: false }));
    expect(slot.querySelector(".gm-more")).toBeNull();
    q("group-member-2")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    expect(document.querySelector(".group-member-menu")).toBeNull();
  });

  it("Remove From Group confirms first, then calls back with the group it was asked for", () => {
    open();
    q("group-member-actions-2")!.click();
    document.querySelector<HTMLElement>('[data-testid="group-remove-2"]')!.click();
    const dialog = document.querySelector('[data-testid="group-remove-confirm"]')!;
    expect(dialog.textContent).toContain("Remove Alice from the group?");
    expect(dialog.textContent).toContain("unless someone adds them back");
    expect(opts.onRemove).not.toHaveBeenCalled();
    // The view moves on to another group while the dialog is open.
    panel.update(view({ channelId: 9 }));
    document.querySelector<HTMLElement>('[data-testid="group-remove-confirm-confirm"]')!.click();
    expect(opts.onRemove).toHaveBeenCalledWith(5, expect.objectContaining({ id: 2 }));
  });

  it("cancelling the confirm does nothing", () => {
    open();
    q("group-member-actions-3")!.click();
    document.querySelector<HTMLElement>('[data-testid="group-make-owner-3"]')!.click();
    expect(document.querySelector('[data-testid="group-owner-confirm"]')!.textContent).toContain(
      "Make Carol the group owner?",
    );
    document.querySelector<HTMLElement>('[data-testid="group-owner-confirm-cancel"]')!.click();
    expect(opts.onMakeOwner).not.toHaveBeenCalled();
  });

  it("Make Group Owner confirms, then calls back", () => {
    open();
    q("group-member-actions-3")!.click();
    document.querySelector<HTMLElement>('[data-testid="group-make-owner-3"]')!.click();
    document.querySelector<HTMLElement>('[data-testid="group-owner-confirm-confirm"]')!.click();
    expect(opts.onMakeOwner).toHaveBeenCalledWith(5, expect.objectContaining({ id: 3 }));
  });

  it("the close button closes", () => {
    open();
    q("group-panel-close")!.click();
    expect(opts.onClose).toHaveBeenCalledTimes(1);
  });
});

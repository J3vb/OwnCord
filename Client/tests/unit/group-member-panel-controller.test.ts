/**
 * WP 3B-11a: the controller that mounts the group member panel in the chat
 * layout: opens for a group only, follows dm_channel_open live, stays open
 * across group switches, remembers the user's choice, and drives Add People.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createGroupMemberPanelController } from "../../src/pages/main-page/GroupMemberPanelController";
import type { ApiClient } from "../../src/lib/api";
import { channelsStore } from "../../src/stores/channels.store";
import {
  addDmChannel,
  dmStore,
  updateDmLastMessagePreview,
  type DmChannel,
  type DmUser,
} from "../../src/stores/dm.store";
import { membersStore, updatePresence } from "../../src/stores/members.store";
import { signInAs } from "../helpers/storeSeeds";

const ME = 1;
const user = (id: number, username: string): DmUser => ({
  id,
  username,
  avatar: "",
  status: "online",
});

function dm(channelId: number, participants: DmUser[], over: Partial<DmChannel> = {}): DmChannel {
  return {
    channelId,
    recipient: participants[0]!,
    participants,
    name: "",
    isGroup: participants.length > 1,
    ownerId: ME,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
    ...over,
  };
}

function activate(channelId: number | null): void {
  channelsStore.setState((prev) => ({
    ...prev,
    channels:
      channelId === null
        ? new Map()
        : new Map([
            [
              channelId,
              {
                id: channelId,
                name: "dm",
                type: "dm",
                category: null,
                topic: "",
                position: 0,
                unreadCount: 0,
                mentionCount: 0,
                lastMessageId: null,
                canSend: true,
                slowMode: 0,
                nsfw: false,
                isPrivate: false,
                voiceMaxUsers: 0,
                voiceMaxVideo: 0,
              },
            ],
          ]),
    activeChannelId: channelId,
  }));
}

describe("GroupMemberPanelController", () => {
  let slot: HTMLDivElement;
  let button: HTMLButtonElement;
  let api: {
    addGroupDmMembers: ReturnType<typeof vi.fn>;
    removeGroupDmMember: ReturnType<typeof vi.fn>;
    setGroupDmOwner: ReturnType<typeof vi.fn>;
  };
  let notify: Mock<(message: string) => void>;
  let ctrl: ReturnType<typeof createGroupMemberPanelController>;

  const panelEl = (): HTMLElement | null =>
    slot.querySelector('[data-testid="group-member-panel"]');
  const settle = async (): Promise<void> => {
    await vi.waitFor(() => expect(panelEl()).not.toBeNull());
  };

  beforeEach(() => {
    localStorage.clear();
    slot = document.createElement("div");
    button = document.createElement("button");
    document.body.append(slot, button);
    api = {
      addGroupDmMembers: vi.fn().mockResolvedValue(undefined),
      removeGroupDmMember: vi.fn().mockResolvedValue(undefined),
      setGroupDmOwner: vi.fn().mockResolvedValue(undefined),
    };
    notify = vi.fn<(message: string) => void>();
    signInAs(
      { id: ME, username: "me", avatar: null, role: "member" },
      { token: "t", serverName: null },
    );
    membersStore.setState(() => ({
      members: new Map(
        [1, 2, 3, 4, 5].map((id) => [
          id,
          { id, username: `u${id}`, avatar: null, role: "member", status: "online" as const },
        ]),
      ),
      typingUsers: new Map(),
    }));
    dmStore.setState(() => ({
      channels: [
        dm(10, [user(2, "u2"), user(3, "u3")]),
        dm(11, [user(4, "u4"), user(5, "u5")]),
        dm(12, [user(2, "u2")]),
      ],
    }));
    ctrl = createGroupMemberPanelController({
      api: api as unknown as ApiClient,
      getSlot: () => slot,
      getButton: () => button,
      notify,
    });
  });
  afterEach(() => {
    ctrl.destroy();
    slot.remove();
    button.remove();
    document.querySelectorAll(".modal-overlay, .context-menu").forEach((el) => el.remove());
    activate(null);
  });

  it("opens by itself for a group and reflects it on the header button", async () => {
    activate(10);
    ctrl.syncToActive();
    await settle();
    expect(slot.querySelectorAll(".group-member-item")).toHaveLength(3);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("never opens for a 1:1 DM or a server channel", async () => {
    activate(12);
    ctrl.syncToActive();
    await Promise.resolve();
    expect(panelEl()).toBeNull();
    expect(button.getAttribute("aria-pressed")).not.toBe("true");
  });

  it("updates live when a dm_channel_open adds a member and changes the owner", async () => {
    activate(10);
    ctrl.syncToActive();
    await settle();
    expect(slot.querySelector('[data-testid="group-owner-1"]')).not.toBeNull();

    addDmChannel(dm(10, [user(2, "u2"), user(3, "u3"), user(4, "u4")], { ownerId: 3 }));
    dmStore.flush?.();
    await vi.waitFor(() => expect(slot.querySelectorAll(".group-member-item")).toHaveLength(4));
    expect(slot.querySelector('[data-testid="group-owner-1"]')).toBeNull();
    expect(slot.querySelector('[data-testid="group-owner-3"]')).not.toBeNull();
    // Now the viewer is not the owner: no owner actions.
    expect(slot.querySelector(".gm-more")).toBeNull();
  });

  it("stays mounted across a switch to another group and follows it", async () => {
    activate(10);
    ctrl.syncToActive();
    await settle();
    const before = panelEl();
    activate(11);
    ctrl.syncToActive();
    expect(panelEl()).toBe(before);
    expect(slot.querySelector('[data-testid="group-member-4"]')).not.toBeNull();
    expect(slot.querySelector('[data-testid="group-member-2"]')).toBeNull();
  });

  it("a switch to a 1:1 closes it without forgetting the choice; back to a group reopens", async () => {
    activate(10);
    ctrl.syncToActive();
    await settle();
    activate(12);
    ctrl.syncToActive();
    expect(panelEl()).toBeNull();
    activate(11);
    ctrl.syncToActive();
    await settle();
  });

  it("toggle closes and remembers it; a later group stays closed until toggled open", async () => {
    activate(10);
    ctrl.syncToActive();
    await settle();
    ctrl.toggle();
    expect(panelEl()).toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("false");

    activate(11);
    ctrl.syncToActive();
    await Promise.resolve();
    expect(panelEl()).toBeNull();

    ctrl.toggle();
    await settle();
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("a close during the lazy load is not undone when the import resolves", async () => {
    activate(10);
    ctrl.syncToActive();
    ctrl.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(panelEl()).toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("Add People opens the picker in add mode and posts the picked ids", async () => {
    activate(10);
    ctrl.syncToActive();
    await settle();
    slot.querySelector<HTMLElement>('[data-testid="group-add-people"]')!.click();
    // Members 1, 2 and 3 are in the group; 4 and 5 can be added.
    const rows = [...document.querySelectorAll<HTMLElement>(".dm-member-picker-item")].map(
      (el) => el.dataset["testid"],
    );
    expect(rows).toEqual(["dm-picker-member-4", "dm-picker-member-5"]);
    document.querySelector<HTMLElement>('[data-testid="dm-picker-member-5"]')!.click();
    document.querySelector<HTMLElement>('[data-testid="dm-picker-create"]')!.click();
    await vi.waitFor(() => expect(api.addGroupDmMembers).toHaveBeenCalledWith(10, [5]));
  });

  it("an owner action that the server refuses is shown as an error", async () => {
    const { ApiClientError } = await import("../../src/lib/api");
    api.removeGroupDmMember.mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "gone"));
    activate(10);
    ctrl.syncToActive();
    await settle();
    slot.querySelector<HTMLElement>('[data-testid="group-member-actions-2"]')!.click();
    document.querySelector<HTMLElement>('[data-testid="group-remove-2"]')!.click();
    document.querySelector<HTMLElement>('[data-testid="group-remove-confirm-confirm"]')!.click();
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith("That person isn't in this group anymore"),
    );
    expect(api.removeGroupDmMember).toHaveBeenCalledWith(10, 2);
  });

  it("Make Group Owner calls the owner route", async () => {
    activate(10);
    ctrl.syncToActive();
    await settle();
    slot.querySelector<HTMLElement>('[data-testid="group-member-actions-3"]')!.click();
    document.querySelector<HTMLElement>('[data-testid="group-make-owner-3"]')!.click();
    document.querySelector<HTMLElement>('[data-testid="group-owner-confirm-confirm"]')!.click();
    await vi.waitFor(() => expect(api.setGroupDmOwner).toHaveBeenCalledWith(10, 3));
    expect(notify).not.toHaveBeenCalled();
  });

  describe("a busy group does not disturb the open panel", () => {
    async function openOwnerMenu(): Promise<void> {
      activate(10);
      ctrl.syncToActive();
      await settle();
      slot.querySelector<HTMLElement>('[data-testid="group-member-actions-2"]')!.click();
      expect(document.querySelector(".group-member-menu")).not.toBeNull();
    }

    it("a new message keeps the panel DOM, the owner menu and the focus", async () => {
      await openOwnerMenu();
      const row = slot.querySelector('[data-testid="group-member-3"]');
      (row as HTMLElement).focus();

      updateDmLastMessagePreview(10, 99, "hello", "2026-03-15T10:00:00Z");
      dmStore.flush();
      membersStore.flush();
      await Promise.resolve();

      expect(slot.querySelector('[data-testid="group-member-3"]')).toBe(row);
      expect(document.querySelector(".group-member-menu")).not.toBeNull();
      expect(document.activeElement).toBe(row);
    });

    it("a presence change repaints but keeps the menu and the focused control", async () => {
      await openOwnerMenu();
      (slot.querySelector('[data-testid="group-member-3"]') as HTMLElement).focus();

      updatePresence(3, "dnd");
      membersStore.flush();
      await Promise.resolve();

      expect(document.querySelector(".group-member-menu")).not.toBeNull();
      expect(document.activeElement).toBe(slot.querySelector('[data-testid="group-member-3"]'));
    });

    it("Add People re-checks the live group on submit", async () => {
      activate(10);
      ctrl.syncToActive();
      await settle();
      slot.querySelector<HTMLElement>('[data-testid="group-add-people"]')!.click();
      // While the picker is open, user 5 is added by someone else.
      addDmChannel(dm(10, [user(2, "u2"), user(3, "u3"), user(5, "u5")]));
      dmStore.flush();
      document.querySelector<HTMLElement>('[data-testid="dm-picker-member-5"]')!.click();
      document.querySelector<HTMLElement>('[data-testid="dm-picker-member-4"]')!.click();
      document.querySelector<HTMLElement>('[data-testid="dm-picker-create"]')!.click();
      await vi.waitFor(() => expect(api.addGroupDmMembers).toHaveBeenCalledWith(10, [4]));
    });
  });
});

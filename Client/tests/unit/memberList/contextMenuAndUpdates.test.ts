import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useMountContainer } from "../../helpers/mountContainer";
import "../../helpers/memberListMocks";
import { createMemberList } from "@components/MemberList";
import type { MemberListOptions } from "@components/MemberList";
import { membersStore, updatePresence, updateMemberRole } from "@stores/members.store";
import type { Member } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { channelsStore, setRoles, type Channel } from "@stores/channels.store";
import { resetVoiceStore } from "@stores/voice.store";
import { addVoiceUser } from "../../helpers/voiceUsers";
import { setMemberTimeouts } from "../../../src/features/moderation/store";
import { claimComposer } from "../../../src/features/messaging/activeComposer";
import { Permission } from "../../../src/lib/types";
import "@components/UserProfilePopup";
import "@components/AdminActions";
import { makeChannelRow } from "../../helpers/storeSeeds";
import {
  resetStore,
  makeMember,
  setTestMembers,
  testMembers,
  defaultOpts,
  rightClickMember,
  topMenuLabels,
} from "../../helpers/memberListHarness";

describe("MemberList full context menu (3C-3)", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMemberList> | null = null;

  const MODERATE_ONLY = Permission.MODERATE_MEMBERS;

  function seedRanks(): void {
    setRoles([
      { id: 1, name: "Owner", color: null, permissions: Permission.ADMINISTRATOR, position: 100 },
      { id: 2, name: "Admin", color: null, permissions: Permission.ADMINISTRATOR, position: 80 },
      { id: 3, name: "Moderator", color: null, permissions: MODERATE_ONLY, position: 60 },
      { id: 4, name: "Member", color: null, permissions: 0, position: 40 },
    ]);
  }

  function signInAs(role: string): void {
    authStore.setState(() => ({
      token: "tok",
      user: { id: 99, username: "Actor", avatar: null, role },
      serverName: "Test",
      motd: null,
      isAuthenticated: true,
    }));
  }

  /** Right-click a member and let the lazy menu chunk settle. */
  async function openMenu(
    targetId: number,
    extra: Partial<MemberListOptions> = {},
  ): Promise<HTMLElement | null> {
    setTestMembers(testMembers);
    list = createMemberList({ ...defaultOpts(), ...extra });
    list.mount(container);
    await rightClickMember(container, targetId);
    return document.body.querySelector<HTMLElement>(".context-menu");
  }

  const timeoutOpts = (): Partial<MemberListOptions> => ({
    onTimeoutMember: vi.fn().mockResolvedValue(undefined),
    onRemoveTimeout: vi.fn().mockResolvedValue(undefined),
  });

  const makeChannel = (id: number, type: Channel["type"]): Channel =>
    makeChannelRow({ id, name: `ch-${id}`, type });

  function putInVoice(userId: number, channelId: number): void {
    addVoiceUser(channelId, userId, `u${userId}`);
  }

  useMountContainer(
    (c) => {
      container = c;
    },
    () => {
      list?.destroy?.();
      list = null;
      document.body.querySelectorAll(".context-menu").forEach((el) => el.remove());
      setMemberTimeouts(undefined);
      resetVoiceStore();
      resetStore();
    },
  );

  beforeEach(() => {
    resetStore();
    seedRanks();
    setMemberTimeouts(undefined);
    resetVoiceStore();
  });

  // (13)
  it("offers Timeout only with MODERATE_MEMBERS and a higher rank than the target", async () => {
    signInAs("Moderator");
    // Member (rank 40) is below the Moderator: Timeout is offered.
    let menu = await openMenu(4, timeoutOpts());
    expect(topMenuLabels(menu!)).toContain("Timeout");
    list!.destroy?.();
    menu!.remove();

    // Another Moderator (equal rank) is not.
    menu = await openMenu(3, timeoutOpts());
    expect(topMenuLabels(menu!)).not.toContain("Timeout");
    expect(topMenuLabels(menu!)).not.toContain("Remove Timeout");
    list!.destroy?.();
    menu!.remove();

    // Without the permission bit, even a lower-ranked target gets neither.
    signInAs("Member");
    menu = await openMenu(5, timeoutOpts());
    expect(topMenuLabels(menu!)).not.toContain("Timeout");
  });

  // (14)
  it.each([
    ["no timeout view (older server)", undefined, ["Timeout", "Remove Timeout"]],
    [
      "target has an entry",
      [{ user_id: 4, expires_at: "2099-01-01T00:00:00Z" }],
      ["Remove Timeout"],
    ],
    ["target has no entry", [{ user_id: 7, expires_at: "2099-01-01T00:00:00Z" }], ["Timeout"]],
  ] as const)("timeout state: %s", async (_name, entries, expected) => {
    signInAs("Moderator");
    setMemberTimeouts(entries);
    const menu = await openMenu(4, timeoutOpts());
    const labels = topMenuLabels(menu!).filter((l) => l === "Timeout" || l === "Remove Timeout");
    expect(labels).toEqual([...expected]);
  });

  // (15)
  it("shows voice rows only for a server voice channel and with voiceModFor options", async () => {
    signInAs("Admin");
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([
        [10, makeChannel(10, "voice")],
        [11, makeChannel(11, "dm")],
      ]),
    }));
    const voiceModFor = vi.fn(() => ({
      serverMuted: false,
      serverDeafened: false,
      moveTargets: [],
      onServerMute: vi.fn(),
      onServerDeafen: vi.fn(),
      onMove: vi.fn(),
      onDisconnect: vi.fn(),
    }));
    const voiceLabels = ["Server Mute", "Server Deafen", "Disconnect"];

    // Not in voice at all.
    let menu = await openMenu(4, { voiceModFor });
    expect(topMenuLabels(menu!)).not.toContain("Disconnect");
    list!.destroy?.();
    menu!.remove();

    // In a DM call: no voice rows.
    putInVoice(4, 11);
    menu = await openMenu(4, { voiceModFor });
    expect(topMenuLabels(menu!)).not.toContain("Disconnect");
    list!.destroy?.();
    menu!.remove();
    expect(voiceModFor).not.toHaveBeenCalled();

    // In a server voice channel but nothing wired: no voice rows.
    resetVoiceStore();
    putInVoice(4, 10);
    menu = await openMenu(4);
    expect(topMenuLabels(menu!)).not.toContain("Disconnect");
    list!.destroy?.();
    menu!.remove();

    // In a server voice channel with options: the three rows.
    menu = await openMenu(4, { voiceModFor });
    expect(topMenuLabels(menu!)).toEqual(expect.arrayContaining(voiceLabels));
    expect(voiceModFor).toHaveBeenCalledWith(10, expect.objectContaining({ userId: 4 }));
  });

  // (16)
  it("the Profile item opens the profile popup and closes the menu", async () => {
    signInAs("Admin");
    const menu = await openMenu(4);
    const profile = menu!.querySelector<HTMLElement>('[data-testid="member-menu-profile"]');
    expect(profile).not.toBeNull();
    profile!.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull(),
    );
    expect(document.body.querySelector(".context-menu")).toBeNull();
    document.querySelector('[data-testid="user-profile-popup"]')?.remove();
    document.querySelector('[data-testid="user-profile-overlay"]')?.remove();
  });

  it("Message and Call appear only when wired, and Mention writes to the composer", async () => {
    signInAs("Member");
    const insertMention = vi.fn(() => true);
    const release = claimComposer({ insertMention, canMention: () => true });
    try {
      const onMessageUser = vi.fn();
      const menu = await openMenu(4, { onMessageUser });
      expect(topMenuLabels(menu!)).toEqual(["Profile", "Mention", "Message", "Block"]);
      const mention = menu!.querySelector<HTMLElement>('[data-testid="member-menu-mention"]')!;
      expect(mention.getAttribute("aria-disabled")).toBeNull();
      mention.click();
      expect(insertMention).toHaveBeenCalledWith("Dave");
      expect(document.body.querySelector(".context-menu")).toBeNull();
    } finally {
      release();
    }
  });

  it("greys Mention with a reason when no composer is mounted", async () => {
    signInAs("Member");
    const menu = await openMenu(4);
    const mention = menu!.querySelector<HTMLElement>('[data-testid="member-menu-mention"]')!;
    expect(mention.getAttribute("aria-disabled")).toBe("true");
    expect(mention.title).not.toBe("");
  });

  // (17) edge case 1
  describe("menu opened again, or list destroyed, while the chunk loads", () => {
    it("renders one menu, for the second member, when two right-clicks land before the load settles", async () => {
      signInAs("Admin");
      setTestMembers(testMembers);
      list = createMemberList(defaultOpts());
      list.mount(container);
      const open = (id: number): void => {
        container
          .querySelector(`[data-testid="member-${id}"]`)!
          .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      };
      open(4);
      open(5);
      await vi.dynamicImportSettled();
      const menus = document.body.querySelectorAll(".context-menu");
      expect(menus).toHaveLength(1);
      // The surviving menu belongs to the second member: its Profile row opens Eve's card.
      const profile = menus[0]!.querySelector<HTMLElement>('[data-testid="member-menu-profile"]');
      expect(profile).not.toBeNull();
      profile!.click();
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull(),
      );
      expect(document.querySelector('[data-testid="user-profile-popup"]')?.textContent).toContain(
        "Eve",
      );
      document.querySelector('[data-testid="user-profile-popup"]')?.remove();
      document.querySelector('[data-testid="user-profile-overlay"]')?.remove();
    });

    it("renders nothing when the list is destroyed before the load settles", async () => {
      signInAs("Admin");
      setTestMembers(testMembers);
      list = createMemberList(defaultOpts());
      list.mount(container);
      container
        .querySelector('[data-testid="member-4"]')!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      list.destroy?.();
      await vi.dynamicImportSettled();
      expect(document.body.querySelector(".context-menu")).toBeNull();
    });
  });
});

describe("MemberList rows update in place (3C-4a)", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMemberList> | null = null;

  const row = (id: number): HTMLElement =>
    container.querySelector<HTMLElement>(`[data-testid="member-${id}"]`)!;
  const texts = (): string[] =>
    Array.from(container.querySelectorAll(".member-role-group, .member-item")).map((el) =>
      el.classList.contains("member-role-group")
        ? (el.textContent ?? "")
        : (el.getAttribute("data-testid") ?? ""),
    );

  beforeEach(() => {
    resetStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    list = null;
  });

  afterEach(() => {
    list?.destroy?.();
    container.remove();
    document.body.querySelectorAll(".context-menu").forEach((m) => m.remove());
  });

  function mountWith(members: Member[]): void {
    setTestMembers(members);
    list = createMemberList(defaultOpts());
    list.mount(container);
  }

  it("offline and invisible members form one OFFLINE group at the end, A-Z across roles", () => {
    mountWith([
      makeMember({ id: 1, username: "Zed", role: "owner", status: "offline" }),
      makeMember({ id: 2, username: "Amy", role: "member", status: "invisible" }),
      makeMember({ id: 3, username: "Mia", role: "admin", status: "offline" }),
      makeMember({ id: 4, username: "Bo", role: "member", status: "online" }),
    ]);
    expect(texts()).toEqual([
      "MEMBER — 1",
      "member-4",
      "OFFLINE — 3",
      "member-2",
      "member-3",
      "member-1",
    ]);
    // An offline name keeps its role colour (dimmed by .offline).
    expect(row(1).classList.contains("offline")).toBe(true);
    expect(row(1).querySelector(".mi-name")!.getAttribute("data-role-color")).toBe(
      "var(--role-owner, #e74c3c)",
    );
  });

  it("a member going offline moves into OFFLINE; same element, no other row moved", () => {
    mountWith(testMembers);
    const before = new Map(
      Array.from(container.querySelectorAll(".member-item")).map((el) => [
        el.getAttribute("data-testid"),
        el,
      ]),
    );
    const listEl = container.querySelector(".member-list")!;
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((r) => records.push(...r));
    observer.observe(listEl, { childList: true });

    updatePresence(6, "offline");
    membersStore.flush();
    records.push(...observer.takeRecords());
    observer.disconnect();

    const removed = records.flatMap((r) => Array.from(r.removedNodes));
    const added = records.flatMap((r) => Array.from(r.addedNodes));
    expect(removed).toEqual([before.get("member-6")]);
    expect(added).toEqual([before.get("member-6")]);
    expect(row(6)).toBe(before.get("member-6"));
    expect(texts().slice(-3)).toEqual(["OFFLINE — 2", "member-4", "member-6"]);
    for (const [id, el] of before) {
      expect(container.querySelector(`[data-testid="${id}"]`)).toBe(el);
    }
  });

  it("focus stays on a row when another member changes status or joins", () => {
    mountWith(testMembers);
    row(3).focus();
    expect(document.activeElement).toBe(row(3));
    updatePresence(1, "offline");
    membersStore.flush();
    updatePresence(6, "dnd");
    membersStore.flush();
    setTestMembers([...testMembers, makeMember({ id: 50, username: "Newbie" })]);
    membersStore.flush();
    expect(document.activeElement).toBe(row(3));
  });

  it("an open member menu survives another member's presence change or join, and Escape refocuses its row", async () => {
    authStore.setState(() => ({
      token: "tok",
      user: { id: 99, username: "Actor", avatar: null, role: "admin" },
      serverName: "Test",
      motd: null,
      isAuthenticated: true,
    }));
    mountWith(testMembers);
    row(5).focus();
    row(5).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await vi.dynamicImportSettled();
    const menu = document.body.querySelector(".context-menu");
    expect(menu).not.toBeNull();

    updatePresence(1, "offline");
    membersStore.flush();
    setTestMembers([...testMembers, makeMember({ id: 50, username: "Newbie" })]);
    membersStore.flush();
    expect(document.body.querySelector(".context-menu")).toBe(menu);
    expect(row(5).isConnected).toBe(true);

    menu!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.body.querySelector(".context-menu")).toBeNull();
    expect(document.activeElement).toBe(row(5));
  });

  it("a first right-click whose menu module loads after a presence update and a join still opens", async () => {
    mountWith(testMembers);
    row(5).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    // A presence update and a join land before the lazy module settles.
    updatePresence(1, "offline");
    membersStore.flush();
    setTestMembers([...testMembers, makeMember({ id: 50, username: "Newbie" })]);
    membersStore.flush();
    await vi.dynamicImportSettled();
    expect(document.body.querySelector(".context-menu")).not.toBeNull();
  });

  it("a same-colour role change reuses the row and the menu gates on the new role", async () => {
    setRoles([
      { id: 1, name: "Owner", color: null, permissions: Permission.ADMINISTRATOR, position: 100 },
      {
        id: 2,
        name: "Admin",
        color: "#112233",
        permissions: Permission.ADMINISTRATOR,
        position: 80,
      },
      { id: 3, name: "Mod", color: "#112233", permissions: 0, position: 60 },
    ]);
    authStore.setState(() => ({
      token: "tok",
      user: { id: 99, username: "Actor", avatar: null, role: "Admin" },
      serverName: "Test",
      motd: null,
      isAuthenticated: true,
    }));
    mountWith([
      makeMember({ id: 7, username: "Target", role: "Mod" }),
      makeMember({ id: 99, username: "Actor", role: "Admin" }),
    ]);
    const menuLabels = async (): Promise<(string | null | undefined)[]> => {
      row(7).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      await vi.dynamicImportSettled();
      return Array.from(document.body.querySelectorAll(".context-menu__item")).map(
        (el) => el.firstChild?.textContent,
      );
    };
    expect(await menuLabels()).toContain("Force Logout");
    document.body.querySelectorAll(".context-menu").forEach((m) => m.remove());

    const before = row(7);
    updateMemberRole(7, "Admin");
    membersStore.flush();
    // Same colour as Mod, so the row is reused; the actor no longer outranks it.
    expect(row(7)).toBe(before);
    expect(await menuLabels()).not.toContain("Force Logout");
  });

  it('a role named "Offline" and the Offline group render as two groups', () => {
    setRoles([
      { id: 1, name: "Offline", color: null, permissions: 0, position: 50 },
      { id: 2, name: "Member", color: null, permissions: 0, position: 40 },
    ]);
    mountWith([
      makeMember({ id: 1, username: "Ann", role: "Offline", status: "online" }),
      makeMember({ id: 2, username: "Bob", role: "Member", status: "offline" }),
    ]);
    expect(texts()).toEqual(["OFFLINE — 1", "member-1", "OFFLINE — 1", "member-2"]);
    expect(container.querySelectorAll('[data-testid="member-group-offline"]')).toHaveLength(1);
  });

  it("a full presence snapshot and a ready setMembers reuse unchanged rows by id", () => {
    mountWith(testMembers);
    const before = Array.from(container.querySelectorAll(".member-item"));

    // Same data, brand-new objects for every member (what ready / presence full do).
    setTestMembers(testMembers.map((m) => ({ ...m })));
    membersStore.flush();
    expect(Array.from(container.querySelectorAll(".member-item"))).toEqual(before);

    // A member gone from the snapshot is removed; the rest keep their nodes.
    setTestMembers(testMembers.filter((m) => m.id !== 5).map((m) => ({ ...m })));
    membersStore.flush();
    expect(container.querySelector('[data-testid="member-5"]')).toBeNull();
    expect(container.querySelectorAll(".member-item")).toHaveLength(before.length - 1);
    expect(row(1)).toBe(before[0]);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemberList } from "@components/MemberList";
import type { MemberListOptions } from "@components/MemberList";
import { membersStore, updatePresence, updateMemberRole } from "@stores/members.store";
import type { Member } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { channelsStore, setRoles } from "@stores/channels.store";
import { Permission, type UserStatus } from "../../../src/lib/types";
import { pickAvatarColor } from "../../../src/features/profiles/avatar";
import {
  applyReadyCapabilities,
  resetServerCapabilities,
} from "../../../src/lib/net/serverCapabilities";
import "@components/UserProfilePopup";
import "@components/AdminActions";
import { lastResizeCallback } from "../../helpers/memberListMocks";
import {
  useDarkSurfaces,
  resetStore,
  makeMember,
  setTestMembers,
  testMembers,
  defaultOpts,
  useMemberListSuite,
  rightClickMember,
  topMenuLabels,
} from "../../helpers/memberListHarness";
import { signInAs } from "../../helpers/storeSeeds";

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

    // The four role groups, then the one OFFLINE group (Dave is offline).
    expect(headers.length).toBe(5);
    expect(headerTexts).toEqual([
      "OWNER — 1",
      "ADMIN — 2",
      "MODERATOR — 1",
      "MEMBER — 1",
      "OFFLINE — 1",
    ]);
  });

  it("keeps the four role headers and counts when everyone is online", () => {
    setTestMembers(testMembers.map((m) => ({ ...m, status: "online" as UserStatus })));
    memberList.mount(container);

    const headerTexts = Array.from(container.querySelectorAll(".member-role-group")).map(
      (h) => h.textContent,
    );
    expect(headerTexts).toEqual(["OWNER — 1", "ADMIN — 2", "MODERATOR — 1", "MEMBER — 2"]);
  });

  it("sorts online-ish members together, A-Z, within a group", () => {
    // Two admins: Frank (online) and Bob (idle)
    setTestMembers(testMembers);
    memberList.mount(container);

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
    // Online and idle share a bucket, so the group reads A-Z: Bob (idle)
    // before Frank (online).
    expect(adminItems[0]!.getAttribute("data-testid")).toBe("member-2"); // Bob
    expect(adminItems[1]!.getAttribute("data-testid")).toBe("member-6"); // Frank
  });

  it("shows role group headers with count", () => {
    setTestMembers(testMembers);
    memberList.mount(container);

    const headers = container.querySelectorAll(".member-role-group");
    const headerTexts = Array.from(headers).map((h) => h.textContent);

    // Counts are online members only: OWNER 1, ADMIN 2, MODERATOR 1, MEMBER 1
    // (Dave is offline), OFFLINE 1.
    expect(headerTexts[0]).toBe("OWNER — 1");
    expect(headerTexts[1]).toBe("ADMIN — 2");
    expect(headerTexts[2]).toBe("MODERATOR — 1");
    expect(headerTexts[3]).toBe("MEMBER — 1");
    expect(headerTexts[4]).toBe("OFFLINE — 1");
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

  it("waits for a member avatar to be visible before loading it", () => {
    const observed: Element[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe(el: Element): void {
          observed.push(el);
        }
        unobserve(): void {}
      },
    );
    try {
      setTestMembers([makeMember({ id: 1, username: "Alice", avatar: "/api/v1/files/a" })]);
      memberList.mount(container);

      const avatar = container.querySelector(".mi-avatar");
      expect(avatar).not.toBeNull();
      expect(observed).toContain(avatar);
      expect(avatar?.querySelector("img")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("offers the server's own roles in the Change Role submenu", async () => {
    // A hardcoded list left custom roles unassignable — and unresolvable to a
    // role id, so choosing one silently did nothing.
    setRoles([
      { id: 1, name: "Owner", color: null, permissions: 0 },
      { id: 2, name: "Staff", color: null, permissions: 0 },
      { id: 3, name: "VIP", color: null, permissions: 0 },
    ]);
    signInAs({ id: 99, username: "Admin", avatar: null, role: "admin" }, { serverName: "Test" });
    setTestMembers(testMembers);
    memberList.mount(container);

    await rightClickMember(container, 3);

    const submenu = document.body.querySelector(".context-menu__submenu");
    expect(submenu).not.toBeNull();
    const roleLabels = Array.from(submenu!.querySelectorAll(".context-menu__item")).map(
      (i) => i.textContent,
    );
    // "owner" is not a context-menu action.
    expect(roleLabels).toEqual(["Staff", "VIP"]);

    document.body.querySelector(".context-menu")?.remove();
  });

  it("re-renders groups when a roles_update replaces the role list", () => {
    // Role management makes the list mutable mid-session. Before this the list
    // only re-rendered on a member change, so a rename/recolor/delete sat
    // invisible until unrelated traffic arrived.
    useDarkSurfaces();
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

    // The new colour reaches the row; #0000ff reads 1.36:1 on #383a40, so the
    // role clamp shows the name in --text-normal.
    const stanName = container.querySelector<HTMLSpanElement>('[data-testid="member-2"] .mi-name')!;
    expect(stanName.dataset["roleColor"]).toBe("#0000FF");
    expect(stanName.style.color).toBe("var(--text-normal)");
  });

  it("renders groups for custom server roles, colored by the server's role color", () => {
    useDarkSurfaces();
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

  it("non-admin context menu shows only Block, no admin actions", async () => {
    setTestMembers(testMembers);
    const opts = defaultOpts("member");
    memberList.destroy?.();
    memberList = createMemberList(opts);
    memberList.mount(container);

    await rightClickMember(container, 3);

    const contextMenu = document.body.querySelector(".context-menu");
    expect(contextMenu).not.toBeNull();
    const labels = Array.from(contextMenu!.querySelectorAll(".context-menu__item")).map(
      (i) => i.textContent,
    );
    expect(labels).toEqual(["Profile", "Mention", "Block"]);

    document.body.querySelector(".context-menu")?.remove();
  });

  // At the 940x500 minimum window a member low in the list opened the menu at
  // the pointer with its bottom past the viewport, so Force Logout, Ban and
  // Block could not be reached.
  it("keeps the context menu inside the viewport near the bottom-right edge", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(144);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(180);
    vi.stubGlobal("innerWidth", 940);
    vi.stubGlobal("innerHeight", 500);
    try {
      setTestMembers(testMembers);
      memberList.mount(container);
      const memberItem = container.querySelector('[data-testid="member-3"]') as HTMLDivElement;

      memberItem.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 930, clientY: 430 }),
      );

      await vi.dynamicImportSettled();
      let menu = document.body.querySelector<HTMLElement>(".context-menu")!;
      // Anchored by its bottom edge at the pointer: spans y 286..430, x 752..932.
      expect(menu.style.top).toBe("");
      expect(menu.style.bottom).toBe("70px");
      expect(menu.style.left).toBe("752px");

      memberItem.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 }),
      );

      await vi.dynamicImportSettled();
      menu = document.body.querySelector<HTMLElement>(".context-menu")!;
      // Room below the pointer: opens there as before.
      expect(menu.style.top).toBe("100px");
      expect(menu.style.bottom).toBe("");
      expect(menu.style.left).toBe("100px");
    } finally {
      document.body.querySelector(".context-menu")?.remove();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  // A menu that grows after it opened (it once did when Ban expanded into an
  // inline form, about 90 px taller) opened top-anchored in the band just above
  // the fit limit ran past the bottom of the 940x500 window, taking its last
  // rows with it; a bottom-anchored one can likewise grow past the top.
  it("re-clamps the context menu into the viewport when it grows", async () => {
    let menuHeight = 144;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => menuHeight);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(180);
    vi.stubGlobal("innerWidth", 940);
    vi.stubGlobal("innerHeight", 500);
    setRoles([{ id: 7, name: "admin", color: null, permissions: Permission.ADMINISTRATOR }]);
    try {
      setTestMembers(testMembers);
      memberList.mount(container);
      const memberItem = container.querySelector('[data-testid="member-3"]') as HTMLDivElement;

      memberItem.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 320 }),
      );

      await vi.dynamicImportSettled();
      let menu = document.body.querySelector<HTMLElement>(".context-menu")!;
      expect(menu.style.top).toBe("320px");

      menuHeight = 234;
      lastResizeCallback!();
      // Re-anchored by its bottom edge at the pointer: spans y 86..320.
      expect(menu.style.top).toBe("");
      expect(menu.style.bottom).toBe("180px");

      menuHeight = 144;
      memberItem.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 430 }),
      );
      await vi.dynamicImportSettled();
      menu = document.body.querySelector<HTMLElement>(".context-menu")!;
      expect(menu.style.bottom).toBe("70px");
      menuHeight = 470;
      lastResizeCallback!();
      // Too tall to hang above the pointer: pulled down so its top stays at 8.
      expect(menu.style.top).toBe("");
      expect(menu.style.bottom).toBe("22px");
    } finally {
      document.body.querySelector(".context-menu")?.remove();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  // The menu used to gate on the role NAME (owner/admin), so the seeded
  // Moderator role — which holds KICK_MEMBERS and BAN_MEMBERS — got nothing,
  // and a custom role holding those bits got nothing either.
  describe("permission-driven moderation items", () => {
    /** Mirrors the seeded Moderator mask (0x000FFFFF): MANAGE_MESSAGES,
     *  MANAGE_CHANNELS, KICK_MEMBERS, BAN_MEMBERS — no MANAGE_ROLES. */
    const MODERATOR_MASK = 0x000fffff;

    async function openMenuAs(roleName: string, permissions: number): Promise<string[]> {
      setRoles([{ id: 7, name: roleName, color: null, permissions }]);
      setTestMembers(testMembers);
      const opts: MemberListOptions = { ...defaultOpts(), currentUserRole: roleName };
      memberList.destroy?.();
      memberList = createMemberList(opts);
      memberList.mount(container);

      await rightClickMember(container, 3);
      const menu = document.body.querySelector(".context-menu");
      expect(menu).not.toBeNull();
      // Submenu role options share the item class; only top-level items count.
      return topMenuLabels(menu as HTMLElement);
    }

    afterEach(() => {
      document.body.querySelector(".context-menu")?.remove();
    });

    it("shows Force Logout and Ban but not Change Role for a moderator mask", async () => {
      const labels = await openMenuAs("moderator", MODERATOR_MASK);
      expect(labels).toContain("Force Logout");
      expect(labels).toContain("Ban");
      expect(labels).not.toContain("Change Role");
      expect(labels).toContain("Block");
    });

    it("shows Change Role only when MANAGE_ROLES is held", async () => {
      const labels = await openMenuAs("staff", Permission.MANAGE_ROLES | Permission.KICK_MEMBERS);
      expect(labels).toContain("Change Role");
      expect(labels).toContain("Force Logout");
      expect(labels).not.toContain("Ban");
    });

    it("hides the single Change Role on a multi_role server (the profile chips manage roles)", async () => {
      applyReadyCapabilities({ multi_role: true });
      try {
        const labels = await openMenuAs("staff", Permission.MANAGE_ROLES | Permission.KICK_MEMBERS);
        expect(labels).not.toContain("Change Role");
        expect(labels).toContain("Force Logout");
      } finally {
        resetServerCapabilities();
      }
    });

    it("shows every moderation item for the ADMINISTRATOR bit", async () => {
      const labels = await openMenuAs("admin", Permission.ADMINISTRATOR);
      expect(labels).toEqual(
        expect.arrayContaining(["Change Role", "Force Logout", "Ban", "Block"]),
      );
    });

    it("shows only Block for a role whose mask holds no moderation bits", async () => {
      const labels = await openMenuAs(
        "member",
        Permission.SEND_MESSAGES | Permission.READ_MESSAGES,
      );
      expect(labels).toEqual(["Profile", "Mention", "Block"]);
    });
  });

  describe("role hierarchy", () => {
    // The server refuses a moderation action on a member ranked at or above
    // the actor and a role assignment at or above the actor's own rank; the
    // menu mirrors both so it never offers a request that cannot succeed.
    function seedRanks(memberPerms = 0): void {
      setRoles([
        { id: 1, name: "Owner", color: null, permissions: Permission.ADMINISTRATOR, position: 100 },
        { id: 2, name: "Admin", color: null, permissions: Permission.ADMINISTRATOR, position: 80 },
        { id: 3, name: "Moderator", color: null, permissions: 0x000fffff, position: 60 },
        { id: 4, name: "Member", color: null, permissions: memberPerms, position: 40 },
      ]);
    }

    async function openMenuOn(
      actorRole: string,
      targetId: number,
      actorPerms = 0,
    ): Promise<HTMLElement | null> {
      seedRanks(actorPerms);
      signInAs(
        { id: 99, username: "Actor", avatar: null, role: actorRole },
        { serverName: "Test" },
      );
      setTestMembers(testMembers);
      memberList.mount(container);
      await rightClickMember(container, targetId);
      return document.body.querySelector<HTMLElement>(".context-menu");
    }

    afterEach(() => {
      document.body.querySelector(".context-menu")?.remove();
    });

    it("offers only roles below the actor's own rank", async () => {
      const menu = await openMenuOn("Admin", 4);
      const roleLabels = Array.from(
        menu!.querySelectorAll(".context-menu__submenu .context-menu__item"),
      ).map((i) => i.textContent);
      expect(roleLabels).toEqual(["Moderator", "Member"]);
    });

    it("withholds Change Role, Force Logout and Ban for a member the actor does not outrank", async () => {
      for (const targetId of [1, 2]) {
        const menu = await openMenuOn("Admin", targetId);
        expect(menu).not.toBeNull();
        expect(topMenuLabels(menu!)).toEqual(["Profile", "Mention", "Block"]);
        document.body.querySelector(".context-menu")?.remove();
        memberList.destroy?.();
        memberList = createMemberList(defaultOpts());
      }
    });

    it("keeps every action for a member ranked below the actor", async () => {
      const menu = await openMenuOn("Admin", 3);
      expect(topMenuLabels(menu!)).toEqual(
        expect.arrayContaining(["Change Role", "Force Logout", "Ban", "Block"]),
      );
    });
  });

  it("right-clicking yourself opens Profile and Mention only", async () => {
    // Set authStore so current user is id=1 (Alice)
    signInAs({ id: 1, username: "Alice", avatar: null, role: "owner" }, { serverName: "Test" });

    setTestMembers(testMembers);
    const opts = defaultOpts("owner");
    memberList.destroy?.();
    memberList = createMemberList(opts);
    memberList.mount(container);

    // Right-click on Alice (user id 1 = self)
    await rightClickMember(container, 1);

    // Yourself: no moderation, Message, Call or Block.
    const contextMenu = document.body.querySelector(".context-menu");
    expect(contextMenu).not.toBeNull();
    const labels = Array.from(contextMenu!.querySelectorAll(".context-menu__item")).map(
      (i) => i.textContent,
    );
    expect(labels).toEqual(["Profile", "Mention"]);
    contextMenu!.remove();
  });

  // The role NAME passed via opts.currentUserRole is a snapshot taken once at
  // mount (features/members/memberPanel.ts). dispatcher.ts keeps authStore.user.role
  // current on every self MEMBER_UPDATE specifically so permission gates can
  // read it live -- this is the one gate that opted out by threading the
  // stale prop instead.
  it("re-reads the current user's role live from authStore instead of the mount-time opts.currentUserRole snapshot", async () => {
    setRoles([{ id: 8, name: "admin", color: null, permissions: Permission.ADMINISTRATOR }]);
    signInAs({ id: 999, username: "Self", avatar: null, role: "member" }, { serverName: "Test" });
    setTestMembers(testMembers);
    const opts: MemberListOptions = { ...defaultOpts(), currentUserRole: "member" };
    memberList.destroy?.();
    memberList = createMemberList(opts);
    memberList.mount(container);

    // Mid-session promotion after mount -- opts.currentUserRole was only
    // ever read once, but authStore now says admin.
    authStore.setState((prev) => ({ ...prev, user: { ...prev.user!, role: "admin" } }));

    await rightClickMember(container, 3);
    const menu = document.body.querySelector(".context-menu");
    expect(menu).not.toBeNull();
    const labels = Array.from(menu!.children)
      .filter((el) => el.classList.contains("context-menu__item"))
      .map((el) => el.firstChild?.textContent ?? "");
    expect(labels).toEqual(expect.arrayContaining(["Change Role", "Force Logout", "Ban"]));

    document.body.querySelector(".context-menu")?.remove();
  });

  it("displays member names with role-colored text", () => {
    setTestMembers([
      makeMember({ id: 1, username: "OwnerUser", role: "owner", status: "online" as UserStatus }),
    ]);
    memberList.mount(container);

    const nameEl = container.querySelector(".mi-name") as HTMLSpanElement;
    expect(nameEl.textContent).toBe("OwnerUser");
    // Owner role has specific color var, shown through the role clamp (B9 Q13).
    // No theme surfaces are measurable here, so the clamp fails closed.
    expect(nameEl.dataset["roleColor"]).toBe("var(--role-owner, #e74c3c)");
    expect(nameEl.style.color).toBe("var(--text-normal)");
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

  it("titles the status dot with the catalog label", () => {
    setTestMembers([
      makeMember({ id: 1, username: "Dee", role: "member", status: "dnd" as UserStatus }),
    ]);
    memberList.mount(container);
    const dot = container.querySelector(".mi-status") as HTMLDivElement;
    expect(dot.title).toBe("Do Not Disturb");
    expect(dot.getAttribute("aria-label")).toBe("Do Not Disturb");
  });

  it("paints the letter avatar from the username palette, not the role colour", () => {
    const member = makeMember({ id: 1, username: "Pal", role: "admin" });
    setTestMembers([member]);
    memberList.mount(container);
    const bg = (): string =>
      (container.querySelector(".mi-avatar") as HTMLElement).style.background;
    const probe = document.createElement("div");
    probe.style.background = pickAvatarColor("Pal");
    expect(bg()).toBe(probe.style.background);

    updateMemberRole(1, "moderator");
    membersStore.flush();
    expect(bg()).toBe(probe.style.background);
  });

  it("sorts A-Z with idle and dnd interleaved among online, offline last", () => {
    setTestMembers([
      makeMember({ id: 1, username: "zed", role: "member", status: "online" as UserStatus }),
      makeMember({ id: 2, username: "Bea", role: "member", status: "offline" as UserStatus }),
      makeMember({ id: 3, username: "carl", role: "member", status: "dnd" as UserStatus }),
      makeMember({ id: 4, username: "Amy", role: "member", status: "idle" as UserStatus }),
      makeMember({ id: 5, username: "dora", role: "member", status: "online" as UserStatus }),
      makeMember({ id: 6, username: "Abe", role: "member", status: "invisible" as UserStatus }),
    ]);
    memberList.mount(container);

    const names = Array.from(container.querySelectorAll(".member-item")).map(
      (el) => el.querySelector(".mi-name")?.textContent,
    );
    expect(names).toEqual(["Amy", "carl", "dora", "zed", "Abe", "Bea"]);
  });

  it("keeps offline members last within a group", () => {
    setTestMembers([
      makeMember({ id: 1, username: "Offline", role: "member", status: "offline" as UserStatus }),
      makeMember({ id: 2, username: "Dnd", role: "member", status: "dnd" as UserStatus }),
      makeMember({ id: 3, username: "Online", role: "member", status: "online" as UserStatus }),
      makeMember({ id: 4, username: "Idle", role: "member", status: "idle" as UserStatus }),
    ]);
    memberList.mount(container);

    const items = container.querySelectorAll(".member-item");
    const names = Array.from(items).map((el) => el.querySelector(".mi-name")?.textContent);

    // One online bucket (A-Z), then offline.
    expect(names).toEqual(["Dnd", "Idle", "Online", "Offline"]);
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
    expect(dot.getAttribute("aria-label")).toBe("Do Not Disturb");
    expect(dot.title).toBe("Do Not Disturb");

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

  it("opens the profile popup with live status after a presence-only patch", async () => {
    setTestMembers(testMembers);
    memberList.mount(container);

    // Eve starts online; the presence flip to offline is presence-only, so
    // it takes the patchPresence fast path (row identity preserved, no
    // renderList/createMemberItem call).
    updatePresence(5, "offline");
    membersStore.flush();

    const eveRow = container.querySelector('[data-testid="member-5"]') as HTMLDivElement;
    expect(eveRow.classList.contains("offline")).toBe(true);

    eveRow.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));

    // The popup module loads on first open.
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull(),
    );
    const popup = document.querySelector('[data-testid="user-profile-popup"]');
    const statusDot = popup!.querySelector(".upp-status-dot") as HTMLDivElement;
    // Bug: createMemberItem's click handler closes over the render-time
    // `member` snapshot, which patchPresence never replaces, so the popup
    // still shows Eve as online instead of the live offline status.
    expect(statusDot.title).toBe("Offline");

    popup!.remove();
    document.querySelector('[data-testid="user-profile-overlay"]')?.remove();
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

  // OC-0295: renderList -> appendGroup -> createMemberItem hands every row's
  // click/contextmenu listeners to the component-lifetime `disposable.signal`,
  // which only aborts in destroy(). A full rebuild (any non-presence-only
  // membersStore change, e.g. a role change) discards the old rows' DOM but
  // never aborts their listeners, so a stale, detached row's listener keeps
  // firing — and keeps the row (and everything it closed over) reachable —
  // for the component's entire lifetime, exactly the defect already fixed in
  // ChannelSidebar (renderAc, OC-0229) and MessageList (OC-0286).
  it("aborts a discarded row's listeners on a full rebuild instead of retaining them for the component's lifetime", () => {
    setTestMembers(testMembers);
    memberList.mount(container);

    const eveRowBefore = container.querySelector('[data-testid="member-5"]') as HTMLDivElement;
    expect(eveRowBefore).not.toBeNull();

    // Structural change (role change) -> renderList rebuild, discarding the
    // old row in favor of a freshly rendered one.
    updateMemberRole(5, "admin");
    membersStore.flush();
    expect(container.contains(eveRowBefore)).toBe(false);

    // The row element is detached, but nothing detaches its listener from the
    // underlying signal until destroy() -- clicking the stale, discarded row
    // must not still reach the handler it closed over.
    eveRowBefore.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }),
    );
    expect(document.querySelector('[data-testid="user-profile-popup"]')).toBeNull();
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

describe("MemberList arrow navigation", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMemberList> | null;

  const row = (id: number): HTMLElement =>
    container.querySelector<HTMLElement>(`[data-testid="member-${id}"]`)!;
  const focusedId = (): string | null | undefined =>
    document.activeElement?.getAttribute("data-testid");
  const press = (el: Element, key: string): boolean =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const box = (): HTMLInputElement =>
    container.querySelector<HTMLInputElement>('[data-testid="member-search"]')!;

  // ADMIN: ann(1); MEMBER: bob(2), cy(3); OFFLINE: dee(4), eli(5).
  const roster = (): Member[] => [
    makeMember({ id: 1, username: "ann", role: "admin" }),
    makeMember({ id: 2, username: "bob", role: "member" }),
    makeMember({ id: 3, username: "cy", role: "member" }),
    makeMember({ id: 4, username: "dee", role: "member", status: "offline" }),
    makeMember({ id: 5, username: "eli", role: "member", status: "offline" }),
  ];

  function mountWith(members: Member[]): void {
    setTestMembers(members);
    list = createMemberList(defaultOpts());
    list.mount(container);
  }

  useMemberListSuite(
    (c) => {
      container = c;
      list = null;
    },
    () => list,
  );

  it("ArrowDown and ArrowUp move between member rows, skipping headers", () => {
    mountWith(roster());
    row(1).focus();
    const seen: (string | null | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      expect(press(document.activeElement!, "ArrowDown")).toBe(false);
      seen.push(focusedId());
    }
    expect(seen).toEqual(["member-2", "member-3", "member-4", "member-5"]);
    // The last row stays put.
    press(row(5), "ArrowDown");
    expect(focusedId()).toBe("member-5");
    press(row(5), "ArrowUp");
    press(row(4), "ArrowUp");
    expect(focusedId()).toBe("member-3");
    press(row(3), "ArrowUp");
    press(row(2), "ArrowUp");
    expect(focusedId()).toBe("member-1");
    press(row(1), "ArrowUp");
    expect(focusedId()).toBe("member-1");
  });

  it("Home and End reach the first and last member", () => {
    mountWith(roster());
    row(3).focus();
    press(row(3), "End");
    expect(focusedId()).toBe("member-5");
    press(row(5), "Home");
    expect(focusedId()).toBe("member-1");
    press(row(1), "PageDown");
    expect(focusedId()).toBe("member-5");
    press(row(5), "PageUp");
    expect(focusedId()).toBe("member-1");
    // Every rendered row keeps its tab stop.
    for (const id of [1, 2, 3, 4, 5]) expect(row(id).getAttribute("tabindex")).toBe("0");
  });

  it("arrows during search move only between matches", () => {
    mountWith(roster());
    box().value = "e";
    box().dispatchEvent(new Event("input", { bubbles: true }));
    // dee and eli match; the rest do not.
    expect(container.querySelectorAll(".member-item")).toHaveLength(2);
    row(4).focus();
    press(row(4), "ArrowDown");
    expect(focusedId()).toBe("member-5");
    press(row(5), "ArrowDown");
    expect(focusedId()).toBe("member-5");
    press(row(5), "Home");
    expect(focusedId()).toBe("member-4");
  });

  it("profile popup fallback focuses that member's row", async () => {
    mountWith(roster());
    const before = row(3);
    before.focus();
    press(before, "Enter");
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("data-testid")).toBe("user-profile-popup"),
    );
    // A rename rebuilds the row, so the popup's own opener is gone.
    setTestMembers(roster().map((m) => (m.id === 3 ? { ...m, displayName: "Cyrus" } : m)));
    membersStore.flush();
    expect(row(3)).not.toBe(before);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.activeElement).toBe(row(3));
  });

  it("does not move focus for modified keys or for a key pressed off the row", () => {
    mountWith(roster());
    row(2).focus();
    row(2).dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }),
    );
    expect(focusedId()).toBe("member-2");
    const inner = row(2).querySelector(".mi-name")!;
    press(inner, "ArrowDown");
    expect(focusedId()).toBe("member-2");
  });

  it("focusMember focuses a row, or the first row when the member is gone", () => {
    mountWith(roster());
    expect(list!.focusMember(4)).toBe(row(4));
    expect(document.activeElement).toBe(row(4));
    expect(list!.focusMember(99)).toBe(row(1));
    expect(document.activeElement).toBe(row(1));
  });

  it("the focused member going offline continues from its new position", () => {
    mountWith(roster());
    row(1).focus();
    press(row(1), "ArrowDown");
    expect(focusedId()).toBe("member-2");
    // bob moves from MEMBER into OFFLINE (A-Z): order is ann, cy, bob, dee, eli.
    updatePresence(2, "offline");
    membersStore.flush();
    expect(focusedId()).toBe("member-2");
    press(row(2), "ArrowDown");
    expect(focusedId()).toBe("member-4");
    press(row(4), "ArrowUp");
    press(row(2), "ArrowUp");
    expect(focusedId()).toBe("member-3");
  });

  it("focus follows the focused member when its row is rebuilt", () => {
    const members = roster();
    mountWith(members);
    const old = row(2);
    old.focus();
    // A display name change alters the row signature, so reconcile builds a new
    // row and hands focus to it by key.
    setTestMembers(members.map((m) => (m.id === 2 ? { ...m, displayName: "Bobby" } : m)));
    membersStore.flush();
    expect(row(2)).not.toBe(old);
    expect(document.activeElement).toBe(row(2));
  });

  it("a search that removes the focused member focuses the first match, not the body", () => {
    mountWith(roster());
    row(1).focus();
    box().value = "eli";
    box().dispatchEvent(new Event("input", { bubbles: true }));
    expect(container.querySelector('[data-testid="member-1"]')).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(focusedId()).toBe("member-5");
  });

  it("the only match renamed out of the search moves focus to the search box", () => {
    const members = roster();
    mountWith(members);
    box().value = "eli";
    box().dispatchEvent(new Event("input", { bubbles: true }));
    row(5).focus();
    setTestMembers(members.map((m) => (m.id === 5 ? { ...m, username: "zed" } : m)));
    membersStore.flush();
    expect(container.querySelector(".member-item")).toBeNull();
    expect(document.activeElement).toBe(box());
  });
});

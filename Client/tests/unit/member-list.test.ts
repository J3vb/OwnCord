import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemberList } from "@components/MemberList";
import type { MemberListOptions } from "@components/MemberList";
import {
  membersStore,
  updatePresence,
  updateMemberRole,
  updateMemberProfile,
} from "@stores/members.store";
import type { Member } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { setConnectionStatus } from "@stores/ui.store";
import { channelsStore, setRoles, type Channel } from "@stores/channels.store";
import { resetVoiceStore, updateVoiceState } from "@stores/voice.store";
import { setMemberTimeouts } from "../../src/features/moderation/store";
import { claimComposer } from "../../src/features/messaging/activeComposer";
import { Permission, type UserStatus } from "../../src/lib/types";
import { pickAvatarColor } from "@components/message-list/avatar";
import { applyThemeByName } from "@lib/themes";
import { applyReadyCapabilities, resetServerCapabilities } from "../../src/lib/serverCapabilities";
import { openUserProfilePopup } from "../../src/features/profiles/openUserProfilePopup";

/**
 * Give the role clamp (B9 Q13) the dark theme's surfaces to measure names
 * against; a theme switch is what empties its cache.
 */
function useDarkSurfaces(): void {
  const html = document.documentElement.style;
  html.setProperty("--bg-primary", "#313338");
  html.setProperty("--bg-secondary", "#2b2d31");
  html.setProperty("--bg-tertiary", "#1e1f22");
  html.setProperty("--bg-input", "#383a40");
  applyThemeByName("dark");
}
// MemberList loads the profile popup on first open. Load it up front so its
// modules' load-time listeners are not counted against the test that opens it.
import "@components/UserProfilePopup";
// Likewise the member menu chunk (AdminActions), loaded on the first right-click.
import "@components/AdminActions";

// jsdom has no ResizeObserver; the member menu re-clamps itself through one.
// The fake hands the latest observer's callback to tests that resize the menu.
let lastResizeCallback: (() => void) | null = null;
globalThis.ResizeObserver = class {
  constructor(callback: () => void) {
    lastResizeCallback = callback;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

function resetStore(): void {
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
  // Role list drives member-list grouping/colors — reset so tests that seed
  // roles don't leak into the ones asserting the fallback groups.
  setRoles([]);
  // The moderation-menu gate now reads the live authStore role (see "re-reads
  // the current user's role live..." below), so a user left behind by an
  // earlier test — the "admin"/"owner" role names in particular fall back to
  // isLegacyAdminRole's full-access grant when that name isn't in the
  // per-test role list — would otherwise leak into unrelated gate tests.
  authStore.setState(() => ({
    token: null,
    user: null,
    serverName: null,
    motd: null,
    isAuthenticated: false,
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
    await vi.dynamicImportSettled();

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
    await vi.dynamicImportSettled();

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

      const memberItem = container.querySelector('[data-testid="member-3"]') as HTMLDivElement;
      memberItem.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      await vi.dynamicImportSettled();
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
      authStore.setState(() => ({
        token: "tok",
        user: { id: 99, username: "Actor", avatar: null, role: actorRole },
        serverName: "Test",
        motd: null,
        isAuthenticated: true,
      }));
      setTestMembers(testMembers);
      memberList.mount(container);
      const item = container.querySelector(`[data-testid="member-${targetId}"]`) as HTMLElement;
      item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      await vi.dynamicImportSettled();
      return document.body.querySelector<HTMLElement>(".context-menu");
    }

    function topLabels(menu: HTMLElement): string[] {
      return Array.from(menu.children)
        .filter((el) => el.classList.contains("context-menu__item"))
        .map((el) => el.firstChild?.textContent ?? "");
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
        expect(topLabels(menu!)).toEqual(["Profile", "Mention", "Block"]);
        document.body.querySelector(".context-menu")?.remove();
        memberList.destroy?.();
        memberList = createMemberList(defaultOpts());
      }
    });

    it("keeps every action for a member ranked below the actor", async () => {
      const menu = await openMenuOn("Admin", 3);
      expect(topLabels(menu!)).toEqual(
        expect.arrayContaining(["Change Role", "Force Logout", "Ban", "Block"]),
      );
    });
  });

  it("right-clicking yourself opens Profile and Mention only", async () => {
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
    await vi.dynamicImportSettled();

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
    authStore.setState(() => ({
      token: "tok",
      user: { id: 999, username: "Self", avatar: null, role: "member" },
      serverName: "Test",
      motd: null,
      isAuthenticated: true,
    }));
    setTestMembers(testMembers);
    const opts: MemberListOptions = { ...defaultOpts(), currentUserRole: "member" };
    memberList.destroy?.();
    memberList = createMemberList(opts);
    memberList.mount(container);

    // Mid-session promotion after mount -- opts.currentUserRole was only
    // ever read once, but authStore now says admin.
    authStore.setState((prev) => ({ ...prev, user: { ...prev.user!, role: "admin" } }));

    const memberItem = container.querySelector('[data-testid="member-3"]') as HTMLDivElement;
    memberItem.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await vi.dynamicImportSettled();
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
  it("aborts a discarded row's listeners on a full rebuild instead of retaining them for the component's lifetime (OC-0295)", () => {
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
    // The popup's Message/Call are disabled while offline (WP 3B-2).
    setConnectionStatus("connected");
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    list?.destroy?.();
    list = null;
    container.remove();
    resetStore();
    setConnectionStatus("disconnected");
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

  it("shows Playing <game> as the second line, with the controller icon (WP 8.3)", () => {
    setTestMembers([
      makeMember({
        id: 1,
        username: "alice",
        activity: { name: "VALORANT", startedAt: Date.now() - 60_000 },
      }),
      makeMember({ id: 2, username: "bob" }),
    ]);
    list = createMemberList(opts);
    list.mount(container);

    const line = container.querySelector('[data-testid="member-activity-1"]');
    expect(line?.textContent).toBe("Playing VALORANT");
    expect(line?.querySelector("svg")).not.toBeNull();
    expect(container.querySelector('[data-testid="member-activity-2"]')).toBeNull();
    // The row is described by the game line as well as the status dot.
    const row = container.querySelector('[data-testid="member-1"]');
    expect(row?.getAttribute("aria-describedby")).toContain("mi-activity-1");
  });

  it("lets a custom status win the row; the game is not drawn there (WP 8.3)", () => {
    setTestMembers([
      makeMember({
        id: 1,
        username: "alice",
        customStatus: "shipping phase 6",
        activity: { name: "VALORANT", startedAt: Date.now() },
      }),
    ]);
    list = createMemberList(opts);
    list.mount(container);

    expect(container.querySelector('[data-testid="member-custom-status-1"]')?.textContent).toBe(
      "shipping phase 6",
    );
    expect(container.querySelector('[data-testid="member-activity-1"]')).toBeNull();
  });

  it("follows a game starting and stopping in place (WP 8.3)", () => {
    setTestMembers([makeMember({ id: 1, username: "alice" })]);
    list = createMemberList(opts);
    list.mount(container);
    expect(container.querySelector('[data-testid="member-activity-1"]')).toBeNull();

    setTestMembers([
      makeMember({ id: 1, username: "alice", activity: { name: "Factorio", startedAt: 1 } }),
    ]);
    membersStore.flush();
    expect(container.querySelector('[data-testid="member-activity-1"]')?.textContent).toBe(
      "Playing Factorio",
    );

    setTestMembers([makeMember({ id: 1, username: "alice", activity: null })]);
    membersStore.flush();
    expect(container.querySelector('[data-testid="member-activity-1"]')).toBeNull();
  });

  describe("Listening to <player> (WP 8.10)", () => {
    const song = {
      title: "Blue in Green",
      artist: "Miles Davis",
      player: "Spotify",
      startedAt: 1,
      durationMs: 337_000,
    };

    it("shows Listening to <player> as the second line, with the music note", () => {
      setTestMembers([
        makeMember({ id: 1, username: "alice", listening: song }),
        makeMember({ id: 2, username: "bob" }),
      ]);
      list = createMemberList(opts);
      list.mount(container);

      const line = container.querySelector('[data-testid="member-activity-1"]');
      expect(line?.textContent).toBe("Listening to Spotify");
      expect(line?.querySelector("svg")).not.toBeNull();
      expect(line?.querySelector("svg path")?.getAttribute("d")).toBe("M9 18V5l12-2v13");
      expect(container.querySelector('[data-testid="member-activity-2"]')).toBeNull();
      const row = container.querySelector('[data-testid="member-1"]');
      expect(row?.getAttribute("aria-describedby")).toContain("mi-activity-1");
    });

    it("priority: a custom status beats a game, and a game beats music", () => {
      const activity = { name: "VALORANT", startedAt: Date.now() };
      setTestMembers([
        makeMember({ id: 1, username: "alice", customStatus: "busy", activity, listening: song }),
        makeMember({ id: 2, username: "bob", activity, listening: song }),
        makeMember({ id: 3, username: "cy", listening: song }),
      ]);
      list = createMemberList(opts);
      list.mount(container);

      expect(container.querySelector('[data-testid="member-custom-status-1"]')?.textContent).toBe(
        "busy",
      );
      expect(container.querySelector('[data-testid="member-activity-1"]')).toBeNull();
      expect(container.querySelector('[data-testid="member-activity-2"]')?.textContent).toBe(
        "Playing VALORANT",
      );
      expect(container.querySelector('[data-testid="member-activity-3"]')?.textContent).toBe(
        "Listening to Spotify",
      );
    });

    it("follows a song starting, the game taking over, and the music stopping in place", () => {
      setTestMembers([makeMember({ id: 1, username: "alice" })]);
      list = createMemberList(opts);
      list.mount(container);
      expect(container.querySelector('[data-testid="member-activity-1"]')).toBeNull();

      setTestMembers([makeMember({ id: 1, username: "alice", listening: song })]);
      membersStore.flush();
      expect(container.querySelector('[data-testid="member-activity-1"]')?.textContent).toBe(
        "Listening to Spotify",
      );

      setTestMembers([
        makeMember({
          id: 1,
          username: "alice",
          listening: song,
          activity: { name: "Factorio", startedAt: 1 },
        }),
      ]);
      membersStore.flush();
      const game = container.querySelector('[data-testid="member-activity-1"]');
      expect(game?.textContent).toBe("Playing Factorio");
      // The icon changed with the line: the controller, not the note.
      expect(game?.querySelector("svg path")?.getAttribute("d")).not.toBe("M9 18V5l12-2v13");

      setTestMembers([makeMember({ id: 1, username: "alice", listening: null, activity: null })]);
      membersStore.flush();
      expect(container.querySelector('[data-testid="member-activity-1"]')).toBeNull();
    });
  });

  it("opens the profile from the keyboard, where Report names the user (B9-10)", async () => {
    setTestMembers([
      makeMember({ id: 1, username: "alice", displayName: "Alice A." }),
      makeMember({ id: 2, username: "me" }),
    ]);
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 2, username: "me", avatar: null, role: "member" },
    }));
    const onReportUser = vi.fn();
    list = createMemberList({ ...opts, onReportUser });
    list.mount(container);

    const row = container.querySelector<HTMLElement>('[data-testid="member-1"]')!;
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("aria-label")).toBe("Alice A.");
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const report = await vi.waitFor(() => {
      const btn = document.querySelector<HTMLButtonElement>('[data-testid="upp-report-btn"]');
      expect(btn).not.toBeNull();
      return btn!;
    });
    report.click();
    expect(onReportUser).toHaveBeenCalledWith(1, "Alice A.");

    // Your own profile has nothing to report.
    const self = container.querySelector<HTMLElement>('[data-testid="member-2"]')!;
    self.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-testid="upp-report-btn"]')).toBeNull();
  });

  it("wires the profile popup's Call action to onCallUser, but not for yourself (BUG-05)", async () => {
    setTestMembers([
      makeMember({ id: 1, username: "alice" }),
      makeMember({ id: 2, username: "me" }),
    ]);
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 2, username: "me", avatar: null, role: "member" },
    }));
    const onCallUser = vi.fn();
    list = createMemberList({ ...opts, onCallUser });
    list.mount(container);

    // Another member: the Call action renders and reaches the handler.
    const other = container.querySelector<HTMLElement>('[data-testid="member-1"]')!;
    other.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    const callBtn = await vi.waitFor(() => {
      const btn = document.querySelector<HTMLButtonElement>('[data-testid="upp-call-btn"]');
      expect(btn).not.toBeNull();
      return btn!;
    });
    callBtn.click();
    expect(onCallUser).toHaveBeenCalledWith(1);
    // Clicking an action closes the popup, like Message does.
    expect(document.querySelector('[data-testid="user-profile-popup"]')).toBeNull();

    // Your own profile has no Call action — you are already in the call.
    const self = container.querySelector<HTMLElement>('[data-testid="member-2"]')!;
    self.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-testid="upp-call-btn"]')).toBeNull();
  });

  it("omits the Call action when no onCallUser handler is wired (BUG-05)", async () => {
    setTestMembers([makeMember({ id: 1, username: "alice" })]);
    list = createMemberList(opts);
    list.mount(container);

    const row = container.querySelector<HTMLElement>('[data-testid="member-1"]')!;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-testid="upp-call-btn"]')).toBeNull();
  });

  it("returns focus to the row that opened the profile after an earlier one closed (B9-10)", async () => {
    setTestMembers([
      makeMember({ id: 1, username: "alice" }),
      makeMember({ id: 3, username: "carol" }),
    ]);
    list = createMemberList(opts);
    list.mount(container);
    const rowA = container.querySelector<HTMLElement>('[data-testid="member-1"]')!;
    const rowB = container.querySelector<HTMLElement>('[data-testid="member-3"]')!;
    const openFrom = async (row: HTMLElement): Promise<void> => {
      row.focus();
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await vi.waitFor(() =>
        expect(document.activeElement?.getAttribute("data-testid")).toBe("user-profile-popup"),
      );
    };
    const escape = (): void => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    };

    await openFrom(rowA);
    escape();
    expect(document.activeElement).toBe(rowA);

    await openFrom(rowB);
    escape();
    expect(document.activeElement).toBe(rowB);
  });

  it("returns focus to the user's rebuilt row when the list re-rendered while the profile was open (B9-10)", async () => {
    setTestMembers([
      makeMember({ id: 1, username: "alice" }),
      makeMember({ id: 3, username: "carol" }),
    ]);
    list = createMemberList(opts);
    list.mount(container);
    const before = container.querySelector<HTMLElement>('[data-testid="member-3"]')!;
    before.focus();
    before.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("data-testid")).toBe("user-profile-popup"),
    );

    updateMemberRole(3, "admin");
    membersStore.flush();
    const after = container.querySelector<HTMLElement>('[data-testid="member-3"]')!;
    expect(after).not.toBe(before);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.activeElement).toBe(after);
  });

  it("leaves a profile popup another component opened open when it is destroyed", async () => {
    setTestMembers([makeMember({ id: 1, username: "alice" })]);
    list = createMemberList(opts);
    list.mount(container);

    // A message author card, opened by MessageList through the shared opener.
    const closeOther = openUserProfilePopup({ userId: 1, anchorX: 0, anchorY: 0 });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull(),
    );

    list.destroy?.();
    list = undefined as never;

    expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull();
    closeOther();
  });

  it("closes the profile popup it opened itself when it is destroyed", async () => {
    setTestMembers([makeMember({ id: 1, username: "alice" })]);
    list = createMemberList(opts);
    list.mount(container);
    container
      .querySelector<HTMLElement>('[data-testid="member-1"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull(),
    );

    list.destroy?.();
    list = undefined as never;

    expect(document.querySelector('[data-testid="user-profile-popup"]')).toBeNull();
  });

  it("describes each row by its custom status and presence, kept current (B9-10)", () => {
    setTestMembers([
      makeMember({ id: 1, username: "alice", customStatus: "shipping" }),
      makeMember({ id: 2, username: "bob", status: "idle" }),
    ]);
    list = createMemberList(opts);
    list.mount(container);

    const description = (testId: string): string =>
      container
        .querySelector(`[data-testid="${testId}"]`)!
        .getAttribute("aria-describedby")!
        .split(" ")
        .map((id) => {
          const el = document.getElementById(id)!;
          return el.getAttribute("aria-label") ?? el.textContent;
        })
        .join(" ");
    expect(description("member-1")).toBe("shipping Online");
    expect(description("member-2")).toBe("Idle");

    updatePresence(1, "dnd");
    membersStore.flush();
    expect(description("member-1")).toBe("shipping Do Not Disturb");
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
    const row = container.querySelector(`[data-testid="member-${targetId}"]`) as HTMLElement;
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await vi.dynamicImportSettled();
    return document.body.querySelector<HTMLElement>(".context-menu");
  }

  function topLabels(menu: HTMLElement): string[] {
    return Array.from(menu.children)
      .filter((el) => el.classList.contains("context-menu__item"))
      .map((el) => el.firstChild?.textContent ?? "");
  }

  const timeoutOpts = (): Partial<MemberListOptions> => ({
    onTimeoutMember: vi.fn().mockResolvedValue(undefined),
    onRemoveTimeout: vi.fn().mockResolvedValue(undefined),
  });

  function makeChannel(id: number, type: Channel["type"]): Channel {
    return {
      id,
      name: `ch-${id}`,
      type,
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
    };
  }

  function putInVoice(userId: number, channelId: number): void {
    updateVoiceState({
      channel_id: channelId,
      user_id: userId,
      username: `u${userId}`,
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
  }

  beforeEach(() => {
    resetStore();
    seedRanks();
    setMemberTimeouts(undefined);
    resetVoiceStore();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    list?.destroy?.();
    list = null;
    document.body.querySelectorAll(".context-menu").forEach((el) => el.remove());
    container.remove();
    setMemberTimeouts(undefined);
    resetVoiceStore();
    resetStore();
  });

  // (13)
  it("offers Timeout only with MODERATE_MEMBERS and a higher rank than the target", async () => {
    signInAs("Moderator");
    // Member (rank 40) is below the Moderator: Timeout is offered.
    let menu = await openMenu(4, timeoutOpts());
    expect(topLabels(menu!)).toContain("Timeout");
    list!.destroy?.();
    menu!.remove();

    // Another Moderator (equal rank) is not.
    menu = await openMenu(3, timeoutOpts());
    expect(topLabels(menu!)).not.toContain("Timeout");
    expect(topLabels(menu!)).not.toContain("Remove Timeout");
    list!.destroy?.();
    menu!.remove();

    // Without the permission bit, even a lower-ranked target gets neither.
    signInAs("Member");
    menu = await openMenu(5, timeoutOpts());
    expect(topLabels(menu!)).not.toContain("Timeout");
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
    const labels = topLabels(menu!).filter((l) => l === "Timeout" || l === "Remove Timeout");
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
    expect(topLabels(menu!)).not.toContain("Disconnect");
    list!.destroy?.();
    menu!.remove();

    // In a DM call: no voice rows.
    putInVoice(4, 11);
    menu = await openMenu(4, { voiceModFor });
    expect(topLabels(menu!)).not.toContain("Disconnect");
    list!.destroy?.();
    menu!.remove();
    expect(voiceModFor).not.toHaveBeenCalled();

    // In a server voice channel but nothing wired: no voice rows.
    resetVoiceStore();
    putInVoice(4, 10);
    menu = await openMenu(4);
    expect(topLabels(menu!)).not.toContain("Disconnect");
    list!.destroy?.();
    menu!.remove();

    // In a server voice channel with options: the three rows.
    menu = await openMenu(4, { voiceModFor });
    expect(topLabels(menu!)).toEqual(expect.arrayContaining(voiceLabels));
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
      expect(topLabels(menu!)).toEqual(["Profile", "Mention", "Message", "Block"]);
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

describe("MemberList search (3C-4b)", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMemberList> | null = null;

  const row = (id: number): HTMLElement =>
    container.querySelector<HTMLElement>(`[data-testid="member-${id}"]`)!;
  const box = (): HTMLInputElement =>
    container.querySelector<HTMLInputElement>('[data-testid="member-search"]')!;
  const texts = (): string[] =>
    Array.from(
      container.querySelectorAll(".member-role-group, .member-item, .member-list-empty-text"),
    ).map((el) =>
      el.classList.contains("member-item")
        ? (el.getAttribute("data-testid") ?? "")
        : (el.textContent ?? ""),
    );
  function type(value: string): void {
    box().value = value;
    box().dispatchEvent(new Event("input", { bubbles: true }));
  }

  beforeEach(() => {
    resetStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    list = null;
  });

  afterEach(() => {
    list?.destroy?.();
    container.remove();
  });

  function mountWith(members: Member[]): void {
    setTestMembers(members);
    list = createMemberList(defaultOpts());
    list.mount(container);
  }

  const roster = (): Member[] => [
    makeMember({ id: 1, username: "zoe_x", displayName: "Zoë Quinn", role: "admin" }),
    makeMember({ id: 2, username: "bob", role: "member" }),
    makeMember({ id: 3, username: "zorro", role: "member", status: "offline" }),
    makeMember({ id: 4, username: "carl", displayName: "Carlos", role: "member" }),
  ];

  it("renders a labelled search box before the list", () => {
    mountWith(roster());
    expect(box().getAttribute("aria-label")).toBe("Search members");
    expect(box().placeholder).toBe("Search members");
    expect(box().parentElement!.nextElementSibling!.classList.contains("member-list")).toBe(true);
    list!.destroy?.();
    expect(container.querySelector(".member-search-wrap")).toBeNull();
  });

  it("search filters by display name and username, case- and diacritic-insensitive", () => {
    mountWith(roster());
    type("ZOE");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-1"]);
    type("ZO");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-1", "member-3"]);
    type("quinn");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-1"]);
    type("carlos");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-4"]);
    type("CARL");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-4"]);
  });

  it("search ignores a leading @ and surrounding spaces", () => {
    mountWith(roster());
    type("  @bob ");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-2"]);
    type("@ bob");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-2"]);
  });

  it("search re-folds a member renamed while filtered", () => {
    mountWith(roster());
    type("quinn");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-1"]);
    updateMemberProfile(1, { username: "zoe_x", avatar: null, displayName: "Zed" });
    membersStore.flush();
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual([]);
    type("zed");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-1"]);
  });

  it("counts reflect matches and empty groups hide", () => {
    mountWith(roster());
    expect(texts().filter((t) => t.includes(" — "))).toEqual([
      "ADMIN — 1",
      "MEMBER — 2",
      "OFFLINE — 1",
    ]);
    type("zo");
    expect(texts()).toEqual(["ADMIN — 1", "member-1", "OFFLINE — 1", "member-3"]);
    type("bob");
    expect(texts()).toEqual(["MEMBER — 1", "member-2"]);
  });

  it("no match shows members.searchEmpty, and clearing restores the list", () => {
    mountWith(roster());
    type("nobody");
    expect(texts()).toEqual(["No members match your search"]);
    type("");
    expect(texts().filter((t) => t.startsWith("member-"))).toHaveLength(4);
  });

  it("Escape clears a non-empty query and keeps focus; an empty box is left alone", () => {
    mountWith(roster());
    box().focus();
    type("bob");
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    box().dispatchEvent(esc);
    document.removeEventListener("keydown", seen);
    expect(box().value).toBe("");
    expect(esc.defaultPrevented).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(box());
    expect(texts().filter((t) => t.startsWith("member-"))).toHaveLength(4);

    const again = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    box().dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
  });

  it("a live presence change keeps the filter applied", () => {
    mountWith(roster());
    type("zo");
    updatePresence(1, "offline");
    membersStore.flush();
    expect(texts()).toEqual(["OFFLINE — 2", "member-1", "member-3"]);
    // A member who joins and does not match stays hidden; one who does shows.
    setTestMembers([
      ...roster(),
      makeMember({ id: 9, username: "newbie" }),
      makeMember({ id: 10, username: "zoomer" }),
    ]);
    membersStore.flush();
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual([
      "member-1",
      "member-10",
      "member-3",
    ]);
  });

  it("a full snapshot re-applies the active search and reuses unchanged rows", () => {
    mountWith(roster());
    type("zo");
    const before = row(1);
    setTestMembers(roster().map((m) => ({ ...m })));
    membersStore.flush();
    expect(box().value).toBe("zo");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-1", "member-3"]);
    expect(row(1)).toBe(before);
    expect(texts().filter((t) => t.includes(" — "))).toEqual(["ADMIN — 1", "OFFLINE — 1"]);
  });
});

describe("MemberList arrow navigation (4.14b)", () => {
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

  beforeEach(() => {
    resetStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    list = null;
  });

  afterEach(() => {
    list?.destroy?.();
    container.remove();
  });

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

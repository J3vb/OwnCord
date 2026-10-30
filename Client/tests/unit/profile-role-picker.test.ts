/**
 * The profile popup's role picker (WP 3C-5c, P11): shown only to a viewer who
 * holds MANAGE_ROLES and outranks the member, lists only roles below the
 * viewer's own, reuses the context menu's role-change request and toasts, and
 * follows the stores while it is open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Loaded up front: the opener imports it lazily, and its module-level window
// listeners would otherwise be counted against the first test.
import "@components/UserProfilePopup";
import {
  openUserProfilePopup,
  closeUserProfilePopup,
} from "../../src/features/profiles/openUserProfilePopup";
import {
  addMemberRole,
  changeMemberRole,
  removeMemberRole,
} from "../../src/features/moderation/roleAssignment";
import {
  applyReadyCapabilities,
  resetServerCapabilities,
} from "../../src/lib/net/serverCapabilities";
import { authStore } from "@stores/auth.store";
import { membersStore, updateMemberRole } from "@stores/members.store";
import { channelsStore, setRoles } from "@stores/channels.store";
import { Permission, type ReadyRole } from "@lib/types";

const ROLES: readonly ReadyRole[] = [
  { id: 1, name: "owner", color: null, permissions: Permission.ADMINISTRATOR, position: 100 },
  { id: 2, name: "admin", color: null, permissions: Permission.MANAGE_ROLES, position: 80 },
  { id: 3, name: "moderator", color: null, permissions: Permission.KICK_MEMBERS, position: 50 },
  { id: 4, name: "member", color: null, permissions: 0, position: 10 },
];

function setViewer(id: number, role: string): void {
  authStore.setState((p) => ({ ...p, user: { id, username: "me", avatar: null, role } as never }));
}

function setMember(id: number, role: string): void {
  membersStore.setState((p) => ({
    ...p,
    members: new Map([
      ...p.members,
      [id, { id, username: `user${id}`, avatar: null, role, status: "online" as const }],
    ]),
  }));
}

const roleButton = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('[data-testid="upp-role-btn"]');
const roleMenu = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="upp-role-menu"]');
const options = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".upp-role-option"));
const badgeText = (): string => document.querySelector(".upp-role-badge")?.textContent ?? "";
const key = (target: Element, k: string): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
};

async function open(
  onChangeRole?: (userId: number, username: string, role: string) => Promise<void>,
  userId = 7,
): Promise<void> {
  openUserProfilePopup({
    userId,
    anchorX: 10,
    anchorY: 10,
    ...(onChangeRole === undefined ? {} : { callbacks: { onChangeRole } }),
  });
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull(),
  );
}

describe("profile popup role picker", () => {
  beforeEach(() => {
    setRoles(ROLES);
    setViewer(1, "admin");
    membersStore.setState((p) => ({ ...p, members: new Map() }));
    setMember(1, "admin");
    setMember(7, "member");
    setMember(8, "admin");
  });

  afterEach(() => {
    closeUserProfilePopup();
    document.body.replaceChildren();
  });

  it("is a menu button for a viewer with MANAGE_ROLES over a lower-ranked member", async () => {
    await open(vi.fn(async () => {}));
    const btn = roleButton()!;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.textContent).toContain("Member");
    expect(roleMenu()).toBeNull();
  });

  it("lists only roles below the viewer's own, the current one checked", async () => {
    await open(vi.fn(async () => {}));
    roleButton()!.click();
    const menu = roleMenu()!;
    expect(menu.getAttribute("role")).toBe("menu");
    expect(roleButton()!.getAttribute("aria-expanded")).toBe("true");
    expect(options().map((o) => o.dataset["role"])).toEqual(["moderator", "member"]);
    for (const o of options()) expect(o.getAttribute("role")).toBe("menuitemradio");
    expect(options().map((o) => o.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  });

  it("stays a plain badge without MANAGE_ROLES", async () => {
    setViewer(1, "moderator");
    await open(vi.fn(async () => {}));
    expect(roleButton()).toBeNull();
    expect(badgeText()).toContain("Member");
  });

  it("stays a plain badge for a member ranked at or above the viewer", async () => {
    await open(
      vi.fn(async () => {}),
      8,
    );
    expect(roleButton()).toBeNull();
    expect(badgeText()).toContain("Admin");
  });

  it("stays a plain badge on the viewer's own card", async () => {
    await open(
      vi.fn(async () => {}),
      1,
    );
    expect(roleButton()).toBeNull();
  });

  it("stays a plain badge when the opener wired no role handler", async () => {
    await open();
    expect(roleButton()).toBeNull();
  });

  it("sends one role request however often the choice is clicked, then closes", async () => {
    const adminChangeRole = vi.fn(() => new Promise<void>((resolve) => release.push(resolve)));
    const release: Array<() => void> = [];
    const notify = vi.fn();
    await open((id, name, role) =>
      changeMemberRole({ api: { adminChangeRole }, notify }, id, name, role),
    );
    roleButton()!.click();
    const moderator = options().find((o) => o.dataset["role"] === "moderator")!;
    moderator.click();
    moderator.click();
    options()[0]!.click();
    expect(adminChangeRole).toHaveBeenCalledTimes(1);
    expect(adminChangeRole).toHaveBeenCalledWith(7, 3);

    release[0]!();
    await vi.waitFor(() => expect(roleMenu()).toBeNull());
    expect(notify).toHaveBeenCalledWith("Changed user7's role to moderator", "success");
    expect(document.activeElement).toBe(roleButton());
  });

  it("choosing the role the member already has sends nothing", async () => {
    const onChangeRole = vi.fn(async () => {});
    await open(onChangeRole);
    roleButton()!.click();
    options()
      .find((o) => o.dataset["role"] === "member")!
      .click();
    expect(onChangeRole).not.toHaveBeenCalled();
    expect(roleMenu()).toBeNull();
  });

  it("shows the existing role-change toast when the request fails", async () => {
    const notify = vi.fn();
    const adminChangeRole = vi.fn().mockRejectedValue(new Error("Role denied"));
    await open((id, name, role) =>
      changeMemberRole({ api: { adminChangeRole }, notify }, id, name, role),
    );
    roleButton()!.click();
    options()
      .find((o) => o.dataset["role"] === "moderator")!
      .click();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Role denied", "error"));
    await vi.waitFor(() => expect(roleMenu()).toBeNull());
    // The roster only changes on the server's echo: the badge is unchanged.
    expect(badgeText()).toContain("Member");
  });

  it("follows the roster: the badge and the checked role update on a role change", async () => {
    await open(vi.fn(async () => {}));
    roleButton()!.click();
    updateMemberRole(7, "moderator");
    await vi.waitFor(() => expect(badgeText()).toContain("Moderator"));
    expect(roleMenu()).not.toBeNull();
    expect(options().map((o) => o.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("places the card again when the list opens, so it stays in the window", async () => {
    let height = 200;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => height);
    vi.stubGlobal("innerHeight", 600);
    try {
      openUserProfilePopup({
        userId: 7,
        anchorX: 10,
        anchorY: 450,
        callbacks: { onChangeRole: vi.fn(async () => {}) },
      });
      await vi.waitFor(() => expect(roleButton()).not.toBeNull());
      const card = document.querySelector<HTMLElement>('[data-testid="user-profile-popup"]')!;
      expect(card.style.top).toBe("392px");
      height = 300;
      roleButton()!.click();
      expect(card.style.top).toBe("292px");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("drops the picker when the member is no longer in the roster", async () => {
    await open(vi.fn(async () => {}));
    expect(roleButton()).not.toBeNull();
    membersStore.setState((p) => {
      const next = new Map(p.members);
      next.delete(7);
      return { ...p, members: next };
    });
    await vi.waitFor(() => expect(roleButton()).toBeNull());
    expect(badgeText()).toContain("Member");
  });

  describe("keyboard", () => {
    it("opens with ArrowDown on the button, focusing the current role", async () => {
      await open(vi.fn(async () => {}));
      const btn = roleButton()!;
      btn.focus();
      key(btn, "ArrowDown");
      expect(roleMenu()).not.toBeNull();
      expect(document.activeElement).toBe(options()[0]);
    });

    it("moves with arrows, Home and End, wrapping at the ends", async () => {
      await open(vi.fn(async () => {}));
      roleButton()!.click();
      // Click focuses the checked role: "member", the last.
      expect(document.activeElement).toBe(options()[1]);
      key(document.activeElement!, "ArrowDown");
      expect(document.activeElement).toBe(options()[0]);
      key(document.activeElement!, "ArrowUp");
      expect(document.activeElement).toBe(options()[1]);
      key(document.activeElement!, "Home");
      expect(document.activeElement).toBe(options()[0]);
      key(document.activeElement!, "End");
      expect(document.activeElement).toBe(options()[1]);
    });

    it("activating the focused role changes it (Enter and Space click a button)", async () => {
      const onChangeRole = vi.fn(async () => {});
      await open(onChangeRole);
      roleButton()!.click();
      key(document.activeElement!, "Home");
      (document.activeElement as HTMLElement).click();
      expect(onChangeRole).toHaveBeenCalledExactlyOnceWith(7, "user7", "moderator");
    });

    it("Escape closes the list and returns focus to the button, not the card", async () => {
      await open(vi.fn(async () => {}));
      roleButton()!.click();
      key(document.activeElement!, "Escape");
      expect(roleMenu()).toBeNull();
      expect(document.activeElement).toBe(roleButton());
      expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull();
      // A second Escape, now with the list closed, closes the card.
      key(document.activeElement!, "Escape");
      expect(document.querySelector('[data-testid="user-profile-popup"]')).toBeNull();
    });
  });

  // Edge case (a): a role changes while the picker is open.
  describe("a role changes while the picker is open", () => {
    it("closes the picker when the viewer can no longer change the role", async () => {
      await open(vi.fn(async () => {}));
      roleButton()!.click();
      expect(roleMenu()).not.toBeNull();

      // The viewer is demoted to a role without MANAGE_ROLES.
      setViewer(1, "moderator");
      await vi.waitFor(() => expect(roleButton()).toBeNull());
      expect(roleMenu()).toBeNull();
      expect(badgeText()).toContain("Member");
      // Focus stays inside the card instead of falling to the page.
      expect(document.activeElement).toBe(
        document.querySelector('[data-testid="user-profile-popup"]'),
      );
    });

    it("closes the picker when the member is promoted to the viewer's rank", async () => {
      await open(vi.fn(async () => {}));
      roleButton()!.click();
      updateMemberRole(7, "admin");
      await vi.waitFor(() => expect(roleButton()).toBeNull());
      expect(badgeText()).toContain("Admin");
    });

    it("re-filters the list when the role list moves a role to the viewer's rank", async () => {
      await open(vi.fn(async () => {}));
      roleButton()!.click();
      expect(options().map((o) => o.dataset["role"])).toEqual(["moderator", "member"]);
      setRoles(ROLES.map((r) => (r.name === "moderator" ? { ...r, position: 80 } : r)));
      await vi.waitFor(() => expect(options().map((o) => o.dataset["role"])).toEqual(["member"]));
      expect(channelsStore.getState().roles).toHaveLength(4);
    });
  });
});

describe("profile popup role chips on a multi_role server", () => {
  const chipEls = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>(".upp-chip"));
  const xs = (): HTMLButtonElement[] =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(".upp-chip-x"));

  async function openMulti(
    onAddRole = vi.fn(async () => {}),
    onRemoveRole = vi.fn(async () => {}),
  ): Promise<void> {
    openUserProfilePopup({
      userId: 7,
      anchorX: 10,
      anchorY: 10,
      callbacks: { onChangeRole: vi.fn(async () => {}), onAddRole, onRemoveRole },
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull(),
    );
  }

  beforeEach(() => {
    setRoles(ROLES);
    setViewer(1, "admin");
    authStore.setState((p) => ({ ...p, user: { ...p.user!, role_ids: [2] } }));
    membersStore.setState((p) => ({ ...p, members: new Map() }));
    setMember(1, "admin");
    setMember(7, "moderator");
    updateMemberRole(7, "moderator", [4, 3]);
    applyReadyCapabilities({ multi_role: true });
  });

  afterEach(() => {
    closeUserProfilePopup();
    resetServerCapabilities();
    document.body.replaceChildren();
  });

  it("shows the held roles by position, an x on each (two held), and no plus when nothing is left", async () => {
    await openMulti();
    expect(roleButton()).toBeNull();
    expect(chipEls().map((c) => c.textContent?.replace("\u00d7", ""))).toEqual([
      "moderator",
      "member",
    ]);
    expect(xs()).toHaveLength(2);
    // Everything below the viewer (moderator, member) is held already: no plus.
    expect(document.querySelector('[data-testid="upp-chip-add"]')).toBeNull();
  });

  it("offers roles below the viewer that are not yet held, and sends the chosen id", async () => {
    updateMemberRole(7, "member", [4]);
    const add = vi.fn(async () => {});
    await openMulti(add);
    expect(xs()).toHaveLength(0);
    document.querySelector<HTMLElement>('[data-testid="upp-chip-add"]')!.click();
    expect(options().map((o) => o.dataset["role"])).toEqual(["moderator"]);
    options()[0]!.click();
    expect(add).toHaveBeenCalledWith(7, "user7", 3);
  });

  it("keeps the single-role picker without the capability", async () => {
    resetServerCapabilities();
    await openMulti();
    expect(roleButton()).not.toBeNull();
    expect(chipEls()).toHaveLength(0);
  });

  it("moves the chips when a member_update echo changes the held roles", async () => {
    await openMulti();
    updateMemberRole(7, "member", [4]);
    await vi.waitFor(() => expect(chipEls()).toHaveLength(1));
  });
});

describe("addMemberRole / removeMemberRole", () => {
  beforeEach(() => setRoles(ROLES));

  it("toasts the outcome and never rejects", async () => {
    const notify = vi.fn();
    const api = {
      adminAddMemberRole: vi.fn(async () => {}),
      adminRemoveMemberRole: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    await addMemberRole({ api, notify }, 7, "user7", 3);
    expect(api.adminAddMemberRole).toHaveBeenCalledWith(7, 3);
    expect(notify).toHaveBeenLastCalledWith("Added moderator to user7", "success");
    await removeMemberRole({ api, notify }, 7, "user7", 3);
    expect(notify).toHaveBeenLastCalledWith("boom", "error");
  });

  it("says so when the role vanished from the roster", async () => {
    const notify = vi.fn();
    const api = { adminAddMemberRole: vi.fn(), adminRemoveMemberRole: vi.fn() };
    await addMemberRole({ api, notify }, 7, "user7", 99);
    expect(api.adminAddMemberRole).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Unknown role"), "error");
  });
});

describe("LAST_ROLE refusal text", () => {
  it("reads as a sentence, not a raw code", async () => {
    const { serverErrorText } = await import("@lib/api");
    expect(serverErrorText("LAST_ROLE", "cannot remove last role", "x")).toBe(
      "A member must keep at least one role.",
    );
  });
});

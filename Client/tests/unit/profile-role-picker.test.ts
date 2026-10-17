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
import { changeMemberRole } from "../../src/features/moderation/roleAssignment";
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

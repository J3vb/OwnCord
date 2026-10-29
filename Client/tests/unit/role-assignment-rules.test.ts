/**
 * Who may hand out which role (WP 3C-5c, 6.3d): the rule set behind the member
 * context menu and the profile popup's role picker and chips. Each case reads
 * the stores the way a live caller does and checks what the viewer is offered.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addMemberRole,
  assignableRoleNames,
  memberRolesState,
  outranksPosition,
  removeMemberRole,
  roleChangeChoices,
} from "../../src/features/moderation/roleAssignment";
import { authStore } from "@stores/auth.store";
import { setRoles } from "@stores/channels.store";
import { Permission, type ReadyRole } from "@lib/types";

const ROLES: readonly ReadyRole[] = [
  { id: 1, name: "Owner", color: null, permissions: Permission.ADMINISTRATOR, position: 100 },
  { id: 2, name: "admin", color: "#f00", permissions: Permission.MANAGE_ROLES, position: 80 },
  { id: 3, name: "moderator", color: null, permissions: 0, position: 50 },
  { id: 4, name: "member", color: "#0f0", permissions: 0, position: 10 },
  { id: 5, name: "helper", color: "#00f", permissions: 0, position: 20 },
];

function setViewer(id: number, role: string, roleIds?: number[]): void {
  authStore.setState((p) => ({
    ...p,
    user: {
      id,
      username: "me",
      avatar: null,
      role,
      ...(roleIds === undefined ? {} : { role_ids: roleIds }),
    } as never,
  }));
}

describe("assignableRoleNames", () => {
  beforeEach(() => setRoles(ROLES));

  it("falls back to the built-in names when the server sent no roles", () => {
    setRoles([]);
    expect(assignableRoleNames(80)).toEqual(["Admin", "Moderator", "Member"]);
  });

  it("lists the server's roles below the actor and never the owner", () => {
    expect(assignableRoleNames(80)).toEqual(["moderator", "member", "helper"]);
    expect(assignableRoleNames(50)).toEqual(["member", "helper"]);
  });

  it("offers every non-owner role when the actor's rank is unknown", () => {
    expect(assignableRoleNames(undefined)).toEqual(["admin", "moderator", "member", "helper"]);
  });

  it("keeps a role whose position the server did not send", () => {
    setRoles([{ id: 9, name: "legacy", color: null, permissions: 0 }, ...ROLES]);
    expect(assignableRoleNames(10)).toEqual(["legacy"]);
  });
});

describe("outranksPosition", () => {
  it("is true only when strictly higher, or when either side is unknown", () => {
    expect(outranksPosition(80, 50)).toBe(true);
    expect(outranksPosition(50, 50)).toBe(false);
    expect(outranksPosition(10, 50)).toBe(false);
    expect(outranksPosition(undefined, 50)).toBe(true);
    expect(outranksPosition(80, undefined)).toBe(true);
  });
});

describe("roleChangeChoices", () => {
  beforeEach(() => {
    setRoles(ROLES);
    setViewer(1, "admin");
  });

  it("offers the roles below the viewer for a lower-ranked member", () => {
    expect(roleChangeChoices(7, "member")).toEqual(["moderator", "member", "helper"]);
  });

  it("offers nothing without a signed-in user", () => {
    authStore.setState((p) => ({ ...p, user: null }));
    expect(roleChangeChoices(7, "member")).toBeNull();
  });

  it("offers nothing for the viewer's own account", () => {
    expect(roleChangeChoices(1, "member")).toBeNull();
  });

  it("offers nothing without MANAGE_ROLES", () => {
    setViewer(1, "moderator");
    expect(roleChangeChoices(7, "member")).toBeNull();
  });

  it("offers nothing for a member of equal or higher rank", () => {
    expect(roleChangeChoices(8, "admin")).toBeNull();
    expect(roleChangeChoices(8, "Owner")).toBeNull();
  });

  it("offers nothing when no role sits below the viewer", () => {
    setRoles([ROLES[1]!]);
    expect(roleChangeChoices(7, "ghost")).toBeNull();
  });
});

describe("memberRolesState", () => {
  beforeEach(() => {
    setRoles(ROLES);
    setViewer(1, "admin", [2]);
  });

  it("shows held roles highest first, each removable, and the rest addable", () => {
    const state = memberRolesState(7, "member", [4, 5]);
    expect(state.chips).toEqual([
      { id: 5, name: "helper", color: "#00f", removable: true },
      { id: 4, name: "member", color: "#0f0", removable: true },
    ]);
    expect(state.addable).toEqual([{ id: 3, name: "moderator" }]);
  });

  it("never offers the owner role, whatever its capitalisation, even to a higher viewer", () => {
    setRoles([
      ...ROLES,
      { id: 6, name: "boss", color: null, permissions: Permission.MANAGE_ROLES, position: 200 },
    ]);
    setViewer(1, "boss", [6]);
    const names = memberRolesState(7, "member", [4]).addable.map((r) => r.name);
    expect(names).toEqual(["admin", "moderator", "helper"]);
  });

  it("finds the single role by name, ignoring case, when no role ids are known", () => {
    const state = memberRolesState(7, "MEMBER", undefined);
    expect(state.chips).toEqual([{ id: 4, name: "member", color: "#0f0", removable: true }]);
  });

  it("falls back to the role name when none of the held ids is in the role list", () => {
    const state = memberRolesState(7, "Helper", [99]);
    expect(state.chips.map((c) => c.id)).toEqual([5]);
  });

  it("shows read-only chips and nothing addable without MANAGE_ROLES", () => {
    setViewer(1, "moderator", [3]);
    const state = memberRolesState(7, "member", [4]);
    expect(state.chips).toEqual([{ id: 4, name: "member", color: "#0f0", removable: false }]);
    expect(state.addable).toEqual([]);
  });

  it("shows read-only chips on the viewer's own card", () => {
    const state = memberRolesState(1, "admin", [2]);
    expect(state.chips.every((c) => !c.removable)).toBe(true);
    expect(state.addable).toEqual([]);
  });

  it("shows read-only chips on the viewer's own account even when it is shown with a lower role", () => {
    const state = memberRolesState(1, "member", [4]);
    expect(state.chips).toEqual([{ id: 4, name: "member", color: "#0f0", removable: false }]);
    expect(state.addable).toEqual([]);
  });

  it("shows read-only chips for a member of equal rank", () => {
    const state = memberRolesState(8, "admin", [2]);
    expect(state.chips).toEqual([{ id: 2, name: "admin", color: "#f00", removable: false }]);
    expect(state.addable).toEqual([]);
  });

  it("shows read-only chips when nobody is signed in", () => {
    authStore.setState((p) => ({ ...p, user: null }));
    const state = memberRolesState(7, "member", [4]);
    expect(state.chips.map((c) => c.removable)).toEqual([false]);
    expect(state.addable).toEqual([]);
  });
});

describe("role membership requests", () => {
  beforeEach(() => setRoles(ROLES));

  it("names the role being removed among several", async () => {
    const notify = vi.fn();
    const api = { adminAddMemberRole: vi.fn(), adminRemoveMemberRole: vi.fn(async () => {}) };
    await removeMemberRole({ api, notify }, 7, "user7", 4);
    expect(api.adminRemoveMemberRole).toHaveBeenCalledWith(7, 4);
    expect(notify).toHaveBeenCalledExactlyOnceWith("Removed member from user7", "success");
  });

  it("says so when the role to remove vanished from the roster", async () => {
    const notify = vi.fn();
    const api = { adminAddMemberRole: vi.fn(), adminRemoveMemberRole: vi.fn() };
    await removeMemberRole({ api, notify }, 7, "user7", 99);
    expect(api.adminRemoveMemberRole).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledExactlyOnceWith('Unknown role "99" — try reconnecting', "error");
  });

  it("toasts the failure of an add instead of rejecting", async () => {
    const notify = vi.fn();
    const api = {
      adminAddMemberRole: vi.fn(async () => {
        throw new Error("denied");
      }),
      adminRemoveMemberRole: vi.fn(),
    };
    await expect(addMemberRole({ api, notify }, 7, "user7", 3)).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledExactlyOnceWith("denied", "error");
  });
});

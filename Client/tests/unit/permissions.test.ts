import { describe, it, expect } from "vitest";
import {
  hasPermission,
  permissionsForRole,
  currentUserPermissions,
  isLegacyAdminRole,
  roleHasPermission,
  canManageChannels,
  canViewAuditLog,
} from "../../src/lib/permissions";
import { Permission } from "../../src/lib/types";
import { setRoles } from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";

// Default role permission values (from SCHEMA.md)
const OWNER_PERMS = 0x7fffffff;
const MODERATOR_PERMS = 0x000fffff;
const MEMBER_PERMS = 0x00000663;

describe("hasPermission", () => {
  it("member can SEND_MESSAGES", () => {
    expect(hasPermission(MEMBER_PERMS, Permission.SEND_MESSAGES)).toBe(true);
  });

  it("member cannot MANAGE_MESSAGES", () => {
    expect(hasPermission(MEMBER_PERMS, Permission.MANAGE_MESSAGES)).toBe(false);
  });

  it("ADMINISTRATOR bypass — admin with ADMINISTRATOR can do anything", () => {
    const permsWithAdmin = Permission.ADMINISTRATOR;
    expect(hasPermission(permsWithAdmin, Permission.MANAGE_MESSAGES)).toBe(true);
    expect(hasPermission(permsWithAdmin, Permission.BAN_MEMBERS)).toBe(true);
  });

  it("owner has all permissions", () => {
    expect(hasPermission(OWNER_PERMS, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(OWNER_PERMS, Permission.MANAGE_SERVER)).toBe(true);
    expect(hasPermission(OWNER_PERMS, Permission.VIEW_AUDIT_LOG)).toBe(true);
    expect(hasPermission(OWNER_PERMS, Permission.ADMINISTRATOR)).toBe(true);
  });
});

describe("edge cases", () => {
  it("hasPermission with zero perms returns false", () => {
    expect(hasPermission(0, Permission.SEND_MESSAGES)).toBe(false);
  });

  it("hasPermission checking ADMINISTRATOR bit directly", () => {
    expect(hasPermission(Permission.ADMINISTRATOR, Permission.ADMINISTRATOR)).toBe(true);
  });

  it("moderator has KICK_MEMBERS", () => {
    expect(hasPermission(MODERATOR_PERMS, Permission.KICK_MEMBERS)).toBe(true);
  });

  it("moderator does not have MANAGE_SERVER", () => {
    expect(hasPermission(MODERATOR_PERMS, Permission.MANAGE_SERVER)).toBe(false);
  });
});

describe("permissionsForRole", () => {
  it("resolves a role's mask case-insensitively from the ready role list", () => {
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: MODERATOR_PERMS }]);
    expect(permissionsForRole("moderator")).toBe(MODERATOR_PERMS);
    expect(permissionsForRole("MODERATOR")).toBe(MODERATOR_PERMS);
  });

  it("returns null for a role the server did not send, so callers can fall back", () => {
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: MODERATOR_PERMS }]);
    expect(permissionsForRole("owner")).toBeNull();
    setRoles([]);
    expect(permissionsForRole("moderator")).toBeNull();
  });

  it("distinguishes a zero-permission role from an unknown one", () => {
    setRoles([{ id: 9, name: "Muted", color: null, permissions: 0 }]);
    expect(permissionsForRole("muted")).toBe(0);
    expect(permissionsForRole("nope")).toBeNull();
  });

  it("currentUserPermissions denies by default when the role is unknown", () => {
    setRoles([]);
    authStore.setState(() => ({
      token: "tok",
      user: { id: 1, username: "A", avatar: null, role: "moderator" },
      serverName: "T",
      motd: null,
      isAuthenticated: true,
    }));
    expect(currentUserPermissions()).toBe(0);
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: MODERATOR_PERMS }]);
    expect(currentUserPermissions()).toBe(MODERATOR_PERMS);
  });

  it("currentUserPermissions denies without throwing when nobody is signed in or the role field is a malformed null", () => {
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: MODERATOR_PERMS }]);

    // No signed-in user at all: authStore.getState().user?.role is undefined.
    authStore.setState(() => ({
      token: null,
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));
    expect(currentUserPermissions()).toBe(0);

    // Server payload with a malformed null role (bypasses the `string` type at
    // runtime, same as untrusted JSON would): must still deny, not throw.
    authStore.setState(() => ({
      token: "tok",
      user: { id: 1, username: "A", avatar: null, role: null as unknown as string },
      serverName: "T",
      motd: null,
      isAuthenticated: true,
    }));
    expect(currentUserPermissions()).toBe(0);
  });
});

describe("roleHasPermission", () => {
  it("uses the server mask when the ready role list has the role", () => {
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: MODERATOR_PERMS }]);
    expect(roleHasPermission("moderator", Permission.KICK_MEMBERS)).toBe(true);
    expect(roleHasPermission("moderator", Permission.MANAGE_SERVER)).toBe(false);
  });

  it("lets the ADMINISTRATOR bit pass every permission", () => {
    setRoles([{ id: 1, name: "Owner", color: null, permissions: OWNER_PERMS }]);
    expect(roleHasPermission("owner", Permission.MUTE_MEMBERS)).toBe(true);
    expect(roleHasPermission("owner", Permission.MANAGE_SERVER)).toBe(true);
  });

  it("prefers the mask over the role name — a renamed 'admin' with no bits is denied", () => {
    setRoles([{ id: 7, name: "Admin", color: null, permissions: 0 }]);
    expect(roleHasPermission("admin", Permission.KICK_MEMBERS)).toBe(false);
  });

  it("falls back to the legacy owner/admin name check when the server sent no role list", () => {
    setRoles([]);
    expect(roleHasPermission("owner", Permission.MUTE_MEMBERS)).toBe(true);
    expect(roleHasPermission("admin", Permission.KICK_MEMBERS)).toBe(true);
    expect(roleHasPermission("moderator", Permission.MUTE_MEMBERS)).toBe(false);
    expect(roleHasPermission("member", Permission.KICK_MEMBERS)).toBe(false);
  });

  it("derives voice moderation and member-list gates identically", () => {
    // Regression: canModerateVoice used to deny on an unknown role while the
    // member list fell back to the legacy name check, so on a server that sent
    // no role list an admin kept kick/ban but silently lost the voice menu.
    setRoles([]);
    for (const role of ["owner", "admin", "moderator", "member"]) {
      expect(roleHasPermission(role, Permission.MUTE_MEMBERS)).toBe(
        roleHasPermission(role, Permission.KICK_MEMBERS),
      );
    }
  });
});

describe("isLegacyAdminRole", () => {
  it("matches owner and admin case-insensitively and nothing else", () => {
    expect(isLegacyAdminRole("Owner")).toBe(true);
    expect(isLegacyAdminRole("ADMIN")).toBe(true);
    expect(isLegacyAdminRole("moderator")).toBe(false);
    expect(isLegacyAdminRole("")).toBe(false);
  });
});

// ─── Channel management / audit-log gates ────────────────────────────────────
//
// Both are derived from the permission BIT, not from a role name: a custom role
// granted MANAGE_CHANNELS could edit channels through the API while the client
// hid the affordance, because the old check asked whether the role was called
// "owner" or "admin".

describe("canManageChannels / canViewAuditLog", () => {
  function signInAs(role: string): void {
    authStore.setState(() => ({
      token: "tok",
      user: { id: 1, username: "A", avatar: null, role },
      serverName: "T",
      motd: null,
      isAuthenticated: true,
    }));
  }

  it("grants channel management to a custom role holding the bit", () => {
    setRoles([{ id: 9, name: "Curator", color: null, permissions: Permission.MANAGE_CHANNELS }]);
    signInAs("Curator");
    expect(canManageChannels()).toBe(true);
  });

  it("denies channel management to a role without the bit", () => {
    setRoles([{ id: 4, name: "Member", color: null, permissions: MEMBER_PERMS }]);
    signInAs("Member");
    expect(canManageChannels()).toBe(false);
  });

  it("lets the ADMINISTRATOR bit pass channel management", () => {
    setRoles([{ id: 1, name: "Owner", color: null, permissions: OWNER_PERMS }]);
    signInAs("Owner");
    expect(canManageChannels()).toBe(true);
  });

  // Without a role list there is nothing to check the bit against; the legacy
  // name check stands in so channel management is not hidden from every actual
  // admin on an older server.
  it("falls back to the legacy owner/admin names with no role list", () => {
    setRoles([]);
    signInAs("admin");
    expect(canManageChannels()).toBe(true);
    signInAs("moderator");
    expect(canManageChannels()).toBe(false);
  });

  it("gates the audit-log entry on VIEW_AUDIT_LOG", () => {
    setRoles([
      { id: 3, name: "Moderator", color: null, permissions: Permission.VIEW_AUDIT_LOG },
      { id: 4, name: "Member", color: null, permissions: MEMBER_PERMS },
    ]);
    signInAs("Moderator");
    expect(canViewAuditLog()).toBe(true);
    signInAs("Member");
    expect(canViewAuditLog()).toBe(false);
  });

  // The two gates are independent: an auditor who may read the log need not be
  // able to edit channels, and vice versa.
  it("keeps the two gates independent", () => {
    setRoles([
      { id: 9, name: "Auditor", color: null, permissions: Permission.VIEW_AUDIT_LOG },
      { id: 10, name: "Curator", color: null, permissions: Permission.MANAGE_CHANNELS },
    ]);
    signInAs("Auditor");
    expect(canViewAuditLog()).toBe(true);
    expect(canManageChannels()).toBe(false);
    signInAs("Curator");
    expect(canViewAuditLog()).toBe(false);
    expect(canManageChannels()).toBe(true);
  });

  it("falls back to the exact empty string (not merely 'no match') when nobody is signed in", () => {
    // Pins the literal `?? ""` fallback: a role list that happens to include
    // an entry literally named "" must be reachable through the
    // no-signed-in-user path, proving the fallback really is "" and not some
    // other placeholder value.
    setRoles([
      {
        id: 20,
        name: "",
        color: null,
        permissions: Permission.MANAGE_CHANNELS | Permission.VIEW_AUDIT_LOG,
      },
    ]);
    authStore.setState(() => ({
      token: null,
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));
    expect(canManageChannels()).toBe(true);
    expect(canViewAuditLog()).toBe(true);
  });
});

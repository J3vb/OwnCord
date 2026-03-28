import { describe, it, expect } from 'vitest';
import {
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  computeEffective,
  isAdministrator,
} from '../../src/lib/permissions';
import { Permission } from '../../src/lib/types';

// Default role permission values (from SCHEMA.md)
const OWNER_PERMS = 0x7FFFFFFF;
const ADMIN_PERMS = 0x3FFFFFFF; // admin has bits 0-29 but NOT ADMINISTRATOR (bit 30)
const MODERATOR_PERMS = 0x000FFFFF;
const MEMBER_PERMS = 0x00000663;

describe('hasPermission', () => {
  it('member can SEND_MESSAGES', () => {
    expect(hasPermission(MEMBER_PERMS, Permission.SEND_MESSAGES)).toBe(true);
  });

  it('member cannot MANAGE_MESSAGES', () => {
    expect(hasPermission(MEMBER_PERMS, Permission.MANAGE_MESSAGES)).toBe(false);
  });

  it('ADMINISTRATOR bypass — admin with ADMINISTRATOR can do anything', () => {
    const permsWithAdmin = Permission.ADMINISTRATOR;
    expect(hasPermission(permsWithAdmin, Permission.MANAGE_MESSAGES)).toBe(true);
    expect(hasPermission(permsWithAdmin, Permission.BAN_MEMBERS)).toBe(true);
  });

  it('owner has all permissions', () => {
    expect(hasPermission(OWNER_PERMS, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(OWNER_PERMS, Permission.MANAGE_SERVER)).toBe(true);
    expect(hasPermission(OWNER_PERMS, Permission.VIEW_AUDIT_LOG)).toBe(true);
    expect(hasPermission(OWNER_PERMS, Permission.ADMINISTRATOR)).toBe(true);
  });
});

describe('hasAnyPermission', () => {
  it('returns true if any match', () => {
    expect(
      hasAnyPermission(
        MEMBER_PERMS,
        Permission.SEND_MESSAGES,
        Permission.MANAGE_MESSAGES,
      ),
    ).toBe(true);
  });

  it('returns false if none match', () => {
    expect(
      hasAnyPermission(
        MEMBER_PERMS,
        Permission.MANAGE_MESSAGES,
        Permission.BAN_MEMBERS,
      ),
    ).toBe(false);
  });
});

describe('hasAllPermissions', () => {
  it('returns true when all match', () => {
    expect(
      hasAllPermissions(
        MEMBER_PERMS,
        Permission.SEND_MESSAGES,
        Permission.READ_MESSAGES,
      ),
    ).toBe(true);
  });

  it('returns false when one missing', () => {
    expect(
      hasAllPermissions(
        MEMBER_PERMS,
        Permission.SEND_MESSAGES,
        Permission.MANAGE_MESSAGES,
      ),
    ).toBe(false);
  });
});

describe('computeEffective', () => {
  it('allow overrides deny (allow-wins, matches server semantics)', () => {
    const base = MEMBER_PERMS;
    const allow = Permission.MANAGE_MESSAGES;
    const deny = Permission.MANAGE_MESSAGES;
    const effective = computeEffective(base, allow, deny);
    expect(effective & Permission.MANAGE_MESSAGES).toBe(Permission.MANAGE_MESSAGES);
  });

  it('ADMINISTRATOR ignores deny and returns all bits', () => {
    // Must use a perm set that actually includes bit 30 (ADMINISTRATOR)
    const base = OWNER_PERMS; // 0x7FFFFFFF includes ADMINISTRATOR
    const deny = Permission.SEND_MESSAGES | Permission.MANAGE_SERVER;
    const effective = computeEffective(base, 0, deny);
    expect(effective).toBe(0x7FFFFFFF);
  });

  it('non-ADMINISTRATOR admin is affected by deny', () => {
    // ADMIN_PERMS (0x3FFFFFFF) does NOT have ADMINISTRATOR bit
    const deny = Permission.SEND_MESSAGES;
    const effective = computeEffective(ADMIN_PERMS, 0, deny);
    expect(effective & Permission.SEND_MESSAGES).toBe(0);
  });

  it('allow adds bits to base', () => {
    const base = MEMBER_PERMS;
    const allow = Permission.MANAGE_MESSAGES;
    const effective = computeEffective(base, allow, 0);
    expect(effective & Permission.MANAGE_MESSAGES).toBe(Permission.MANAGE_MESSAGES);
    // original bits are preserved
    expect(effective & Permission.SEND_MESSAGES).toBe(Permission.SEND_MESSAGES);
  });
});

describe('isAdministrator', () => {
  it('true for owner with ADMINISTRATOR bit', () => {
    expect(isAdministrator(OWNER_PERMS)).toBe(true);
  });

  it('false for admin without ADMINISTRATOR bit', () => {
    // ADMIN_PERMS (0x3FFFFFFF) has bits 0-29 but NOT bit 30
    expect(isAdministrator(ADMIN_PERMS)).toBe(false);
  });

  it('false for member', () => {
    expect(isAdministrator(MEMBER_PERMS)).toBe(false);
  });
});

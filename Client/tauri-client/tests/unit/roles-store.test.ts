import { describe, it, expect, beforeEach } from "vitest";
import { rolesStore, setRoles, getRoleIdByName } from "../../src/stores/roles.store";
import type { ReadyRole } from "../../src/lib/types";

/**
 * Tests for src/stores/roles.store.ts — role definitions store.
 * Covers initial state, setRoles bulk update, and getRoleIdByName lookup
 * with case-insensitive matching, missing roles, and empty state.
 */

const SAMPLE_ROLES: readonly ReadyRole[] = [
  { id: 1, name: "admin", color: "#ff0000", permissions: 0xff },
  { id: 2, name: "moderator", color: "#00ff00", permissions: 0x0f },
  { id: 3, name: "member", color: null, permissions: 0x01 },
];

describe("roles.store", () => {
  beforeEach(() => {
    // Reset to empty state before each test
    rolesStore.setState(() => ({ roles: [] }));
  });

  // ── initial state ────────────────────────────────────────

  describe("initial state", () => {
    it("starts with an empty roles array", () => {
      expect(rolesStore.getState().roles).toEqual([]);
    });
  });

  // ── setRoles ─────────────────────────────────────────────

  describe("setRoles", () => {
    it("bulk sets roles from a ready payload", () => {
      setRoles(SAMPLE_ROLES);
      expect(rolesStore.getState().roles).toEqual(SAMPLE_ROLES);
    });

    it("replaces existing roles entirely", () => {
      setRoles(SAMPLE_ROLES);

      const newRoles: readonly ReadyRole[] = [
        { id: 10, name: "owner", color: "#gold", permissions: 0xffff },
      ];
      setRoles(newRoles);

      expect(rolesStore.getState().roles).toEqual(newRoles);
      expect(rolesStore.getState().roles.length).toBe(1);
    });

    it("can set roles to an empty array", () => {
      setRoles(SAMPLE_ROLES);
      setRoles([]);
      expect(rolesStore.getState().roles).toEqual([]);
    });

    it("stores the exact references passed in", () => {
      setRoles(SAMPLE_ROLES);
      expect(rolesStore.getState().roles).toBe(SAMPLE_ROLES);
    });
  });

  // ── getRoleIdByName ──────────────────────────────────────

  describe("getRoleIdByName", () => {
    beforeEach(() => {
      setRoles(SAMPLE_ROLES);
    });

    it("returns the role ID for an exact name match", () => {
      expect(getRoleIdByName("admin")).toBe(1);
    });

    it("returns the role ID for a case-insensitive match (uppercase)", () => {
      expect(getRoleIdByName("ADMIN")).toBe(1);
    });

    it("returns the role ID for a case-insensitive match (mixed case)", () => {
      expect(getRoleIdByName("Moderator")).toBe(2);
    });

    it("returns the role ID for a case-insensitive match (lowercase stored, lowercase query)", () => {
      expect(getRoleIdByName("member")).toBe(3);
    });

    it("returns undefined for a role name that does not exist", () => {
      expect(getRoleIdByName("nonexistent")).toBeUndefined();
    });

    it("returns undefined when the store is empty", () => {
      setRoles([]);
      expect(getRoleIdByName("admin")).toBeUndefined();
    });

    it("returns undefined for an empty string", () => {
      expect(getRoleIdByName("")).toBeUndefined();
    });

    it("returns the first matching role when duplicates exist", () => {
      const dupes: readonly ReadyRole[] = [
        { id: 100, name: "DupeRole", color: null, permissions: 0 },
        { id: 200, name: "duperole", color: null, permissions: 0 },
      ];
      setRoles(dupes);
      // Should return the first match (id 100)
      expect(getRoleIdByName("duperole")).toBe(100);
    });
  });
});

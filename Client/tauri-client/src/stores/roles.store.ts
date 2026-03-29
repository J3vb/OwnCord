/**
 * Roles store — holds server-wide role definitions.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type { ReadyRole } from "@lib/types";

export interface RolesState {
  readonly roles: readonly ReadyRole[];
}

const INITIAL_STATE: RolesState = {
  roles: [],
};

export const rolesStore = createStore<RolesState>(INITIAL_STATE);

/** Bulk set roles from the ready payload. */
export function setRoles(roles: readonly ReadyRole[]): void {
  rolesStore.setState(() => ({ roles }));
}

/** Look up a role ID by name (case-insensitive). Returns undefined if not found. */
export function getRoleIdByName(name: string): number | undefined {
  const roles = rolesStore.getState().roles;
  const match = roles.find((r) => r.name.toLowerCase() === name.toLowerCase());
  return match?.id;
}

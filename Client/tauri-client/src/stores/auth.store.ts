/**
 * Auth store — holds authentication state after login/auth_ok.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type { UserWithRole } from "@lib/types";

export interface AuthState {
  readonly token: string | null;
  readonly user: UserWithRole | null;
  readonly serverName: string | null;
  readonly motd: string | null;
  readonly isAuthenticated: boolean;
}

const INITIAL_STATE: AuthState = {
  token: null,
  user: null,
  serverName: null,
  motd: null,
  isAuthenticated: false,
};

export const authStore = createStore<AuthState>(INITIAL_STATE);

/** Populate auth state after a successful auth_ok message. */
export function setAuth(
  token: string,
  user: UserWithRole,
  serverName: string,
  motd: string,
): void {
  authStore.setState(() => ({
    token,
    user,
    serverName,
    motd,
    isAuthenticated: true,
  }));
}

/** Reset auth state (logout / disconnect). */
export function clearAuth(): void {
  authStore.setState(() => ({ ...INITIAL_STATE }));
}

/** Shorthand selector for the current token. */
export function getToken(): string | null {
  return authStore.select((s) => s.token);
}

/** Update the current user fields (e.g. after profile edit). */
export function updateUser(patch: Partial<UserWithRole>): void {
  authStore.setState((prev) => ({
    ...prev,
    user: prev.user ? { ...prev.user, ...patch } : prev.user,
  }));
}

/** Shorthand selector for the current user. */
export function getCurrentUser(): UserWithRole | null {
  return authStore.select((s) => s.user);
}

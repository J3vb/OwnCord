/**
 * Auth store — holds authentication state after login/auth_ok.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type { UserWithRole } from "@lib/types";
import { resetVoiceStore } from "@stores/voice.store";
import { cleanupNotificationAudio } from "@lib/notifications";

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
export function setAuth(token: string, user: UserWithRole, serverName: string, motd: string): void {
  authStore.setState(() => ({
    token,
    user,
    serverName,
    motd,
    isAuthenticated: true,
  }));
}

/** Reset auth state (logout / disconnect). Also cleans up the voice
 *  session (WebRTC, AudioContext, streams) and clears voice store state.
 *  Safe to call even if no voice session is active — leaveVoice is idempotent. */
export function clearAuth(): void {
  // livekitSession (and the ~1.3 MB livekit-client SDK behind it) is loaded
  // lazily so it stays out of the startup path. When a voice session exists
  // the module is necessarily already loaded, so this import resolves from
  // the module cache in a microtask.
  void import("@lib/livekitSession").then(({ leaveVoice }) => leaveVoice(false));
  resetVoiceStore();
  cleanupNotificationAudio();
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

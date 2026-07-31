/**
 * Auth store — holds authentication state after login/auth_ok.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type { UserWithRole } from "@lib/types";
import { resetVoiceStore, voiceStore } from "@stores/voice.store";
import { cleanupNotificationAudio } from "@lib/notifications";
import { createLogger } from "@lib/logger";

const log = createLogger("auth.store");

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
  // lazily so it stays out of the startup path. Only import it when there is
  // actually a voice session to leave — otherwise a text-only user who never
  // joined voice would pull in the whole LiveKit SDK on every logout/401.
  // When a voice session exists the module is necessarily already loaded, so
  // this import resolves from the module cache in a microtask.
  const voice = voiceStore.getState();
  if (voice.currentChannelId !== null && voice.voiceStatus !== "idle") {
    void import("@lib/livekitSession")
      .then(({ leaveVoice }) => leaveVoice(false))
      .catch((e) => log.warn("Failed to leave voice session during clearAuth", e));
  }
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

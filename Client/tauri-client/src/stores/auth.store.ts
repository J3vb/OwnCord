/**
 * Auth store — holds authentication state after login/auth_ok.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type { UserWithRole } from "@lib/types";
import { resetVoiceStore, voiceStore } from "@stores/voice.store";
import { resetMessagesStore } from "@stores/messages.store";
import { resetChannelsStore } from "@stores/channels.store";
import { cleanupNotificationAudio } from "@lib/notifications";
import { clearNsfwAcknowledgements } from "@lib/nsfw-gate";
import { createLogger } from "@lib/logger";

const log = createLogger("auth.store");

/** Why the session ended. "user" covers every locally-initiated or
 *  invalid-token path (logout, 401, auth_error, ban); "server_shutdown" is a
 *  server-initiated kick whose token is still valid — the logout wiring keeps
 *  the saved credential in that case so auto-login works when the server
 *  comes back. */
export type LogoutReason = "user" | "server_shutdown";

export interface AuthState {
  readonly token: string | null;
  readonly user: UserWithRole | null;
  readonly serverName: string | null;
  readonly motd: string | null;
  readonly isAuthenticated: boolean;
  /** Set by clearAuth; cleared again on the next setAuth. Optional so the
   *  many inline AuthState test fixtures need not restate it. */
  readonly logoutReason?: LogoutReason | null;
  /**
   * Snapshot of "was the user in a voice channel", taken by clearAuth before
   * it resets voiceStore. clearAuth applies state synchronously but store
   * notifications are microtask-deferred, so a subscriber reacting to
   * isAuthenticated flipping false always sees voiceStore already reset —
   * this is what such a subscriber must gate a voice_leave send on instead.
   */
  readonly logoutWasInVoice?: boolean;
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
 *  session (WebRTC, AudioContext, streams) and clears voice store state —
 *  including camera/screenshare, whose tracks leaveVoice stops and whose
 *  toggles it resets. Safe to call even if no voice session is active —
 *  leaveVoice is idempotent. Also clears messagesStore: otherwise a channel
 *  id that also exists on the next-signed-into server (channel ids are only
 *  unique per-server) would short-circuit its refetch and render the
 *  previous session's messages, and same-account relogin would leave a
 *  permanent hole for messages posted while logged out. Also clears
 *  channelsStore: setChannels' DM-row carry otherwise re-inserts the
 *  previous server's DM channel rows into the next server's channel map. */
export function clearAuth(reason: LogoutReason = "user"): void {
  // livekitSession (and the ~1.3 MB livekit-client SDK behind it) is loaded
  // lazily so it stays out of the startup path. Only import it when there is
  // actually a voice session to leave — otherwise a text-only user who never
  // joined voice would pull in the whole LiveKit SDK on every logout/401.
  // When a voice session exists the module is necessarily already loaded, so
  // this import resolves from the module cache in a microtask.
  const voice = voiceStore.getState();
  // Snapshot BEFORE resetVoiceStore() below clears it — this is the last
  // moment the pre-logout voice state is knowable.
  const wasInVoice = voice.currentChannelId !== null;
  if (voice.currentChannelId !== null && voice.voiceStatus !== "idle") {
    void import("@lib/livekitSession")
      .then(({ leaveVoice }) => leaveVoice(false))
      .catch((e) => log.warn("Failed to leave voice session during clearAuth", e));
  }
  resetVoiceStore();
  resetMessagesStore();
  resetChannelsStore();
  // NSFW acknowledgements are per-viewer consent, not per-device: without this
  // the next account signed into the same server inherits the previous user's
  // acks and the age gate silently never appears for them. Host-scoping the
  // keys cannot cover that case — only clearing on logout can.
  clearNsfwAcknowledgements();
  cleanupNotificationAudio();
  authStore.setState(() => ({
    ...INITIAL_STATE,
    logoutReason: reason,
    logoutWasInVoice: wasInVoice,
  }));
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

/**
 * Credential storage — the app-side half of the OS credential manager.
 * The native calls live behind `platform/desktop` (B7-4); these exports stay
 * where their callers already import them.
 */

import { ApiClientError } from "./api";
import { desktop } from "../platform/desktop";
import type { SavedCredential, SavedLoginResponse } from "../platform/contracts/credentials";
import type { AuthResponse } from "./types";
import { authStore } from "@stores/auth.store";
import { connectText } from "../i18n/connect";

export type { SavedCredential, SavedLoginResponse };

/** Save a credential to the OS credential store for `host`. */
export async function saveCredential(
  host: string,
  username: string,
  token: string,
  password?: string,
  clearPassword = false,
): Promise<boolean> {
  return desktop.credentials.save(host, username, token, password, clearPassword);
}

/**
 * Build a `user_update` listener that refreshes a session's stored
 * credential when the local user's own profile changes (a username edit, or
 * the identity-key PATCH) — mirroring the initial saveCredential call's
 * remember-password opt-out (BUG-135) so a later profile edit can't silently
 * persist a bearer token the user declined to store.
 *
 * It takes no password: `save_credential` preserves the stored one when none
 * is supplied. This used to carry the session's plaintext password purely so
 * that omitting it would not wipe the saved one — the reason the password was
 * returned over IPC at all.
 */
export function createUserUpdateCredentialSaver(
  host: string,
  rememberPassword: boolean,
): (payload: { readonly user_id: number; readonly username: string }) => void {
  return (payload) => {
    if (!rememberPassword) return;
    const currentUserId = authStore.getState().user?.id ?? 0;
    if (payload.user_id !== currentUserId) return;
    const currentToken = authStore.getState().token;
    if (!currentToken) return;
    void saveCredential(host, payload.username, currentToken);
  };
}

/**
 * Turn the backend's relayed `/auth/login` response into the same
 * `AuthResponse` an ordinary `api.login` call produces.
 *
 * Rust returns status and raw body without interpreting either, so this is the
 * single place the login contract is read for the saved-password path — it
 * mirrors `api.ts`'s `parseError` + `ApiClientError` so a caller can narrow on
 * `.status` / `.code` exactly as it can for a typed password.
 *
 * Throws `ApiClientError` for a non-2xx response. Throws a plain `Error` for a
 * 2xx whose body does not parse: returning an empty object there would leave
 * both the token and the 2FA branch unentered and strand the caller with no
 * result and no error.
 */
export function parseRelayedLogin(relayed: SavedLoginResponse): AuthResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(relayed.body) as unknown;
  } catch {
    parsed = null;
  }
  const body =
    parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;

  if (relayed.status < 200 || relayed.status >= 300) {
    const code = typeof body?.error === "string" ? body.error : "UNKNOWN";
    const message =
      typeof body?.message === "string"
        ? body.message
        : connectText("session.loginFailedStatus", { status: relayed.status });
    throw new ApiClientError(relayed.status, code, message);
  }

  if (body === null) {
    throw new Error(connectText("session.loginUnreadable"));
  }
  return body as unknown as AuthResponse;
}

/** Log in to `host` using the password saved in the OS credential store. */
export async function loginWithSavedPassword(
  host: string,
  username: string,
): Promise<SavedLoginResponse | null> {
  return desktop.credentials.loginWithSavedPassword(host, username);
}

/** Load the credential stored for `host`, or null when there is none. */
export async function loadCredential(host: string): Promise<SavedCredential | null> {
  return desktop.credentials.load(host);
}

/** Delete the credential stored for `host`. */
export async function deleteCredential(host: string): Promise<boolean> {
  return desktop.credentials.delete(host);
}

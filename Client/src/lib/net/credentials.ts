/**
 * Credential storage — the app-side half of the OS credential manager.
 * The native calls live behind `platform/desktop`; these exports stay
 * where their callers already import them.
 */

import { TransportError, httpError } from "../api";
import { desktop } from "../../platform/desktop";
import type {
  SavedCredential,
  SavedLoginResponse,
  SavedSessionResume,
} from "../../platform/contracts/credentials";
import type { AuthResponse } from "../types";
import { readReply } from "../apiReply";
import { authStore } from "@stores/auth.store";
import { connectText } from "../../i18n/connect";

export type { SavedCredential, SavedLoginResponse, SavedSessionResume };

/** Save a credential to the OS credential store for `host`. */
export async function saveCredential(
  host: string,
  username: string,
  token: string,
  password?: string,
  clearPassword = false,
  sessionOnly?: boolean,
): Promise<boolean> {
  return desktop.credentials.save(host, username, token, password, clearPassword, sessionOnly);
}

/**
 * Build a `user_update` listener that refreshes a session's stored
 * credential when the local user's own profile changes (a username edit, or
 * the identity-key PATCH) — mirroring the initial saveCredential call's
 * remember-password opt-out so a later profile edit can't silently
 * persist a bearer token the user declined to store.
 *
 * It takes no password: `save_credential` preserves the stored one when none
 * is supplied. This used to carry the session's plaintext password purely so
 * that omitting it would not wipe the saved one — the reason the password was
 * returned over IPC at all.
 *
 * `onSaveFailed` (the web portal only) runs when the re-save answers false: a
 * browser save that moves the token can drop the old copy and still fail, which
 * leaves the user with no stored sign-in, so the caller must say so.
 */
export function createUserUpdateCredentialSaver(
  host: string,
  rememberPassword: boolean,
  onSaveFailed?: () => void,
): (payload: { readonly user_id: number; readonly username: string }) => void {
  return (payload) => {
    if (!rememberPassword) return;
    const currentUserId = authStore.getState().user?.id ?? 0;
    if (payload.user_id !== currentUserId) return;
    const currentToken = authStore.getState().token;
    if (!currentToken) return;
    const saved = saveCredential(host, payload.username, currentToken);
    if (__OWNCORD_WEB__ && onSaveFailed !== undefined) {
      void saved.then(
        (ok) => {
          if (!ok) onSaveFailed();
        },
        () => onSaveFailed(),
      );
    }
  };
}

/**
 * Turn the backend's relayed `/auth/login` response into its decoded body;
 * `readRelayedLogin` then checks it is the `AuthResponse` an ordinary
 * `api.login` call produces.
 *
 * Rust returns status and raw body without interpreting either, so this is the
 * single place the login contract is read for the saved-password path — it
 * mirrors `api.ts`'s `parseError` + `httpError` so a caller can narrow on
 * `.status` / `.code` exactly as it can for a typed password.
 *
 * Throws `httpError`'s error for a non-2xx response: an `ApiClientError` (which
 * carries the certificate code when the tunnel refused the certificate), or a
 * `TransportError` for a code-less 502. Throws a plain `Error` for a
 * 2xx whose body does not parse: returning an empty object there would leave
 * both the token and the 2FA branch unentered and strand the caller with no
 * result and no error.
 */
export function parseRelayedLogin(relayed: SavedLoginResponse): Readonly<Record<string, unknown>> {
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
    throw httpError(relayed.status, code, message);
  }

  if (body === null) {
    throw new Error(connectText("session.loginUnreadable"));
  }
  return body;
}

/** `parseRelayedLogin`, then the same reply check `api.login` runs on its body. */
export async function readRelayedLogin(relayed: SavedLoginResponse): Promise<AuthResponse> {
  return readReply("AuthResponse", parseRelayedLogin(relayed), {
    method: "POST",
    path: "/auth/login",
    status: relayed.status,
  });
}

/**
 * Log in to `host` using the password saved in the OS credential store. The
 * backend's own connect, read, write, timeout and malformed-response failures
 * (all "saved-password login…") reject as a `TransportError`; any other reason
 * (no saved password, a locked keychain) rejects unchanged.
 */
export async function loginWithSavedPassword(
  host: string,
  username: string,
): Promise<SavedLoginResponse | null> {
  try {
    return await desktop.credentials.loginWithSavedPassword(host, username);
  } catch (err) {
    throw asTransportFailure(err, "saved-password login");
  }
}

/** A backend failure whose reason starts with `prefix` as a `TransportError`; any other as it is. */
function asTransportFailure(err: unknown, prefix: string): unknown {
  return err instanceof Error && err.message.startsWith(prefix)
    ? new TransportError(err.message, { cause: err })
    : err;
}

/**
 * What the connect page prefills for `host` (the saved username and whether a
 * password is stored), or null when nothing is stored. No secret comes back.
 */
export async function loadCredential(host: string): Promise<SavedCredential | null> {
  return desktop.credentials.load(host);
}

/**
 * Resume the saved session for `host`, or null when nothing is stored. For a
 * saved server not signed in to yet during this app run, the backend asks that
 * server first and answers `sign_in_needed` when it refuses the stored token.
 * A server that could not be asked (every "saved sign-in check…" reason)
 * rejects as a `TransportError`; any other reason (an unreadable store)
 * rejects unchanged.
 */
export async function resumeSavedSession(host: string): Promise<SavedSessionResume | null> {
  try {
    return await desktop.credentials.resume(host);
  } catch (err) {
    throw asTransportFailure(err, "saved sign-in check");
  }
}

/** Delete the credential stored for `host`. */
export async function deleteCredential(host: string, token?: string): Promise<boolean> {
  return __OWNCORD_WEB__
    ? desktop.credentials.delete(host, token)
    : desktop.credentials.delete(host);
}

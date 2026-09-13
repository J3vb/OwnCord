/**
 * Credential storage — wraps Tauri IPC commands for Windows Credential Manager.
 * Falls back to no-op in non-Tauri environments (tests, browser).
 */

import { createLogger } from "./logger";
import { ApiClientError } from "./api";
import type { AuthResponse } from "./types";
import { authStore } from "@stores/auth.store";

const log = createLogger("credentials");

export interface SavedCredential {
  readonly username: string;
  readonly token: string;
  /** Whether a password is saved for this host. The plaintext itself never
   *  crosses IPC — `loginWithSavedPassword` uses it inside the Rust backend. */
  readonly hasPassword: boolean;
}

/** Raw relay of the server's /auth/login response from the Rust backend. */
export interface SavedLoginResponse {
  readonly status: number;
  readonly body: string;
}

/** Dynamically import Tauri invoke to avoid errors in test/browser. */
async function getInvoke(): Promise<
  ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null
> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke;
  } catch {
    return null;
  }
}

/**
 * Save a credential to Windows Credential Manager.
 * Target: OwnCord/{host}
 */
export async function saveCredential(
  host: string,
  username: string,
  token: string,
  password?: string,
  clearPassword = false,
): Promise<boolean> {
  const invoke = await getInvoke();
  if (!invoke) {
    log.warn("Tauri not available — credential not saved");
    return false;
  }
  try {
    // Omitting `password` PRESERVES whatever is stored; only `clearPassword`
    // erases it. Before that distinction existed, every re-save had to carry
    // the plaintext back through IPC just to avoid wiping it.
    await invoke("save_credential", {
      host,
      username,
      token,
      password: password ?? null,
      clearPassword,
    });
    return true;
  } catch (err) {
    log.error("Failed to save credential", { host, error: String(err) });
    return false;
  }
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
      typeof body?.message === "string" ? body.message : `Login failed (${relayed.status})`;
    throw new ApiClientError(relayed.status, code, message);
  }

  if (body === null) {
    throw new Error("Login failed: the server returned an unreadable response.");
  }
  return body as unknown as AuthResponse;
}

/**
 * Log in to `host` using the password saved in the OS credential store.
 *
 * The plaintext never reaches JavaScript: the Rust backend reads it, performs
 * the login through the same pinned loopback proxy a normal `fetch` would use,
 * and returns the server's raw status and body. Parse the body exactly as an
 * `api.login` response — the 2FA union and every error shape are relayed
 * untouched, so there is no second copy of the login contract.
 *
 * Returns null when Tauri is unavailable or the command resolves with an
 * unexpected shape. Any other failure — no password saved, a connect
 * failure, a timeout, a malformed response, etc. — rejects with an `Error`
 * carrying the backend's reason, so the caller can show it.
 */
export async function loginWithSavedPassword(
  host: string,
  username: string,
): Promise<SavedLoginResponse | null> {
  const invoke = await getInvoke();
  if (!invoke) return null;
  try {
    const result = await invoke("login_with_saved_password", { host, username });
    if (result && typeof result === "object") {
      const res = result as Record<string, unknown>;
      if (typeof res.status === "number" && typeof res.body === "string") {
        return { status: res.status, body: res.body };
      }
    }
    log.error("login_with_saved_password returned an unexpected shape", { host });
    return null;
  } catch (err) {
    log.error("Saved-password login failed", { host, error: String(err) });
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Load a credential from Windows Credential Manager.
 *
 * Returns null when nothing is stored for `host` or Tauri is unavailable.
 * Any other failure — the store can't be read, the OS keychain is locked,
 * etc. — rejects with an `Error` carrying the backend's reason instead of
 * being swallowed into `null`: the Rust side distinguishes "no credential"
 * from "couldn't read the credential store", and collapsing that here would
 * let callers (e.g. the remember-password opt-out) silently treat a read
 * failure as "nothing to delete".
 */
export async function loadCredential(host: string): Promise<SavedCredential | null> {
  const invoke = await getInvoke();
  if (!invoke) {
    return null;
  }
  try {
    const result = await invoke("load_credential", { host });
    if (result && typeof result === "object") {
      const cred = result as Record<string, unknown>;
      if (typeof cred.username === "string" && typeof cred.token === "string") {
        return {
          username: cred.username,
          token: cred.token,
          hasPassword: cred.has_password === true,
        };
      }
    }
    return null;
  } catch (err) {
    log.error("Failed to load credential", { host, error: String(err) });
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Delete a credential from Windows Credential Manager.
 */
export async function deleteCredential(host: string): Promise<boolean> {
  const invoke = await getInvoke();
  if (!invoke) {
    return false;
  }
  try {
    await invoke("delete_credential", { host });
    return true;
  } catch (err) {
    log.error("Failed to delete credential", { host, error: String(err) });
    return false;
  }
}

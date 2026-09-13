/**
 * Credential storage — wraps Tauri IPC commands for Windows Credential Manager.
 * Falls back to no-op in non-Tauri environments (tests, browser).
 */

import { createLogger } from "./logger";
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
 * Log in to `host` using the password saved in the OS credential store.
 *
 * The plaintext never reaches JavaScript: the Rust backend reads it, performs
 * the login through the same pinned loopback proxy a normal `fetch` would use,
 * and returns the server's raw status and body. Parse the body exactly as an
 * `api.login` response — the 2FA union and every error shape are relayed
 * untouched, so there is no second copy of the login contract.
 *
 * Returns null when Tauri is unavailable or no password is saved.
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
    return null;
  }
}

/**
 * Load a credential from Windows Credential Manager.
 * Returns null if not found or Tauri unavailable.
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
    return null;
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

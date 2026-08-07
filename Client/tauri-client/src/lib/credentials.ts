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
  // Note: password is no longer returned from the Rust backend over IPC
  // to limit credential exposure in the JS heap.
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
): Promise<boolean> {
  const invoke = await getInvoke();
  if (!invoke) {
    log.warn("Tauri not available — credential not saved");
    return false;
  }
  try {
    await invoke("save_credential", { host, username, token, password: password ?? null });
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
 * persist a bearer token the user declined to store. Passes the session's
 * password through on every call: save_credential replaces the whole stored
 * blob, so omitting it (defaulting to null) would wipe out the password
 * saved at login for a user who DID opt in.
 */
export function createUserUpdateCredentialSaver(
  host: string,
  rememberPassword: boolean,
  password: string | undefined,
): (payload: { readonly user_id: number; readonly username: string }) => void {
  return (payload) => {
    if (!rememberPassword) return;
    const currentUserId = authStore.getState().user?.id ?? 0;
    if (payload.user_id !== currentUserId) return;
    const currentToken = authStore.getState().token;
    if (!currentToken) return;
    void saveCredential(host, payload.username, currentToken, password);
  };
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

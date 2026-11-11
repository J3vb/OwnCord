/**
 * Desktop credential storage: the native surface behind the `CredentialStore`
 * contract — Windows Credential Manager / GNOME Keyring / macOS Keychain,
 * through the verified encrypted store.
 *
 * Lifted verbatim from `lib/net/credentials.ts`: same commands, same
 * arguments, same error handling, same log lines. A behavioural improvement
 * to credential handling is not this milestone's business.
 */
import { createLogger } from "@lib/logger";
import type { CredentialStore, SavedSessionResume } from "../contracts/credentials";

const log = createLogger("credentials");

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

/** The backend's tagged answer as the contract's union, or null when it is not one. */
function parseResume(result: unknown): SavedSessionResume | null {
  if (result === null || typeof result !== "object") return null;
  const res = result as Record<string, unknown>;
  if (
    res.outcome === "sign_in_needed" ||
    res.outcome === "certificate_unverified" ||
    res.outcome === "refused"
  ) {
    return { outcome: res.outcome };
  }
  if (
    res.outcome === "resumed" &&
    typeof res.username === "string" &&
    typeof res.token === "string"
  ) {
    return { outcome: "resumed", username: res.username, token: res.token };
  }
  return null;
}

export const credentials: CredentialStore = {
  /**
   * Save a credential to Windows Credential Manager.
   * Target: OwnCord/{host}
   */
  async save(host, username, token, password, clearPassword = false): Promise<boolean> {
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
  },

  /**
   * Load what the connect page prefills from Windows Credential Manager: the
   * saved username and whether a password is stored. The backend returns
   * neither secret here.
   *
   * Returns null when nothing is stored for `host` or Tauri is unavailable.
   * Any other failure — the store can't be read, the OS keychain is locked,
   * etc. — rejects with an `Error` carrying the backend's reason instead of
   * being swallowed into `null`: the Rust side distinguishes "no credential"
   * from "couldn't read the credential store", and collapsing that here would
   * let callers (e.g. the remember-password opt-out) silently treat a read
   * failure as "nothing to delete".
   */
  async load(host) {
    const invoke = await getInvoke();
    if (!invoke) {
      return null;
    }
    try {
      const result = await invoke("load_credential", { host });
      if (result && typeof result === "object") {
        const cred = result as Record<string, unknown>;
        if (typeof cred.username === "string") {
          return { username: cred.username, hasPassword: cred.has_password === true };
        }
      }
      return null;
    } catch (err) {
      log.error("Failed to load credential", { host, error: String(err) });
      throw err instanceof Error ? err : new Error(String(err));
    }
  },

  /**
   * Resume the saved session for `host`. The backend decides whether the stored
   * token may be used as it is or has to be accepted by the host's own server
   * first; either way a token arrives here only once it may be used.
   *
   * Returns null when nothing is stored, Tauri is unavailable, or the command
   * resolves with an unexpected shape. Any other failure rejects with an
   * `Error` carrying the backend's reason.
   */
  async resume(host) {
    const invoke = await getInvoke();
    if (!invoke) return null;
    try {
      return parseResume(await invoke("resume_saved_session", { host }));
    } catch (err) {
      log.error("Failed to resume the saved session", { host, error: String(err) });
      throw err instanceof Error ? err : new Error(String(err));
    }
  },

  /** Delete a credential from Windows Credential Manager. */
  async delete(host): Promise<boolean> {
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
  },

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
  async loginWithSavedPassword(host, username) {
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
  },
};

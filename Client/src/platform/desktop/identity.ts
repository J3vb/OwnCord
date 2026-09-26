/**
 * Desktop identity-key storage: the native surface behind the `IdentityStore`
 * contract. Two backing stores, unchanged from `lib/identity.ts`:
 *
 *   - OS keyring  (save/load/delete_identity_key, account `identity:{userId}@{host}`):
 *     the client's own long-term identity PRIVATE key (base64 JWK blob),
 *     scoped by host AND user id.
 *   - identity_pins.json (store/get_identity_pin, key `{host}:{userId}`):
 *     peers' pinned identity PUBLIC keys (base64), for TOFU verification.
 *
 * Lifted verbatim from `lib/identity.ts` (B7-4): same commands, same
 * arguments, same error handling, same log lines. The tri-state results are
 * part of the contract precisely because collapsing them is a security bug —
 * see the comments below, which travel with the code.
 */
import { createLogger } from "@lib/logger";
import type { IdentityStore } from "../contracts/identityStore";

const log = createLogger("identity");

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

export const identity: IdentityStore = {
  /** Save the identity private-key blob for a host to the OS keyring. */
  async saveKey(host, key): Promise<boolean> {
    const invoke = await getInvoke();
    if (!invoke) {
      log.warn("Tauri not available — identity key not saved");
      return false;
    }
    try {
      await invoke("save_identity_key", { host, key });
      return true;
    } catch (err) {
      log.error("Failed to save identity key", { host, error: String(err) });
      return false;
    }
  },

  /**
   * Load the identity private-key blob for a host, or null when nothing is
   * stored (a clean `load_identity_key` resolution with no value).
   *
   * A command REJECTION is rethrown, not swallowed to null: `secret_store::get`
   * on the Rust side reports `Ok(None)` only when both the keyring and the
   * fallback file genuinely hold nothing, and propagates a keyring read error
   * as `Err` instead. A rejection here is therefore a real, unreadable store —
   * not "nothing stored". Callers (see `loadOrGenerateIdentityKeyPair`) rely on
   * that distinction to abort instead of minting and publishing a fresh
   * identity keypair over an existing one, which would invalidate every peer's
   * TOFU pin.
   */
  async loadKey(host) {
    const invoke = await getInvoke();
    if (!invoke) {
      return null;
    }
    try {
      const result = await invoke("load_identity_key", { host });
      return typeof result === "string" ? result : null;
    } catch (err) {
      log.error(
        "Failed to load identity key — propagating so the caller does not treat an unreadable " +
          'store as "no key stored"',
        { host, error: String(err) },
      );
      throw err;
    }
  },

  /** Delete the identity private key for a host from the OS keyring. */
  async deleteKey(host): Promise<boolean> {
    const invoke = await getInvoke();
    if (!invoke) {
      return false;
    }
    try {
      await invoke("delete_identity_key", { host });
      return true;
    } catch (err) {
      log.error("Failed to delete identity key", { host, error: String(err) });
      return false;
    }
  },

  /**
   * Pin a peer's identity public key (base64) under `{host}:{userId}`.
   *
   * The tri-state result mirrors IdentityPinLookup's split: "no-store"
   * (non-Tauri environment, no pin store by design) and "failed" (a real write
   * error, e.g. disk full / unwritable pins file) are both falsy under a plain
   * boolean, but callers that display a "verified" state on the strength of a
   * pin write must be able to tell them apart — collapsing them let a write
   * failure be silently treated the same as the no-store case and still show
   * "verified" with no pin ever persisted.
   */
  async storePin(host, userId, pin) {
    const invoke = await getInvoke();
    if (!invoke) {
      log.warn("Tauri not available — identity pin not stored");
      return "no-store";
    }
    try {
      await invoke("store_identity_pin", { host, userId, pin });
      return "stored";
    } catch (err) {
      log.error("Failed to store identity pin", { host, userId, error: String(err) });
      return "failed";
    }
  },

  /**
   * Look up a peer's pinned identity public key.
   *
   * A store read error is returned as "unavailable", NOT "unpinned" (DC-08,
   * F3 follow-up 3): collapsing the two let a transient keyring error send a
   * pinned peer down the first-sight path — silently verifying against, and
   * then re-pinning, whatever key the server delivered. Callers must fail
   * closed on "unavailable". In non-Tauri environments (tests, browser) there
   * is no pin store by design, so the result is "unpinned" — consistent with
   * every other wrapper here no-oping there.
   */
  async getPin(host, userId) {
    const invoke = await getInvoke();
    if (!invoke) {
      return { status: "unpinned" };
    }
    try {
      const result = await invoke("get_identity_pin", { host, userId });
      return typeof result === "string"
        ? { status: "pinned", pin: result }
        : { status: "unpinned" };
    } catch (err) {
      log.error("Failed to load identity pin — treating as unavailable, not unpinned", {
        host,
        userId,
        error: String(err),
      });
      return { status: "unavailable" };
    }
  },
};

/**
 * Identity-key storage — Tauri IPC wrappers for the voice-E2EE TOFU identity
 * layer (F3). Mirrors credentials.ts: dynamically imports Tauri `invoke` and
 * no-ops in non-Tauri environments (tests, browser).
 *
 * Two backing stores, both keyed by connection host:
 *   - OS keyring  (save/load/delete_identity_key, account `identity:{host}`):
 *     the client's own long-term identity PRIVATE key (base64 JWK blob).
 *   - identity_pins.json (store/get_identity_pin, key `{host}:{userId}`):
 *     peers' pinned identity PUBLIC keys (base64), for TOFU verification.
 */

import { createLogger } from "./logger";
import {
  exportIdentityKeyPair,
  exportPublicKey,
  generateIdentityKeyPair,
  importIdentityKeyPair,
} from "./e2eeCrypto";

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

// ── Identity private key (OS keyring) ──────────────────────────────────────

/** Save the identity private-key blob for a host to the OS keyring. */
export async function saveIdentityKey(host: string, key: string): Promise<boolean> {
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
}

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
export async function loadIdentityKey(host: string): Promise<string | null> {
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
}

/** Delete the identity private key for a host from the OS keyring. */
export async function deleteIdentityKey(host: string): Promise<boolean> {
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
}

// ── Peer identity pins (identity_pins.json, TOFU) ──────────────────────────

/**
 * Result of a peer identity-pin write. Mirrors IdentityPinLookup's tri-state
 * split: "no-store" (non-Tauri environment, no pin store by design) and
 * "failed" (a real write error, e.g. disk full / unwritable pins file) are
 * both falsy under a plain boolean, but callers that display a "verified"
 * state on the strength of a pin write must be able to tell them apart —
 * collapsing them let a write failure be silently treated the same as the
 * no-store case and still show "verified" with no pin ever persisted.
 */
export type StoreIdentityPinResult = "stored" | "no-store" | "failed";

/** Pin a peer's identity public key (base64) under `{host}:{userId}`. */
export async function storeIdentityPin(
  host: string,
  userId: string,
  pin: string,
): Promise<StoreIdentityPinResult> {
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
}

/**
 * Result of a peer identity-pin lookup. "unpinned" is a trust statement —
 * the store was read and holds nothing for this peer (TOFU first sight) —
 * while "unavailable" means the store could not be read at all, so NO trust
 * statement can be made. Mirrors the Rust TLS-TOFU split (tofu.rs), where
 * `load_stored_fingerprint` returns `Err` distinctly from `Ok(None)`.
 */
export type IdentityPinLookup =
  | { readonly status: "pinned"; readonly pin: string }
  | { readonly status: "unpinned" }
  | { readonly status: "unavailable" };

/**
 * Look up a peer's pinned identity public key.
 *
 * A store read error is returned as "unavailable", NOT "unpinned" (DC-08,
 * F3 follow-up 3): collapsing the two let a transient keyring error send a
 * pinned peer down the first-sight path — silently verifying against, and
 * then re-pinning, whatever key the server delivered. Callers must fail
 * closed on "unavailable". In non-Tauri environments (tests, browser) there
 * is no pin store by design, so the result is "unpinned" — consistent with
 * every other wrapper in this module no-oping there.
 */
export async function getIdentityPin(host: string, userId: string): Promise<IdentityPinLookup> {
  const invoke = await getInvoke();
  if (!invoke) {
    return { status: "unpinned" };
  }
  try {
    const result = await invoke("get_identity_pin", { host, userId });
    return typeof result === "string" ? { status: "pinned", pin: result } : { status: "unpinned" };
  } catch (err) {
    log.error("Failed to load identity pin — treating as unavailable, not unpinned", {
      host,
      userId,
      error: String(err),
    });
    return { status: "unavailable" };
  }
}

// ── High-level lifecycle ───────────────────────────────────────────────────

/**
 * One identity keypair per host, shared by every caller in this process.
 *
 * The keypair has two independent consumers: the ready hook publishes its
 * public half (`ensureIdentityKeyPublished`) and the voice session signs
 * announces with its private half (`livekitSession.ensureIdentityKeyPair`).
 * They must be the SAME pair — peers verify the announce signature against the
 * published key. Without this memo each consumer calls the loader separately,
 * so on a machine where the OS credential store does not round-trip (the write
 * reports success, the next read returns nothing) each call mints a fresh
 * keypair: the published key is then never the key that signed, every peer
 * rejects the announce as a forged/MITM signature, and no amount of re-pinning
 * helps because the pin records the published key, not the signer.
 *
 * The promise is cached (not the resolved value) so concurrent first callers
 * share one generation instead of racing to create two.
 */
const identityKeyPairCache = new Map<string, Promise<CryptoKeyPair>>();

/**
 * Load this host's identity keypair from the keyring, generating and saving a
 * fresh one on first login (or when the stored blob is corrupt). In non-Tauri
 * environments the keypair is in-memory only (not persisted).
 *
 * Stable for the lifetime of the process: repeat callers get the same keypair
 * even when the keyring is unavailable (see `identityKeyPairCache`).
 */
export function getOrCreateIdentityKeyPair(host: string): Promise<CryptoKeyPair> {
  let pending = identityKeyPairCache.get(host);
  if (pending === undefined) {
    // A rejected load must not be cached, or the host is poisoned for the
    // rest of the session; drop it so the next caller can retry.
    pending = loadOrGenerateIdentityKeyPair(host).catch((err: unknown) => {
      identityKeyPairCache.delete(host);
      throw err;
    });
    identityKeyPairCache.set(host, pending);
  }
  return pending;
}

/** Test-only: drop the per-host keypair memo so each case starts clean. */
export function resetIdentityKeyPairCache(): void {
  identityKeyPairCache.clear();
}

async function loadOrGenerateIdentityKeyPair(host: string): Promise<CryptoKeyPair> {
  const stored = await loadIdentityKey(host);
  if (stored) {
    try {
      return await importIdentityKeyPair(stored);
    } catch (err) {
      log.error("Stored identity key is corrupt — regenerating", { host, error: String(err) });
    }
  }
  const keyPair = await generateIdentityKeyPair();
  const blob = await exportIdentityKeyPair(keyPair.privateKey);
  if (await saveIdentityKey(host, blob)) {
    // Outer half of a two-layer check. `save_identity_key` already reads its own
    // write back and falls through to the DPAPI file if the OS credential store
    // does not return it (see src-tauri/src/secret_store.rs and
    // docs/credential-storage.md), so reaching the branch below now means the
    // secret survived neither store. Kept because this is the failure a
    // resolved promise cannot express, and its only other symptom is peers
    // flagging the user as a MITM after a restart. A read error here (as
    // opposed to loadIdentityKey's first call above, which decides whether to
    // regenerate) is treated the same as a mismatch, not rethrown — we
    // already have a freshly generated keypair for this session, so there is
    // nothing left to abort.
    let persisted: boolean;
    try {
      persisted = (await loadIdentityKey(host)) === blob;
    } catch {
      persisted = false;
    }
    if (!persisted) {
      log.error(
        "Identity key did not persist — the credential store accepted the write but did not return it. " +
          "This session works, but peers will see a new identity (and prompt to re-verify) every restart.",
        { host },
      );
    }
  }
  return keyPair;
}

/**
 * Publish the local identity public key via the REST profile update, but only
 * when the server's stored copy is absent or different — idempotent so it runs
 * at most once per key (no PATCH on every login). Returns true if it published.
 *
 * `serverCopy` is the server's current `identity_public_key` for this user
 * (from the ready/member payload); `updateProfile` is `api.updateProfile`.
 */
export async function publishIdentityKey(
  updateProfile: (data: { identity_public_key: string }) => Promise<unknown>,
  serverCopy: string | null | undefined,
  publicKey: CryptoKey,
): Promise<boolean> {
  const localBase64 = await exportPublicKey(publicKey);
  if (serverCopy === localBase64) {
    return false;
  }
  await updateProfile({ identity_public_key: localBase64 });
  return true;
}

/**
 * Login/ready hook: ensure the server holds this client's identity public key.
 * Loads (or generates) the host keypair and publishes it via the REST profile
 * update when the server's stored copy is absent or stale — idempotent, so it
 * runs at most once per key. The server's PATCH /users/me requires a username,
 * so `username` is sent alongside the key. Fire-and-forget: errors are logged
 * and swallowed (returns false) so the connect/voice flow is never blocked.
 */
export async function ensureIdentityKeyPublished(
  host: string,
  username: string,
  serverCopy: string | null | undefined,
  updateProfile: (data: { username: string; identity_public_key: string }) => Promise<unknown>,
): Promise<boolean> {
  try {
    const keyPair = await getOrCreateIdentityKeyPair(host);
    return await publishIdentityKey(
      (data) => updateProfile({ username, ...data }),
      serverCopy,
      keyPair.publicKey,
    );
  } catch (err) {
    log.error("Failed to publish identity key", { host, error: String(err) });
    return false;
  }
}

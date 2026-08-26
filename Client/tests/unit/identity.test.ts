import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock, tauri, logMock, createLoggerMock } = vi.hoisted(() => {
  const logMock = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    invokeMock: vi.fn(),
    // Flip `available` to false to simulate a non-Tauri environment (browser,
    // plain vitest run): `@tauri-apps/api/core` resolves without a usable
    // `invoke`, so `getInvoke()` yields null and every wrapper takes its
    // no-op branch. Those branches are otherwise unreachable here, because
    // the module mock always hands back a working `invoke`.
    tauri: { available: true },
    logMock,
    createLoggerMock: vi.fn(() => logMock),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  get invoke() {
    return tauri.available ? invokeMock : undefined;
  },
}));
vi.mock("@lib/logger", () => ({ createLogger: createLoggerMock }));

import {
  saveIdentityKey,
  loadIdentityKey,
  deleteIdentityKey,
  storeIdentityPin,
  getIdentityPin,
  getOrCreateIdentityKeyPair,
  resetIdentityKeyPairCache,
  publishIdentityKey,
  ensureIdentityKeyPublished,
} from "@lib/identity";
import { generateIdentityKeyPair, exportPublicKey, exportIdentityKeyPair } from "@lib/e2eeCrypto";
import { authStore } from "@stores/auth.store";

/**
 * Stateful keyring double for the legacy-migration tests: a Map keyed by the
 * exact `host` string each command receives (the scoped account
 * `1@chat.example` and the legacy account `chat.example` are just different
 * keys in the same map), so save/delete on one account cannot be confused
 * with another the way a host-agnostic mock would.
 */
function keyringDouble(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map<string, string>(Object.entries(seed));
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    const h = args?.host as string;
    if (cmd === "load_identity_key") return Promise.resolve(store.get(h) ?? null);
    if (cmd === "save_identity_key") {
      store.set(h, args!.key as string);
      return Promise.resolve(undefined);
    }
    if (cmd === "delete_identity_key") {
      store.delete(h);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(undefined);
  });
  return store;
}

beforeEach(() => {
  invokeMock.mockReset();
  logMock.error.mockReset();
  logMock.warn.mockReset();
  tauri.available = true;
  // The keypair memo is process-wide by design; without this, one case's
  // cached pair would satisfy the next case's keyring assertions.
  resetIdentityKeyPairCache();
});

describe("identity keyring wrappers", () => {
  it("saveIdentityKey invokes save_identity_key with { host, key }", async () => {
    invokeMock.mockResolvedValue(undefined);
    const ok = await saveIdentityKey("chat.example", "blob");
    expect(ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("save_identity_key", {
      host: "chat.example",
      key: "blob",
    });
  });

  it("loadIdentityKey returns the stored string, or null when absent", async () => {
    invokeMock.mockResolvedValueOnce("blob");
    expect(await loadIdentityKey("chat.example")).toBe("blob");
    invokeMock.mockResolvedValueOnce(null);
    expect(await loadIdentityKey("chat.example")).toBeNull();
  });

  it("deleteIdentityKey invokes delete_identity_key with { host }", async () => {
    invokeMock.mockResolvedValue(undefined);
    expect(await deleteIdentityKey("chat.example")).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("delete_identity_key", { host: "chat.example" });
  });

  it("returns false and swallows errors when a command rejects (save/delete)", async () => {
    invokeMock.mockRejectedValue(new Error("keyring boom"));
    expect(await saveIdentityKey("h", "k")).toBe(false);
    expect(await deleteIdentityKey("h")).toBe(false);
    // The log is the only trace either failure leaves — the caller just sees
    // `false` — so it has to carry the host and the underlying error.
    expect(logMock.error).toHaveBeenCalledWith("Failed to save identity key", {
      host: "h",
      error: "Error: keyring boom",
    });
    expect(logMock.error).toHaveBeenCalledWith("Failed to delete identity key", {
      host: "h",
      error: "Error: keyring boom",
    });
  });

  it("loadIdentityKey rethrows (does not swallow) when the command rejects", async () => {
    // A keyring read error must not be indistinguishable from "nothing
    // stored" — loadOrGenerateIdentityKeyPair uses a null return to decide
    // whether to mint a brand-new identity keypair, so swallowing an error
    // into null here mints and publishes a fresh identity on every transient
    // store failure, invalidating every peer's TOFU pin.
    invokeMock.mockRejectedValueOnce(new Error("keyring boom"));
    await expect(loadIdentityKey("h")).rejects.toThrow("keyring boom");
    expect(logMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to load identity key.*no key stored/),
      { host: "h", error: "Error: keyring boom" },
    );
  });

  it("names its logger 'identity' so these messages are filterable", () => {
    expect(createLoggerMock).toHaveBeenCalledWith("identity");
  });
});

describe("non-Tauri environment (no invoke available)", () => {
  // Browser / plain-vitest runs have no Tauri IPC at all. Every wrapper has to
  // no-op *distinguishably*: a save that never happened must not report
  // success (loadOrGenerateIdentityKeyPair reads that boolean to decide
  // whether to verify the write round-tripped), and a pin store that does not
  // exist must report "no-store"/"unpinned", never "stored"/"pinned".
  beforeEach(() => {
    tauri.available = false;
  });

  it("saveIdentityKey reports failure — not a phantom success — and warns", async () => {
    expect(await saveIdentityKey("chat.example", "blob")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(logMock.warn).toHaveBeenCalledWith(expect.stringContaining("identity key not saved"));
  });

  it("loadIdentityKey resolves null (nothing stored) instead of throwing", async () => {
    await expect(loadIdentityKey("chat.example")).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("deleteIdentityKey reports failure", async () => {
    expect(await deleteIdentityKey("chat.example")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("storeIdentityPin reports 'no-store', never 'stored'", async () => {
    expect(await storeIdentityPin("chat.example", "42", "pubkey")).toBe("no-store");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(logMock.warn).toHaveBeenCalledWith(expect.stringContaining("identity pin not stored"));
  });

  it("getIdentityPin reports 'unpinned' (TOFU first sight), never 'pinned'", async () => {
    expect(await getIdentityPin("chat.example", "42")).toEqual({ status: "unpinned" });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("identity pin wrappers", () => {
  it("storeIdentityPin invokes store_identity_pin with { host, userId, pin }", async () => {
    invokeMock.mockResolvedValue(undefined);
    const result = await storeIdentityPin("chat.example", "42", "pubkey");
    expect(result).toBe("stored");
    expect(invokeMock).toHaveBeenCalledWith("store_identity_pin", {
      host: "chat.example",
      userId: "42",
      pin: "pubkey",
    });
  });

  it("storeIdentityPin reports 'failed' (not silently truthy/falsy) when the write rejects", async () => {
    // The whole point of the tri-state result: a real write error (disk
    // full, unwritable pins file) must be distinguishable from "no-store"
    // (non-Tauri, by design) — collapsing both to `false` let a caller
    // treat a failed write the same as "nothing to persist" and still show
    // "verified" with no pin ever saved.
    invokeMock.mockRejectedValueOnce(new Error("disk full"));
    const result = await storeIdentityPin("chat.example", "42", "pubkey");
    expect(result).toBe("failed");
    expect(logMock.error).toHaveBeenCalledWith(
      "Failed to store identity pin",
      expect.objectContaining({ host: "chat.example", userId: "42" }),
    );
  });

  it("getIdentityPin returns the pinned key when one is stored", async () => {
    invokeMock.mockResolvedValueOnce("pubkey");
    expect(await getIdentityPin("chat.example", "42")).toEqual({
      status: "pinned",
      pin: "pubkey",
    });
    expect(invokeMock).toHaveBeenCalledWith("get_identity_pin", {
      host: "chat.example",
      userId: "42",
    });
  });

  it("getIdentityPin reports 'unpinned' when the store holds nothing (first sight)", async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await getIdentityPin("chat.example", "42")).toEqual({ status: "unpinned" });
  });

  it("getIdentityPin reports a store error as 'unavailable', never 'unpinned' (DC-08)", async () => {
    // The distinction is the whole fix: a transient keyring failure must not
    // masquerade as "never pinned", or verification silently falls through to
    // the first-sight path and re-pins whatever key the server delivered.
    invokeMock.mockRejectedValueOnce(new Error("keyring boom"));
    expect(await getIdentityPin("chat.example", "42")).toEqual({ status: "unavailable" });
    expect(logMock.error).toHaveBeenCalledWith(
      expect.stringContaining("unavailable"),
      expect.objectContaining({ host: "chat.example", userId: "42" }),
    );
  });
});

describe("getOrCreateIdentityKeyPair", () => {
  it("generates + saves a fresh keypair on first login (nothing stored)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });

    const kp = await getOrCreateIdentityKeyPair("chat.example", 1);
    expect(kp.privateKey).toBeDefined();
    expect(kp.publicKey).toBeDefined();

    const saveCall = invokeMock.mock.calls.find((c) => c[0] === "save_identity_key");
    expect(saveCall).toBeDefined();
    // Scoped by host AND user id (B3-3) — not just host — so two accounts
    // signed into the same host never share a keyring blob.
    expect((saveCall![1] as { host: string }).host).toBe("1@chat.example");
  });

  it("reloads the persisted keypair on subsequent logins (no regenerate)", async () => {
    // First login: capture the blob that gets saved.
    let savedBlob: string | undefined;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "load_identity_key") return Promise.resolve(null);
      if (cmd === "save_identity_key") {
        savedBlob = args!.key as string;
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });
    const first = await getOrCreateIdentityKeyPair("chat.example", 1);
    const firstPub = await exportPublicKey(first.publicKey);

    // Second login: keyring returns the saved blob → same public key, no save.
    // Drop the memo first, or this asserts nothing about the keyring — a new
    // login is a new process, which is exactly what the reload path is for.
    resetIdentityKeyPairCache();
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.resolve(savedBlob);
      return Promise.resolve(undefined);
    });
    const second = await getOrCreateIdentityKeyPair("chat.example", 1);
    expect(await exportPublicKey(second.publicKey)).toBe(firstPub);
    expect(invokeMock.mock.calls.some((c) => c[0] === "save_identity_key")).toBe(false);
  });

  it("regenerates when the stored blob is corrupt", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.resolve("!!not-valid-jwk!!");
      return Promise.resolve(undefined);
    });
    const kp = await getOrCreateIdentityKeyPair("chat.example", 1);
    expect(kp.publicKey).toBeDefined();
    expect(invokeMock.mock.calls.some((c) => c[0] === "save_identity_key")).toBe(true);
    // Silently regenerating is indistinguishable from a first login; the log
    // is what tells a support reader why peers suddenly see a new identity.
    expect(logMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Stored identity key is corrupt"),
      expect.objectContaining({ host: "chat.example", userId: 1 }),
    );
  });

  it("hands every caller the same keypair when the keyring never persists", async () => {
    // A store that accepts the write and returns nothing on the next read.
    // Before the memo, the ready hook (publishes the public half) and the voice
    // session (signs announces with the private half) each generated their own
    // keypair here — so the published key was never the key that signed, and
    // peers rejected every announce as a forged signature.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });

    const [publishPair, signingPair] = await Promise.all([
      getOrCreateIdentityKeyPair("chat.example", 1),
      getOrCreateIdentityKeyPair("chat.example", 1),
    ]);
    const laterPair = await getOrCreateIdentityKeyPair("chat.example", 1);

    expect(signingPair).toBe(publishPair);
    expect(laterPair).toBe(publishPair);
    // One generation, not one per caller.
    expect(invokeMock.mock.calls.filter((c) => c[0] === "save_identity_key")).toHaveLength(1);
  });

  it("keeps the memo per host", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
    const a = await getOrCreateIdentityKeyPair("chat.example", 1);
    const b = await getOrCreateIdentityKeyPair("other.example", 1);
    expect(await exportPublicKey(b.publicKey)).not.toBe(await exportPublicKey(a.publicKey));
  });

  it("[B3-3] keeps the memo per user id, not just per host — two accounts on the same host never share an identity keypair", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
    const userA = await getOrCreateIdentityKeyPair("chat.example", 1);
    const userB = await getOrCreateIdentityKeyPair("chat.example", 2);
    expect(await exportPublicKey(userB.publicKey)).not.toBe(await exportPublicKey(userA.publicKey));
  });

  it("[OC-0118] a scoped host+userId account never collides with a legacy host-only account for a DIFFERENT host", async () => {
    // Pre-B3-3 install on some other server reachable as "chat.example:8443"
    // (host string carries an explicit port) stored its identity key under
    // the legacy host-only keyring account `identity:chat.example:8443`. A
    // completely different server reachable as "chat.example" (port 443)
    // signs in as the user whose id happens to be 8443:
    // identityScopeKey("chat.example", 8443) must NOT produce the same
    // string "chat.example:8443" as that unrelated legacy account, or this
    // login silently adopts (and later re-publishes) the other server's
    // identity private key.
    const otherServerLegacyKey = await generateIdentityKeyPair();
    const otherServerLegacyBlob = await exportIdentityKeyPair(otherServerLegacyKey.privateKey);
    const otherServerLegacyPub = await exportPublicKey(otherServerLegacyKey.publicKey);
    keyringDouble({ "chat.example:8443": otherServerLegacyBlob });

    const kp = await getOrCreateIdentityKeyPair("chat.example", 8443);

    expect(await exportPublicKey(kp.publicKey)).not.toBe(otherServerLegacyPub);
  });

  it("reports a credential store that accepts the write but drops the value", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.resolve(null);
      return Promise.resolve(undefined); // save_identity_key "succeeds"
    });

    await getOrCreateIdentityKeyPair("chat.example", 1);

    expect(logMock.error).toHaveBeenCalledWith(expect.stringContaining("did not persist"), {
      host: "chat.example",
      userId: 1,
    });
  });

  it("treats a failed read-back as 'did not persist' (does not assume success) and still returns the fresh keypair", async () => {
    // Save succeeds, then the store goes unreadable. Unlike the *first* load —
    // which rethrows so the caller aborts rather than overwriting an
    // unreadable identity — this read is only verifying the write, and a
    // freshly generated keypair is already in hand, so there is nothing to
    // abort. It must still be reported as unverified: assuming the write
    // stuck hides the exact failure whose only other symptom is every peer
    // seeing a new identity after each restart.
    let saved = false;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") {
        return saved ? Promise.reject(new Error("keychain locked")) : Promise.resolve(null);
      }
      if (cmd === "save_identity_key") {
        saved = true;
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    const kp = await getOrCreateIdentityKeyPair("chat.example", 1);

    expect(kp.publicKey).toBeDefined();
    expect(logMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/did not persist.*prompt to re-verify/),
      { host: "chat.example", userId: 1 },
    );
  });

  it("aborts instead of regenerating when the keyring read fails (does not overwrite an unreadable identity)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.reject(new Error("keychain locked"));
      return Promise.resolve(undefined);
    });

    await expect(getOrCreateIdentityKeyPair("chat.example", 1)).rejects.toThrow("keychain locked");
    // Must not have minted and saved a brand-new identity over the top of an
    // unreadable (not necessarily absent) stored key.
    expect(invokeMock.mock.calls.some((c) => c[0] === "save_identity_key")).toBe(false);
  });

  it("stays quiet when the store round-trips the key", async () => {
    let savedBlob: string | undefined;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "load_identity_key") return Promise.resolve(savedBlob ?? null);
      if (cmd === "save_identity_key") {
        savedBlob = args!.key as string;
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    await getOrCreateIdentityKeyPair("chat.example", 1);

    expect(logMock.error).not.toHaveBeenCalled();
  });
});

describe("publishIdentityKey", () => {
  it("publishes when the server copy is absent", async () => {
    const { publicKey } = await generateIdentityKeyPair();
    const updateProfile = vi.fn().mockResolvedValue({});
    const published = await publishIdentityKey(updateProfile, null, publicKey);
    expect(published).toBe(true);
    const expected = await exportPublicKey(publicKey);
    expect(updateProfile).toHaveBeenCalledWith({ identity_public_key: expected });
  });

  it("publishes when the server copy differs", async () => {
    const { publicKey } = await generateIdentityKeyPair();
    const updateProfile = vi.fn().mockResolvedValue({});
    expect(await publishIdentityKey(updateProfile, "some-other-key", publicKey)).toBe(true);
    expect(updateProfile).toHaveBeenCalledOnce();
  });

  it("no-ops when the server copy already matches (idempotent)", async () => {
    const { publicKey } = await generateIdentityKeyPair();
    const current = await exportPublicKey(publicKey);
    const updateProfile = vi.fn().mockResolvedValue({});
    expect(await publishIdentityKey(updateProfile, current, publicKey)).toBe(false);
    expect(updateProfile).not.toHaveBeenCalled();
  });
});

describe("ensureIdentityKeyPublished (login/ready publish flow)", () => {
  // Real authStore, not mocked — these tests exercise the normal ready-hook
  // timing where auth state is already populated. The "not authenticated
  // yet" guard is its own test below, which overrides `user` back to null.
  beforeEach(() => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 1, username: "alex", avatar: null, role: "member" },
    }));
  });

  afterEach(() => {
    authStore.setState((prev) => ({ ...prev, user: null }));
  });

  it("publishes username + identity key when the server copy is absent", async () => {
    // First-login keyring: nothing stored → a fresh keypair is generated.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
    const updateProfile = vi.fn().mockResolvedValue({});

    const published = await ensureIdentityKeyPublished("chat.example", "alex", null, updateProfile);

    expect(published).toBe(true);
    expect(updateProfile).toHaveBeenCalledTimes(1);
    const arg = updateProfile.mock.calls[0]![0] as {
      username: string;
      identity_public_key: string;
    };
    // Server requires a username alongside identity_public_key — both present.
    expect(arg.username).toBe("alex");
    expect(typeof arg.identity_public_key).toBe("string");
    expect(arg.identity_public_key.length).toBeGreaterThan(0);
  });

  it("no-ops when the server copy already matches the local key (idempotent)", async () => {
    // Keyring persists the generated blob across calls → same public key.
    let savedBlob: string | undefined;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "load_identity_key") return Promise.resolve(savedBlob ?? null);
      if (cmd === "save_identity_key") {
        savedBlob = args!.key as string;
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    const first = vi.fn().mockResolvedValue({});
    await ensureIdentityKeyPublished("chat.example", "alex", null, first);
    const serverCopy = (first.mock.calls[0]![0] as { identity_public_key: string })
      .identity_public_key;

    const second = vi.fn().mockResolvedValue({});
    const published = await ensureIdentityKeyPublished("chat.example", "alex", serverCopy, second);

    expect(published).toBe(false);
    expect(second).not.toHaveBeenCalled();
  });

  it("does not mint/publish a new identity key when the keyring read fails (fire-and-forget)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.reject(new Error("keychain locked"));
      return Promise.resolve(undefined);
    });
    const updateProfile = vi.fn().mockResolvedValue({});

    const published = await ensureIdentityKeyPublished("chat.example", "alex", null, updateProfile);

    expect(published).toBe(false);
    expect(updateProfile).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.some((c) => c[0] === "save_identity_key")).toBe(false);
  });

  it("swallows a failing profile update (fire-and-forget, never throws)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
    const updateProfile = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(
      ensureIdentityKeyPublished("chat.example", "alex", null, updateProfile),
    ).resolves.toBe(false);
    expect(logMock.error).toHaveBeenCalledWith("Failed to publish identity key", {
      host: "chat.example",
      error: "Error: network down",
    });
  });

  it("does not mint or publish an identity key when no user is authenticated yet (never falls back to a placeholder scope)", async () => {
    // Auth state not yet populated — e.g. this hook running before auth_ok
    // has landed. Falling back to a placeholder `?? 0` scope would mint (or
    // migrate-and-DELETE the real legacy key into) a bogus `host:0` keyring
    // account; a later authenticated call then mints a SECOND, DIFFERENT
    // keypair under `host:<realId>`, so the published key and the announce
    // signing key permanently disagree — a false MITM warning for every peer.
    authStore.setState((prev) => ({ ...prev, user: null }));
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
    const updateProfile = vi.fn().mockResolvedValue({});

    const published = await ensureIdentityKeyPublished("chat.example", "alex", null, updateProfile);

    expect(published).toBe(false);
    expect(updateProfile).not.toHaveBeenCalled();
    // No keyring interaction at all — nothing minted, migrated, or deleted.
    expect(invokeMock).not.toHaveBeenCalled();
    expect(logMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("authenticated user id"),
      expect.objectContaining({ host: "chat.example" }),
    );
  });

  it("does not migrate (and delete) the legacy host-only key when no user is authenticated yet", async () => {
    authStore.setState((prev) => ({ ...prev, user: null }));
    const legacy = await generateIdentityKeyPair();
    const legacyBlob = await exportIdentityKeyPair(legacy.privateKey);
    const store = keyringDouble({ "chat.example": legacyBlob });
    const updateProfile = vi.fn().mockResolvedValue({});

    await ensureIdentityKeyPublished("chat.example", "alex", null, updateProfile);

    // The legacy key must be untouched: no adopt-then-delete into a bogus
    // host:0 scope.
    expect(store.get("chat.example")).toBe(legacyBlob);
    expect(store.has("0@chat.example")).toBe(false);
  });
});

describe("legacy identity key migration (pre-B3-3 host-only account)", () => {
  it("adopts a legacy host-only key: saves it under the scoped account and deletes the legacy one", async () => {
    const legacy = await generateIdentityKeyPair();
    const legacyBlob = await exportIdentityKeyPair(legacy.privateKey);
    const legacyPub = await exportPublicKey(legacy.publicKey);
    const store = keyringDouble({ "chat.example": legacyBlob });

    const kp = await getOrCreateIdentityKeyPair("chat.example", 1);

    expect(await exportPublicKey(kp.publicKey)).toBe(legacyPub);
    expect(store.get("1@chat.example")).toBe(legacyBlob);
    // Deleted so it can never be adopted a second time.
    expect(store.has("chat.example")).toBe(false);
  });

  it("a second account on the same host gets its own keypair, not the already-adopted legacy one", async () => {
    const legacy = await generateIdentityKeyPair();
    const legacyBlob = await exportIdentityKeyPair(legacy.privateKey);
    const legacyPub = await exportPublicKey(legacy.publicKey);
    const store = keyringDouble({ "chat.example": legacyBlob });

    const first = await getOrCreateIdentityKeyPair("chat.example", 1);
    expect(await exportPublicKey(first.publicKey)).toBe(legacyPub);

    const second = await getOrCreateIdentityKeyPair("chat.example", 2);
    expect(await exportPublicKey(second.publicKey)).not.toBe(legacyPub);
    expect(store.get("2@chat.example")).toBeDefined();
    expect(store.get("2@chat.example")).not.toBe(legacyBlob);
  });

  it("falls back to fresh generation, without throwing, when the legacy blob is corrupt", async () => {
    const store = keyringDouble({ "chat.example": "!!not-valid-jwk!!" });

    const kp = await getOrCreateIdentityKeyPair("chat.example", 1);

    expect(kp.publicKey).toBeDefined();
    expect(store.get("1@chat.example")).toBeDefined();
    expect(store.get("1@chat.example")).not.toBe("!!not-valid-jwk!!");
    expect(logMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Legacy identity key is corrupt"),
      expect.objectContaining({ host: "chat.example" }),
    );
  });

  it("generates fresh, with no delete attempt, when there is no legacy key either (first login)", async () => {
    keyringDouble();

    const kp = await getOrCreateIdentityKeyPair("chat.example", 1);

    expect(kp.publicKey).toBeDefined();
    expect(invokeMock.mock.calls.some((c) => c[0] === "delete_identity_key")).toBe(false);
  });

  it("keeps the legacy key in place when the scoped save fails, so migration can retry next launch", async () => {
    const legacy = await generateIdentityKeyPair();
    const legacyBlob = await exportIdentityKeyPair(legacy.privateKey);
    const store = keyringDouble({ "chat.example": legacyBlob });
    const load = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "save_identity_key") return Promise.reject(new Error("keyring boom"));
      return load(cmd, args);
    });

    await getOrCreateIdentityKeyPair("chat.example", 1);

    expect(store.get("chat.example")).toBe(legacyBlob);
    expect(store.has("1@chat.example")).toBe(false);
    expect(logMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to migrate legacy identity key.*next launch can retry/),
      { host: "chat.example" },
    );
  });
});

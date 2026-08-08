import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, logMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  logMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@lib/logger", () => ({ createLogger: () => logMock }));

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
import { generateIdentityKeyPair, exportPublicKey } from "@lib/e2eeCrypto";

beforeEach(() => {
  invokeMock.mockReset();
  logMock.error.mockReset();
  logMock.warn.mockReset();
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
  });

  it("loadIdentityKey rethrows (does not swallow) when the command rejects", async () => {
    // A keyring read error must not be indistinguishable from "nothing
    // stored" — loadOrGenerateIdentityKeyPair uses a null return to decide
    // whether to mint a brand-new identity keypair, so swallowing an error
    // into null here mints and publishes a fresh identity on every transient
    // store failure, invalidating every peer's TOFU pin.
    invokeMock.mockRejectedValueOnce(new Error("keyring boom"));
    await expect(loadIdentityKey("h")).rejects.toThrow("keyring boom");
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
    expect((saveCall![1] as { host: string }).host).toBe("chat.example:1");
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
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  saveIdentityKey,
  loadIdentityKey,
  deleteIdentityKey,
  storeIdentityPin,
  getIdentityPin,
  getOrCreateIdentityKeyPair,
  publishIdentityKey,
  ensureIdentityKeyPublished,
} from "@lib/identity";
import { generateIdentityKeyPair, exportPublicKey } from "@lib/e2eeCrypto";

beforeEach(() => {
  invokeMock.mockReset();
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

  it("returns false/null and swallows errors when a command rejects", async () => {
    invokeMock.mockRejectedValue(new Error("keyring boom"));
    expect(await saveIdentityKey("h", "k")).toBe(false);
    expect(await loadIdentityKey("h")).toBeNull();
    expect(await deleteIdentityKey("h")).toBe(false);
  });
});

describe("identity pin wrappers", () => {
  it("storeIdentityPin invokes store_identity_pin with { host, userId, pin }", async () => {
    invokeMock.mockResolvedValue(undefined);
    const ok = await storeIdentityPin("chat.example", "42", "pubkey");
    expect(ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("store_identity_pin", {
      host: "chat.example",
      userId: "42",
      pin: "pubkey",
    });
  });

  it("getIdentityPin returns the pinned key, or null when never pinned", async () => {
    invokeMock.mockResolvedValueOnce("pubkey");
    expect(await getIdentityPin("chat.example", "42")).toBe("pubkey");
    invokeMock.mockResolvedValueOnce(null);
    expect(await getIdentityPin("chat.example", "42")).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("get_identity_pin", {
      host: "chat.example",
      userId: "42",
    });
  });
});

describe("getOrCreateIdentityKeyPair", () => {
  it("generates + saves a fresh keypair on first login (nothing stored)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });

    const kp = await getOrCreateIdentityKeyPair("chat.example");
    expect(kp.privateKey).toBeDefined();
    expect(kp.publicKey).toBeDefined();

    const saveCall = invokeMock.mock.calls.find((c) => c[0] === "save_identity_key");
    expect(saveCall).toBeDefined();
    expect((saveCall![1] as { host: string }).host).toBe("chat.example");
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
    const first = await getOrCreateIdentityKeyPair("chat.example");
    const firstPub = await exportPublicKey(first.publicKey);

    // Second login: keyring returns the saved blob → same public key, no save.
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.resolve(savedBlob);
      return Promise.resolve(undefined);
    });
    const second = await getOrCreateIdentityKeyPair("chat.example");
    expect(await exportPublicKey(second.publicKey)).toBe(firstPub);
    expect(invokeMock.mock.calls.some((c) => c[0] === "save_identity_key")).toBe(false);
  });

  it("regenerates when the stored blob is corrupt", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_identity_key") return Promise.resolve("!!not-valid-jwk!!");
      return Promise.resolve(undefined);
    });
    const kp = await getOrCreateIdentityKeyPair("chat.example");
    expect(kp.publicKey).toBeDefined();
    expect(invokeMock.mock.calls.some((c) => c[0] === "save_identity_key")).toBe(true);
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

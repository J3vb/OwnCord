import { describe, it, expect, vi, beforeEach } from "vitest";

const auth = vi.hoisted((): { user: { id: number } | null } => ({ user: { id: 7 } }));
vi.mock("../../stores/auth.store", () => ({
  authStore: { getState: () => auth },
}));
vi.mock("../../lib/identity", () => ({ getOrCreateIdentityKeyPair: vi.fn() }));
vi.mock("../../lib/e2eeCrypto", () => ({ signEphemeralKey: vi.fn() }));
vi.mock("../../lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { getOrCreateIdentityKeyPair } from "../../lib/identity";
import { signEphemeralKey } from "../../lib/e2eeCrypto";
import { E2EEIdentity, rawFromBase64 } from "./e2eeIdentity";

const PAIR = { privateKey: "priv", publicKey: "pub" } as unknown as CryptoKeyPair;
const EPHEMERAL = btoa("\x01\x02\x03");

function deferredPair() {
  const load = {} as { promise: Promise<CryptoKeyPair>; release: (pair: CryptoKeyPair) => void };
  load.promise = new Promise((resolve) => {
    load.release = resolve;
  });
  return load;
}

function setup(host: string | null = "chat.example") {
  let currentHost = host;
  const identity = new E2EEIdentity({ getServerHost: () => currentHost });
  return { identity, setHost: (h: string | null) => (currentHost = h) };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { id: 7 };
  vi.mocked(getOrCreateIdentityKeyPair).mockResolvedValue(PAIR);
  vi.mocked(signEphemeralKey).mockResolvedValue("sig");
});

describe("rawFromBase64", () => {
  it("decodes a base64 raw key to its bytes", () => {
    expect([...rawFromBase64(EPHEMERAL)]).toEqual([1, 2, 3]);
  });
});

describe("E2EEIdentity", () => {
  it("starts with no ephemeral keypair", () => {
    expect(setup().identity.ecdhKeyPair).toBeNull();
  });

  it("signs the announce with the identity key scoped to host and user", async () => {
    const { identity } = setup();
    await expect(identity.buildAnnouncePayload(EPHEMERAL)).resolves.toEqual({
      public_key: EPHEMERAL,
      signature: "sig",
    });
    expect(getOrCreateIdentityKeyPair).toHaveBeenCalledWith("chat.example", 7);
    expect(signEphemeralKey).toHaveBeenCalledWith("priv", 7, new Uint8Array([1, 2, 3]));
  });

  it("announces unsigned without a host", async () => {
    const { identity } = setup(null);
    await expect(identity.buildAnnouncePayload(EPHEMERAL)).resolves.toEqual({
      public_key: EPHEMERAL,
    });
    expect(getOrCreateIdentityKeyPair).not.toHaveBeenCalled();
  });

  it("announces unsigned rather than scoping under a placeholder user id", async () => {
    auth.user = null;
    const { identity } = setup();
    await expect(identity.buildAnnouncePayload(EPHEMERAL)).resolves.toEqual({
      public_key: EPHEMERAL,
    });
    expect(getOrCreateIdentityKeyPair).not.toHaveBeenCalled();
  });

  it("loads the identity keypair once per scope", async () => {
    const { identity } = setup();
    await identity.buildAnnouncePayload(EPHEMERAL);
    await identity.buildAnnouncePayload(EPHEMERAL);
    expect(getOrCreateIdentityKeyPair).toHaveBeenCalledTimes(1);
  });

  it("reloads when the host changes", async () => {
    const { identity, setHost } = setup();
    await identity.buildAnnouncePayload(EPHEMERAL);
    setHost("other.example");
    await identity.buildAnnouncePayload(EPHEMERAL);
    expect(getOrCreateIdentityKeyPair).toHaveBeenLastCalledWith("other.example", 7);
    expect(getOrCreateIdentityKeyPair).toHaveBeenCalledTimes(2);
  });

  it("reloads after clearIdentityKeyPair", async () => {
    const { identity } = setup();
    await identity.buildAnnouncePayload(EPHEMERAL);
    identity.clearIdentityKeyPair();
    await identity.buildAnnouncePayload(EPHEMERAL);
    expect(getOrCreateIdentityKeyPair).toHaveBeenCalledTimes(2);
  });

  it("discards a keyring load that a clearIdentityKeyPair superseded", async () => {
    const load = deferredPair();
    vi.mocked(getOrCreateIdentityKeyPair).mockReturnValueOnce(load.promise);
    const { identity } = setup();
    const pending = identity.buildAnnouncePayload(EPHEMERAL);
    identity.clearIdentityKeyPair();
    load.release(PAIR);
    await expect(pending).resolves.toEqual({ public_key: EPHEMERAL });
    // The stale pair was not cached: the next announce loads again.
    await identity.buildAnnouncePayload(EPHEMERAL);
    expect(getOrCreateIdentityKeyPair).toHaveBeenCalledTimes(2);
  });

  it.each(["host", "user"] as const)(
    "discards a keyring load that finished after the %s changed",
    async (change) => {
      const load = deferredPair();
      vi.mocked(getOrCreateIdentityKeyPair).mockReturnValueOnce(load.promise);
      const { identity, setHost } = setup();
      const pending = identity.buildAnnouncePayload(EPHEMERAL);
      if (change === "host") setHost("other.example");
      else auth.user = { id: 8 };
      load.release(PAIR);
      await expect(pending).resolves.toEqual({ public_key: EPHEMERAL });
      expect(signEphemeralKey).not.toHaveBeenCalled();
    },
  );

  it("degrades to an unsigned announce when signing fails", async () => {
    vi.mocked(signEphemeralKey).mockRejectedValueOnce(new Error("keyring"));
    const { identity } = setup();
    await expect(identity.buildAnnouncePayload(EPHEMERAL)).resolves.toEqual({
      public_key: EPHEMERAL,
    });
  });
});

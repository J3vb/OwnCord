import { describe, it, expect, vi, beforeEach } from "vitest";

const auth = vi.hoisted((): { user: { id: number } | null } => ({ user: { id: 7 } }));
vi.mock("../../stores/auth.store", () => ({
  authStore: { getState: () => auth },
}));
vi.mock("../../lib/identity", () => ({ getOrCreateIdentityKeyPair: vi.fn() }));
vi.mock("../../lib/e2eeCrypto", () => ({
  signEphemeralKey: vi.fn(),
  exportPublicKey: vi.fn(),
  computeKeyFingerprint: vi.fn(),
}));
const decode = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("./decodeCaps", () => ({ localVideoDecode: () => decode.list() }));
const log = vi.hoisted(() => ({
  tags: [] as string[],
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../lib/logger", () => ({
  createLogger: (tag: string) => {
    log.tags.push(tag);
    return log;
  },
}));

import { getOrCreateIdentityKeyPair } from "../../lib/identity";
import { computeKeyFingerprint, exportPublicKey, signEphemeralKey } from "../../lib/e2eeCrypto";
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

function deferred<T>() {
  const gate = {} as { promise: Promise<T>; resolve: (value: T) => void };
  gate.promise = new Promise<T>((resolve) => {
    gate.resolve = resolve;
  });
  return gate;
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
  vi.mocked(exportPublicKey).mockResolvedValue("device-pub");
  decode.list.mockResolvedValue(["vp8", "h264"]);
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

  it("the announce awaits the Linux list", async () => {
    const gate = deferred<string[]>();
    decode.list.mockReturnValue(gate.promise);
    const { identity } = setup();
    const pending = identity.buildAnnouncePayload(EPHEMERAL);
    const settled = vi.fn();
    void pending.then(settled);
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).not.toHaveBeenCalled();
    gate.resolve(["vp8", "h264", "vp9"]);
    await expect(pending).resolves.toMatchObject({ video_decode: ["vp8", "h264", "vp9"] });
  });

  it("signs the announce with the identity key scoped to host and user", async () => {
    const { identity } = setup();
    await expect(identity.buildAnnouncePayload(EPHEMERAL)).resolves.toEqual({
      public_key: EPHEMERAL,
      signature: "sig",
      identity_public_key: "device-pub",
      video_decode: ["vp8", "h264"],
    });
    expect(exportPublicKey).toHaveBeenCalledWith("pub");
    expect(getOrCreateIdentityKeyPair).toHaveBeenCalledWith("chat.example", 7);
    expect(signEphemeralKey).toHaveBeenCalledWith("priv", 7, new Uint8Array([1, 2, 3]));
  });

  it("announces unsigned without a host", async () => {
    const { identity } = setup(null);
    await expect(identity.buildAnnouncePayload(EPHEMERAL)).resolves.toEqual({
      public_key: EPHEMERAL,
      video_decode: ["vp8", "h264"],
    });
    expect(getOrCreateIdentityKeyPair).not.toHaveBeenCalled();
  });

  it("announces unsigned rather than scoping under a placeholder user id", async () => {
    auth.user = null;
    const { identity } = setup();
    await expect(identity.buildAnnouncePayload(EPHEMERAL)).resolves.toEqual({
      public_key: EPHEMERAL,
      video_decode: ["vp8", "h264"],
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
    await expect(pending).resolves.toEqual({
      public_key: EPHEMERAL,
      video_decode: ["vp8", "h264"],
    });
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
      await expect(pending).resolves.toEqual({
        public_key: EPHEMERAL,
        video_decode: ["vp8", "h264"],
      });
      expect(signEphemeralKey).not.toHaveBeenCalled();
    },
  );

  it("carries the device key even when no user id existed at auth time", async () => {
    // Fresh app start: the auth frame was built with no user id (so it went
    // without a key). auth_ok then delivers the id, and the announce, built
    // afterwards, still ends up keyed.
    auth.user = null;
    const { identity } = setup();
    const atAuth = await identity.buildAnnouncePayload(EPHEMERAL);
    expect(atAuth).not.toHaveProperty("identity_public_key");
    auth.user = { id: 7 };
    await expect(identity.buildAnnouncePayload(EPHEMERAL)).resolves.toEqual({
      public_key: EPHEMERAL,
      signature: "sig",
      identity_public_key: "device-pub",
      video_decode: ["vp8", "h264"],
    });
  });

  it("sends no key when the announce goes out unsigned", async () => {
    vi.mocked(exportPublicKey).mockRejectedValueOnce(new Error("export"));
    const { identity } = setup();
    const payload = await identity.buildAnnouncePayload(EPHEMERAL);
    expect(payload).not.toHaveProperty("identity_public_key");
    expect(payload).not.toHaveProperty("signature");
  });

  it("degrades to an unsigned announce when signing fails", async () => {
    vi.mocked(signEphemeralKey).mockRejectedValueOnce(new Error("keyring"));
    const { identity } = setup();
    await expect(identity.buildAnnouncePayload(EPHEMERAL)).resolves.toEqual({
      public_key: EPHEMERAL,
      video_decode: ["vp8", "h264"],
    });
  });
});

describe("E2EEIdentity unsigned announces", () => {
  it("carries exactly the public key and decode list when there is no host", async () => {
    const payload = await setup(null).identity.buildAnnouncePayload(EPHEMERAL);
    expect(payload).toStrictEqual({ public_key: EPHEMERAL, video_decode: ["vp8", "h264"] });
  });

  it("carries no signature field when signing fails", async () => {
    vi.mocked(signEphemeralKey).mockRejectedValueOnce(new Error("keyring"));
    const payload = await setup().identity.buildAnnouncePayload(EPHEMERAL);
    expect(payload).toStrictEqual({ public_key: EPHEMERAL, video_decode: ["vp8", "h264"] });
  });

  it("drops a signature that has no key to verify it when the export fails", async () => {
    vi.mocked(exportPublicKey).mockRejectedValueOnce(new Error("export"));
    const payload = await setup().identity.buildAnnouncePayload(EPHEMERAL);
    expect(payload).toStrictEqual({ public_key: EPHEMERAL, video_decode: ["vp8", "h264"] });
  });

  it("logs why the announce went out unsigned", async () => {
    const failure = new Error("keyring");
    vi.mocked(signEphemeralKey).mockRejectedValueOnce(failure);
    await setup().identity.buildAnnouncePayload(EPHEMERAL);
    expect(log.error).toHaveBeenCalledWith(
      "E2EE: failed to sign announce — sending unsigned",
      failure,
    );
  });

  it("logs a missing user id instead of signing", async () => {
    auth.user = null;
    await setup().identity.buildAnnouncePayload(EPHEMERAL);
    expect(log.warn).toHaveBeenCalledWith(
      "E2EE: no authenticated user id yet — announcing unsigned instead of scoping under a placeholder id",
    );
  });
});

describe("E2EEIdentity.safetyNumber", () => {
  it("is null before an identity key is loaded", async () => {
    await expect(setup().identity.safetyNumber()).resolves.toBeNull();
    expect(computeKeyFingerprint).not.toHaveBeenCalled();
  });

  it("is the fingerprint of the key the announce was signed with", async () => {
    vi.mocked(computeKeyFingerprint).mockResolvedValue("12345 67890");
    const { identity } = setup();
    await identity.buildAnnouncePayload(EPHEMERAL);
    await expect(identity.safetyNumber()).resolves.toBe("12345 67890");
    expect(computeKeyFingerprint).toHaveBeenCalledWith("pub");
  });

  it("is null again once the identity key is cleared", async () => {
    vi.mocked(computeKeyFingerprint).mockResolvedValue("12345 67890");
    const { identity } = setup();
    await identity.buildAnnouncePayload(EPHEMERAL);
    identity.clearIdentityKeyPair();
    await expect(identity.safetyNumber()).resolves.toBeNull();
  });

  it("is null, and says why, when the fingerprint cannot be computed", async () => {
    const failure = new Error("digest");
    vi.mocked(computeKeyFingerprint).mockRejectedValue(failure);
    const { identity } = setup();
    await identity.buildAnnouncePayload(EPHEMERAL);
    await expect(identity.safetyNumber()).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledWith("E2EE: could not compute own safety number", failure);
  });
});

describe("log tag", () => {
  it("keeps the E2EE log lines under their original tag", () => {
    expect(log.tags).toContain("livekitE2EE");
  });
});

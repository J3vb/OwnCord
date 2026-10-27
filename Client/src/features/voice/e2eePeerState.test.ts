import { describe, it, expect, vi, beforeEach } from "vitest";

const members = vi.hoisted(
  () => new Map<number, { identityPublicKey?: string; username?: string }>(),
);
vi.mock("../../stores/members.store", () => ({
  membersStore: { getState: () => ({ members }) },
  memberDisplayName: (m: { username: string }) => m.username,
}));
vi.mock("../../stores/voice.store", () => ({ setPeerVerification: vi.fn() }));
vi.mock("../../lib/toast", () => ({ showToast: vi.fn() }));
vi.mock("../../lib/identity", () => ({
  getIdentityPin: vi.fn(),
  storeIdentityPin: vi.fn(),
}));
vi.mock("../../lib/e2eeCrypto", () => ({
  importIdentityPublicKey: vi.fn(async (b64: string) => `idkey:${b64}`),
  verifyEphemeralKeySignature: vi.fn(),
  computeKeyFingerprint: vi.fn(async () => "safety-number"),
  computeRawKeyFingerprint: vi.fn(async () => "session-fp"),
}));
vi.mock("../../lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { setPeerVerification } from "../../stores/voice.store";
import { showToast } from "../../lib/toast";
import { getIdentityPin, storeIdentityPin } from "../../lib/identity";
import { verifyEphemeralKeySignature } from "../../lib/e2eeCrypto";
import { E2EEPeerState } from "./e2eePeerState";

const PEER = 42;
const EPHEMERAL = btoa("\x04\x05");
const current = () => true;

function setup(host: string | null = "chat.example") {
  let generation = 0;
  const peers = new E2EEPeerState({
    getServerHost: () => host,
    getSessionGeneration: () => generation,
  });
  return { peers, bumpSession: () => generation++ };
}

function lastVerification() {
  return vi.mocked(setPeerVerification).mock.lastCall?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  members.clear();
  vi.mocked(getIdentityPin).mockResolvedValue({ status: "unpinned" });
  vi.mocked(storeIdentityPin).mockResolvedValue("stored");
  vi.mocked(verifyEphemeralKeySignature).mockResolvedValue(true);
});

describe("E2EEPeerState ownership", () => {
  it("peerAttemptIsCurrent goes false when the session is torn down", () => {
    const { peers, bumpSession } = setup();
    const isCurrent = peers.peerAttemptIsCurrent(PEER);
    expect(isCurrent()).toBe(true);
    bumpSession();
    expect(isCurrent()).toBe(false);
  });

  it("peerAttemptIsCurrent goes false when that peer's membership moves on", () => {
    const { peers } = setup();
    const isCurrent = peers.peerAttemptIsCurrent(PEER);
    const other = peers.peerAttemptIsCurrent(7);
    peers.peerGenerations.set(PEER, 1);
    expect(isCurrent()).toBe(false);
    expect(other()).toBe(true);
    // A frame arriving after the move is owned by the new membership.
    expect(peers.peerAttemptIsCurrent(PEER)()).toBe(true);
  });

  it("retires keys per peer and recognises them afterwards", () => {
    const { peers } = setup();
    expect(peers.isRetiredPeerKey(PEER, "a")).toBe(false);
    peers.retirePeerKey(PEER, "a");
    peers.retirePeerKey(PEER, "b");
    expect(peers.isRetiredPeerKey(PEER, "a")).toBe(true);
    expect(peers.isRetiredPeerKey(PEER, "b")).toBe(true);
    expect(peers.isRetiredPeerKey(7, "a")).toBe(false);
    expect(peers.retiredPeerKeys.get(PEER)).toEqual(new Set(["a", "b"]));
  });

  it("lets the manager replace the pending-announce queue", () => {
    const { peers } = setup();
    peers.pendingAnnounces.push({ userId: PEER, publicKeyBase64: "k" });
    peers.pendingAnnounces = [];
    expect(peers.pendingAnnounces).toEqual([]);
    expect(peers.peerPublicKeys.size).toBe(0);
    expect(peers.blockedAnnounces.size).toBe(0);
  });
});

describe("verifyPeerAnnounce (F3 TOFU)", () => {
  it("fails closed with status unknown when the pin store is unreadable", async () => {
    vi.mocked(getIdentityPin).mockResolvedValueOnce({ status: "unavailable" });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(false);
    expect(lastVerification()).toMatchObject({ userId: PEER, status: "unknown" });
  });

  it("accepts a changed identity key that signed the announce, re-pins it and notifies once", async () => {
    vi.mocked(getIdentityPin).mockResolvedValue({ status: "pinned", pin: "old-id" });
    members.set(PEER, { identityPublicKey: "new-id", username: "alice" });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(true);
    expect(verifyEphemeralKeySignature).toHaveBeenCalledWith(
      "idkey:new-id",
      PEER,
      new Uint8Array([4, 5]),
      "sig",
    );
    expect(storeIdentityPin).toHaveBeenCalledWith("chat.example", String(PEER), "new-id");
    expect(lastVerification()).toEqual({
      userId: PEER,
      status: "changed",
      safetyNumber: "safety-number",
      sessionFingerprint: "session-fp",
    });
    expect(peers.blockedAnnounces.size).toBe(0);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(showToast).mock.lastCall?.[0]).toContain("alice");
    expect(vi.mocked(showToast).mock.lastCall?.slice(1)).toEqual(["warning", Infinity]);

    // A later announce verifies cleanly against the new pin: the badge keeps
    // showing the change for the session, and the notice is not repeated.
    vi.mocked(getIdentityPin).mockResolvedValue({ status: "pinned", pin: "new-id" });
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(true);
    expect(storeIdentityPin).toHaveBeenCalledTimes(1);
    expect(lastVerification()).toMatchObject({ status: "changed" });
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("notifies again when an already-changed peer's key changes a second time", async () => {
    vi.mocked(getIdentityPin).mockResolvedValue({ status: "pinned", pin: "old-id" });
    members.set(PEER, { identityPublicKey: "new-id", username: "alice" });
    const { peers } = setup();
    await peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current);
    expect(showToast).toHaveBeenCalledTimes(1);

    vi.mocked(getIdentityPin).mockResolvedValue({ status: "pinned", pin: "new-id" });
    members.set(PEER, { identityPublicKey: "third-id", username: "alice" });
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(true);
    expect(storeIdentityPin).toHaveBeenLastCalledWith("chat.example", String(PEER), "third-id");
    expect(showToast).toHaveBeenCalledTimes(2);
    expect(lastVerification()).toMatchObject({ status: "changed" });
  });

  it("still notifies when the peer's membership moves on while the changed key is re-pinned", async () => {
    vi.mocked(getIdentityPin).mockResolvedValue({ status: "pinned", pin: "old-id" });
    members.set(PEER, { identityPublicKey: "new-id", username: "alice" });
    const { peers } = setup();
    const isCurrent = peers.peerAttemptIsCurrent(PEER);
    vi.mocked(storeIdentityPin).mockImplementationOnce(async () => {
      peers.peerGenerations.set(PEER, 1);
      return "stored";
    });
    await peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", isCurrent);
    expect(storeIdentityPin).toHaveBeenCalledWith("chat.example", String(PEER), "new-id");
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(setPeerVerification).not.toHaveBeenCalled();
  });

  it("notifies but records nothing for the next call when the session ends during the re-pin", async () => {
    vi.mocked(getIdentityPin).mockResolvedValue({ status: "pinned", pin: "old-id" });
    members.set(PEER, { identityPublicKey: "new-id", username: "alice" });
    const { peers, bumpSession } = setup();
    const isCurrent = peers.peerAttemptIsCurrent(PEER);
    vi.mocked(storeIdentityPin).mockImplementationOnce(async () => {
      bumpSession();
      peers.keyChangedPeers.clear();
      return "stored";
    });
    await peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", isCurrent);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(peers.keyChangedPeers.size).toBe(0);

    // Next call: the announce matches the new pin, so the peer is plainly verified.
    vi.mocked(getIdentityPin).mockResolvedValue({ status: "pinned", pin: "new-id" });
    await expect(
      peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", peers.peerAttemptIsCurrent(PEER)),
    ).resolves.toBe(true);
    expect(lastVerification()).toMatchObject({ status: "verified" });
  });

  it("does not buffer a bad-signature announce whose check outlived the session", async () => {
    members.set(PEER, { identityPublicKey: "id" });
    const { peers, bumpSession } = setup();
    const isCurrent = peers.peerAttemptIsCurrent(PEER);
    vi.mocked(verifyEphemeralKeySignature).mockImplementationOnce(async () => {
      bumpSession();
      return false;
    });
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", isCurrent)).resolves.toBe(false);
    expect(peers.blockedAnnounces.size).toBe(0);
    expect(setPeerVerification).not.toHaveBeenCalled();
  });

  it("rejects a changed identity key whose announce does not verify, keeping the old pin", async () => {
    vi.mocked(getIdentityPin).mockResolvedValueOnce({ status: "pinned", pin: "old-id" });
    vi.mocked(verifyEphemeralKeySignature).mockResolvedValueOnce(false);
    members.set(PEER, { identityPublicKey: "new-id" });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(false);
    expect(lastVerification()).toMatchObject({ status: "mismatch", sessionFingerprint: null });
    expect(peers.blockedAnnounces.get(PEER)).toEqual({
      publicKeyBase64: EPHEMERAL,
      signatureBase64: "sig",
    });
    expect(storeIdentityPin).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("blocks and buffers a pinned peer whose identity key the server stripped", async () => {
    vi.mocked(getIdentityPin).mockResolvedValueOnce({ status: "pinned", pin: "old-id" });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(false);
    expect(lastVerification()).toMatchObject({ status: "mismatch" });
    expect(peers.blockedAnnounces.get(PEER)).toEqual({
      publicKeyBase64: EPHEMERAL,
      signatureBase64: "sig",
    });
    expect(storeIdentityPin).not.toHaveBeenCalled();
  });

  it("accepts a never-pinned legacy peer as unverified, never verified", async () => {
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, undefined, current)).resolves.toBe(true);
    expect(lastVerification()).toEqual({
      userId: PEER,
      status: "unverified",
      safetyNumber: null,
      sessionFingerprint: "session-fp",
    });
  });

  it("rejects a missing signature from a peer that has an identity key", async () => {
    members.set(PEER, { identityPublicKey: "id" });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, undefined, current)).resolves.toBe(
      false,
    );
    expect(verifyEphemeralKeySignature).not.toHaveBeenCalled();
    expect(lastVerification()).toMatchObject({ status: "mismatch" });
  });

  it("rejects an invalid signature", async () => {
    vi.mocked(verifyEphemeralKeySignature).mockResolvedValueOnce(false);
    members.set(PEER, { identityPublicKey: "id" });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(false);
    expect(lastVerification()).toMatchObject({ status: "mismatch" });
    expect(storeIdentityPin).not.toHaveBeenCalled();
  });

  it("pins on first sight and reports verified with the safety number", async () => {
    members.set(PEER, { identityPublicKey: "id" });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(true);
    expect(verifyEphemeralKeySignature).toHaveBeenCalledWith(
      "idkey:id",
      PEER,
      new Uint8Array([4, 5]),
      "sig",
    );
    expect(storeIdentityPin).toHaveBeenCalledWith("chat.example", String(PEER), "id");
    expect(lastVerification()).toEqual({
      userId: PEER,
      status: "verified",
      safetyNumber: "safety-number",
      sessionFingerprint: "session-fp",
    });
  });

  it("verifies against the stored pin without re-pinning", async () => {
    vi.mocked(getIdentityPin).mockResolvedValueOnce({ status: "pinned", pin: "id" });
    members.set(PEER, { identityPublicKey: "id" });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(true);
    expect(storeIdentityPin).not.toHaveBeenCalled();
    expect(lastVerification()).toMatchObject({ status: "verified" });
  });

  it("reports unverified, not verified, when the first-sight pin write fails", async () => {
    vi.mocked(storeIdentityPin).mockResolvedValueOnce("failed");
    members.set(PEER, { identityPublicKey: "id" });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(true);
    expect(lastVerification()).toMatchObject({ status: "unverified", safetyNumber: null });
  });

  it("without a host, verifies unpinned and stores nothing", async () => {
    members.set(PEER, { identityPublicKey: "id" });
    const { peers } = setup(null);
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(true);
    expect(getIdentityPin).not.toHaveBeenCalled();
    expect(storeIdentityPin).not.toHaveBeenCalled();
  });

  it("abandons a verification superseded during the pin lookup", async () => {
    members.set(PEER, { identityPublicKey: "id" });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", () => false)).resolves.toBe(
      false,
    );
    expect(setPeerVerification).not.toHaveBeenCalled();
    expect(storeIdentityPin).not.toHaveBeenCalled();
  });

  it("neither pins nor reports when superseded during signature verification", async () => {
    members.set(PEER, { identityPublicKey: "id" });
    let live = true;
    vi.mocked(verifyEphemeralKeySignature).mockImplementationOnce(async () => {
      live = false;
      return true;
    });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", () => live)).resolves.toBe(false);
    expect(storeIdentityPin).not.toHaveBeenCalled();
    expect(setPeerVerification).not.toHaveBeenCalled();
  });
});

/** A pin store that behaves like lib/identity: keys are added, never replaced. */
function statefulPins(initial: string[] = []) {
  const keys = [...initial];
  vi.mocked(getIdentityPin).mockImplementation(async () => {
    const [only] = keys;
    const newest = keys[keys.length - 1];
    if (newest === undefined || only === undefined) return { status: "unpinned" };
    return keys.length === 1
      ? { status: "pinned", pin: only }
      : { status: "pinned", pin: newest, pins: [...keys] };
  });
  vi.mocked(storeIdentityPin).mockImplementation(async (_host, _user, key) => {
    if (!keys.includes(key)) keys.push(key);
    return "stored";
  });
  return keys;
}

describe("verifyPeerAnnounce with a key per device", () => {
  it("verifies against the announce's own key, not the published one", async () => {
    members.set(PEER, { identityPublicKey: "published-id", username: "alice" });
    const { peers } = setup();
    await expect(
      peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current, "device-id"),
    ).resolves.toBe(true);
    expect(verifyEphemeralKeySignature).toHaveBeenCalledTimes(1);
    expect(verifyEphemeralKeySignature).toHaveBeenCalledWith(
      "idkey:device-id",
      PEER,
      new Uint8Array([4, 5]),
      "sig",
    );
    expect(storeIdentityPin).toHaveBeenCalledWith("chat.example", String(PEER), "device-id");
    expect(peers.announcedIdentityKey(PEER)).toBe("device-id");
  });

  it("falls back to the published key when the announce carries none (older server)", async () => {
    members.set(PEER, { identityPublicKey: "published-id", username: "alice" });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(true);
    expect(verifyEphemeralKeySignature).toHaveBeenCalledWith(
      "idkey:published-id",
      PEER,
      new Uint8Array([4, 5]),
      "sig",
    );
    expect(peers.announcedIdentityKey(PEER)).toBe("published-id");
  });

  it("drops the previous announce's key when the latest announce carries none", async () => {
    const { peers } = setup();
    await peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current, "device-id");
    expect(peers.announcedIdentityKey(PEER)).toBe("device-id");
    // Next announce: no key of its own and no published key to fall back to.
    await peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current);
    expect(peers.announcedIdentityKey(PEER)).toBeNull();
  });

  it("rejects a signature made by a different device than the announce names", async () => {
    members.set(PEER, { identityPublicKey: "published-id", username: "alice" });
    vi.mocked(verifyEphemeralKeySignature).mockImplementation(
      async (key) => key === ("idkey:published-id" as unknown),
    );
    const { peers } = setup();
    await expect(
      peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current, "device-id"),
    ).resolves.toBe(false);
    expect(lastVerification()).toMatchObject({ status: "mismatch" });
    expect(peers.blockedAnnounces.get(PEER)).toMatchObject({ identityKeyBase64: "device-id" });
  });

  it("trusts both devices of a user and shows the new-device notice once", async () => {
    statefulPins();
    members.set(PEER, { identityPublicKey: "published-id", username: "alice" });
    const { peers } = setup();

    // Device A: first sight of the user, nothing to warn about.
    await peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current, "key-a");
    expect(lastVerification()).toMatchObject({ status: "verified" });
    expect(showToast).not.toHaveBeenCalled();

    // Device B: first sight of a second key for a pinned user -> one notice.
    await peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current, "key-b");
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(showToast).mock.lastCall?.[0]).toContain("alice");
    expect(vi.mocked(showToast).mock.lastCall?.[0]).toContain("new device");
    expect(lastVerification()).toMatchObject({ status: "changed", safetyNumber: "safety-number" });

    // Back to A and to B again: both are pinned, so nothing more is shown.
    await peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current, "key-a");
    expect(lastVerification()).toMatchObject({ status: "verified" });
    await peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current, "key-b");
    await peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current, "key-a");
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(storeIdentityPin).toHaveBeenCalledTimes(2);
    expect(peers.announcedIdentityKey(PEER)).toBe("key-a");
  });

  it("stays silent when a user with two pinned devices switches the call between them", async () => {
    statefulPins(["key-a", "key-b"]);
    members.set(PEER, { identityPublicKey: "key-b", username: "alice" });
    const { peers } = setup();
    for (const key of ["key-b", "key-a", "key-b"]) {
      // oxlint-disable-next-line no-await-in-loop -- announces arrive in order
      await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current, key)).resolves.toBe(
        true,
      );
      expect(lastVerification()).toMatchObject({ status: "verified" });
    }
    expect(showToast).not.toHaveBeenCalled();
    expect(storeIdentityPin).not.toHaveBeenCalled();
  });

  it("mixed old and new clients: an old peer without a key keeps verifying against its published key", async () => {
    // The user's new device announces with its own key; their old device
    // announces nothing extra, so the published key (the same as the pin) is used.
    statefulPins(["published-id"]);
    members.set(PEER, { identityPublicKey: "published-id", username: "alice" });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(true);
    expect(lastVerification()).toMatchObject({ status: "verified" });
    expect(showToast).not.toHaveBeenCalled();
    await expect(
      peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current, "new-device-id"),
    ).resolves.toBe(true);
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});

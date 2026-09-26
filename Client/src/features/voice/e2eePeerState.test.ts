import { describe, it, expect, vi, beforeEach } from "vitest";

const members = vi.hoisted(() => new Map<number, { identityPublicKey?: string }>());
vi.mock("../../stores/members.store", () => ({
  membersStore: { getState: () => ({ members }) },
}));
vi.mock("../../stores/voice.store", () => ({ setPeerVerification: vi.fn() }));
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

  it("blocks and buffers a pinned peer whose delivered identity changed", async () => {
    vi.mocked(getIdentityPin).mockResolvedValueOnce({ status: "pinned", pin: "old-id" });
    members.set(PEER, { identityPublicKey: "new-id" });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(false);
    expect(lastVerification()).toMatchObject({ status: "mismatch", sessionFingerprint: null });
    expect(peers.blockedAnnounces.get(PEER)).toEqual({
      publicKeyBase64: EPHEMERAL,
      signatureBase64: "sig",
    });
  });

  it("blocks a pinned peer whose identity key the server stripped", async () => {
    vi.mocked(getIdentityPin).mockResolvedValueOnce({ status: "pinned", pin: "old-id" });
    const { peers } = setup();
    await expect(peers.verifyPeerAnnounce(PEER, EPHEMERAL, "sig", current)).resolves.toBe(false);
    expect(lastVerification()).toMatchObject({ status: "mismatch" });
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

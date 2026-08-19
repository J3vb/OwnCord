import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks must be declared before imports ---
// The full E2EE protocol (announce verification, TOFU pinning, rotation-on-leave,
// timeout paths) is exercised end-to-end through the LiveKitSession facade in
// livekit-session.test.ts. This file is a focused smoke test of the extracted
// E2EEManager module surface.

const mockSetKey = vi.hoisted(() => vi.fn());

vi.mock("livekit-client", () => ({
  ExternalE2EEKeyProvider: vi.fn(() => ({
    setKey: mockSetKey,
    getKeys: vi.fn().mockReturnValue([]),
  })),
}));

const mockKeyPair = vi.hoisted(() => ({
  publicKey: { type: "public" } as unknown as CryptoKey,
  privateKey: { type: "private" } as unknown as CryptoKey,
}));

const mockIdentityKeyPair = vi.hoisted(() => ({
  publicKey: { type: "id-public" } as unknown as CryptoKey,
  privateKey: { type: "id-private" } as unknown as CryptoKey,
}));

vi.mock("@lib/e2eeCrypto", () => ({
  generateECDHKeyPair: vi.fn(async () => mockKeyPair),
  exportPublicKey: vi.fn(async () => "bW9ja2VwaGVtZXJhbA=="),
  importPublicKey: vi.fn(async () => ({ type: "public" }) as unknown as CryptoKey),
  generateRoomKey: vi.fn(() => new Uint8Array(32)),
  roomKeyToBase64: vi.fn(() => "mock-room-key-base64"),
  wrapRoomKey: vi.fn(async () => ({ encryptedKey: "enc", iv: "iv" })),
  unwrapRoomKey: vi.fn(async () => ({ roomKey: new Uint8Array(32), epoch: 0 })),
  signEphemeralKey: vi.fn(async () => "mock-signature"),
  verifyEphemeralKeySignature: vi.fn(async () => true),
  importIdentityPublicKey: vi.fn(
    async () => ({ type: "id-public-imported" }) as unknown as CryptoKey,
  ),
  computeKeyFingerprint: vi.fn(async () => "AB12 CD34 EF56 7890"),
  computeRawKeyFingerprint: vi.fn(async () => "5E55 1234 5678 9ABC"),
}));

vi.mock("@lib/identity", () => ({
  getOrCreateIdentityKeyPair: vi.fn(async () => mockIdentityKeyPair),
  getIdentityPin: vi.fn(async () => ({ status: "unpinned" })),
  storeIdentityPin: vi.fn(async () => "stored"),
}));

vi.mock("@stores/auth.store", () => ({
  authStore: { getState: vi.fn(() => ({ user: { id: 1 } })) },
}));

const mockMembers = vi.hoisted(() => new Map<number, { identityPublicKey: string | null }>());

vi.mock("@stores/members.store", () => ({
  membersStore: { getState: vi.fn(() => ({ members: mockMembers })) },
}));

const mockVoiceState = vi.hoisted(() => ({
  voiceUsers: new Map<number, Map<number, unknown>>(),
}));

vi.mock("@stores/voice.store", () => ({
  voiceStore: { getState: vi.fn(() => mockVoiceState) },
  setPeerVerification: vi.fn(),
  clearPeerVerification: vi.fn(),
  clearPeerVerifications: vi.fn(),
  setLocalSessionFingerprint: vi.fn(),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Now import
import { E2EEManager } from "../../src/lib/livekitE2EE";
import {
  setPeerVerification,
  clearPeerVerification,
  setLocalSessionFingerprint,
} from "@stores/voice.store";
import {
  unwrapRoomKey,
  roomKeyToBase64,
  wrapRoomKey,
  generateECDHKeyPair,
  generateRoomKey,
  importPublicKey,
  exportPublicKey,
} from "@lib/e2eeCrypto";
import { getOrCreateIdentityKeyPair, getIdentityPin, storeIdentityPin } from "@lib/identity";
import { authStore } from "@stores/auth.store";

const PEER_ID = 42;

function createManager(ws: { send: ReturnType<typeof vi.fn> }): E2EEManager {
  return new E2EEManager({
    getWs: () => ws as never,
    getServerHost: () => "localhost:7880",
    getCurrentChannelId: () => 1,
  });
}

function sendsOfType(ws: { send: ReturnType<typeof vi.fn> }, type: string): unknown[] {
  return ws.send.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === type);
}

describe("E2EEManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMembers.clear();
    mockMembers.set(PEER_ID, { identityPublicKey: "peer-identity-b64" });
    mockVoiceState.voiceUsers.clear();
  });

  it("setupKeyExchange as key holder generates the room key and sends a signed announce", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    const ok = await mgr.setupKeyExchange(true, 1);

    expect(ok).toBe(true);
    expect(mgr.epoch).toBe(1);
    expect(mockSetKey).toHaveBeenCalledWith("mock-room-key-base64");
    const announces = sendsOfType(ws, "voice_e2ee_announce");
    expect(announces).toHaveLength(1);
    expect((announces[0] as any).payload.signature).toBe("mock-signature");
  });

  it("queues an announce before the keypair exists and drains it on setup, sending an offer", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    expect(mgr.pendingAnnounces).toHaveLength(1);
    expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);

    await mgr.setupKeyExchange(true, 1);

    // Drained through the verifying receive path and stored. The room key is
    // generated BEFORE the drain, so each drained peer gets its offer right
    // here — mid-call peers never re-announce, and the only other delivery
    // is the 5-minute rotation timer, which would strand them on a dead key
    // whenever a new key holder joins an ongoing call.
    expect(mgr.pendingAnnounces).toHaveLength(0);
    expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);
    expect(setPeerVerification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: PEER_ID, status: "verified" }),
    );
    expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(1);

    // A repeat announce after keying (dedupe path) re-sends the room-key offer.
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(2);
  });

  it("setupKeyExchange as non-key-holder resolves once the key holder's offer arrives", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    // Seed the peer's ECDH key so the offer sender is known.
    await mgr.setupKeyExchange(true, 1);
    mgr.clearState();
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    ws.send.mockClear();

    const setupPromise = mgr.setupKeyExchange(false, 1);
    // Announce goes out first so the key holder can offer immediately.
    await vi.waitFor(() => {
      expect(sendsOfType(ws, "voice_e2ee_announce").length).toBeGreaterThan(0);
    });
    await mgr.handleOffer(PEER_ID, "enc", "iv");

    await expect(setupPromise).resolves.toBe(true);
    expect(mockSetKey).toHaveBeenCalledWith("mock-room-key-base64");
  });

  it("clearState aborts a waiting key exchange so setup fails instead of hanging", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    const setupPromise = mgr.setupKeyExchange(false, 1);
    await vi.waitFor(() => {
      expect(sendsOfType(ws, "voice_e2ee_announce").length).toBeGreaterThan(0);
    });
    mgr.clearState();

    await expect(setupPromise).resolves.toBe(false);
    expect(mgr.epoch).toBe(0);
    expect(mgr.peerPublicKeys.size).toBe(0);
  });

  it("elects a still-connecting client when the holder leaves mid-setup, instead of stranding it", async () => {
    const ws = { send: vi.fn() };
    // The session publishes no channel id for the whole "connecting" phase,
    // which spans the entire key-exchange wait.
    const mgr = new E2EEManager({
      getWs: () => ws as never,
      getServerHost: () => "localhost:7880",
      getCurrentChannelId: () => null,
    });
    // After the old holder (PEER_ID) leaves, we (uid 1) are the only participant.
    mockVoiceState.voiceUsers.set(1, new Map([[1, {}]]));

    const setupPromise = mgr.setupKeyExchange(false, 1);
    await vi.waitFor(() => {
      expect(sendsOfType(ws, "voice_e2ee_announce").length).toBeGreaterThan(0);
    });

    // The holder leaves before offering, while we are still inside
    // setupKeyExchange. The re-election must use the channel id the exchange
    // was started with (getCurrentChannelId is still null) and must unblock
    // the wait — the offer we were waiting for will never arrive.
    await mgr.handleParticipantLeft(PEER_ID);

    await expect(setupPromise).resolves.toBe(true);
    expect(mgr.epoch).toBe(1); // became holder and generated a fresh key
    expect(mockSetKey).toHaveBeenCalledWith("mock-room-key-base64");
  });

  it("applies concurrent offers in arrival order, not completion order", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    await mgr.setupKeyExchange(true, 1); // establishes our keypair
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig"); // known peer
    mockSetKey.mockClear();

    // The first offer's unwrap stalls (WebCrypto gives no cross-operation
    // ordering guarantee); the second resolves immediately. Delivery order
    // must still win — otherwise the receiver ends on the first (dead) key.
    let releaseFirst!: () => void;
    const firstUnwrap = new Promise<{ roomKey: Uint8Array; epoch: number | null }>((resolve) => {
      releaseFirst = () => resolve({ roomKey: new Uint8Array(32).fill(1), epoch: 0 });
    });
    vi.mocked(unwrapRoomKey)
      .mockReturnValueOnce(firstUnwrap)
      .mockResolvedValueOnce({ roomKey: new Uint8Array(32).fill(2), epoch: 0 });
    vi.mocked(roomKeyToBase64).mockImplementation((k: Uint8Array) => `key-${k[0]}`);
    try {
      const first = mgr.handleOffer(PEER_ID, "enc1", "iv1");
      const second = mgr.handleOffer(PEER_ID, "enc2", "iv2");
      releaseFirst();
      await Promise.all([first, second]);

      // The second (newer) key must be the one left applied.
      expect(mockSetKey).toHaveBeenLastCalledWith("key-2");
    } finally {
      vi.mocked(roomKeyToBase64).mockImplementation(() => "mock-room-key-base64");
    }
  });

  it("stops rotating once it accepts an offer, so a re-elected holder is not fought", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    // We joined first, so the server elected us key holder.
    await mgr.setupKeyExchange(true, 1);
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");

    // A lower-userID participant then joined; the server re-elected them and
    // they sent us the room key. Accepting an offer proves they are the
    // server-authoritative holder (the server gates offers on IsVoiceKeyHolder).
    await mgr.handleOffer(PEER_ID, "enc", "iv");
    const epochAfterOffer = mgr.epoch;
    ws.send.mockClear();

    // The stale rotation timer must no longer rotate: the server rejects those
    // offers with NOT_KEY_HOLDER, but only after we have already applied the new
    // key locally — leaving us deaf and mute until the real holder rotates again.
    await mgr.rotateKeyPeriodically();

    expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(0);
    expect(mgr.epoch).toBe(epochAfterOffer);
  });

  it("keeps peer public keys across a reconnect so a later offer can still be unwrapped", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    await mgr.setupKeyExchange(true, 1);
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);

    await mgr.reannounceForReconnect();

    // Nothing repopulates this map after an SFU-level reconnect: handleAnnounce
    // replies with an offer rather than a counter-announce, and the server
    // relays stored peer keys only on voice_join. Peers' public keys stay valid
    // when we regenerate our own pair, so dropping them only strands us on the
    // pre-reconnect key.
    expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);

    mockSetKey.mockClear();
    await mgr.handleOffer(PEER_ID, "enc", "iv");
    expect(mockSetKey).toHaveBeenCalledWith("mock-room-key-base64");
  });

  it("rotateKeyPeriodically advances the epoch and redistributes the key to peers", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    await mgr.setupKeyExchange(true, 1);
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    ws.send.mockClear();

    await mgr.rotateKeyPeriodically();

    expect(mgr.epoch).toBe(2);
    const offers = sendsOfType(ws, "voice_e2ee_offer");
    expect(offers).toHaveLength(1);
    expect((offers[0] as any).payload.target_user_id).toBe(PEER_ID);
  });

  // ── Batch C3 findings ───────────────────────────────────────────────────

  it("[finding 1] resumes as key holder when re-elected while a prior rotation is still in flight", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    mockVoiceState.voiceUsers.set(1, new Map([[1, {}]])); // we (uid 1) are always lowest

    await mgr.setupKeyExchange(true, 1); // epoch 1, holder
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig"); // peer key known

    // Start a periodic rotation and stall it right after the epoch bump, at
    // the keyProvider.setKey await — mirrors an in-flight become-holder
    // rotation (same _rotatingKey guard).
    let releaseRotationSetKey!: () => void;
    const stall = new Promise<void>((resolve) => {
      releaseRotationSetKey = resolve;
    });
    mockSetKey.mockImplementationOnce(() => stall);
    const rotationPromise = mgr.rotateKeyPeriodically();
    expect(mgr.rotatingKey).toBe(true);
    expect(mgr.epoch).toBe(2);

    // While that rotation is in flight, an offer from the "real" elected
    // holder arrives and stands us down (handleOfferInner clears
    // _isKeyHolder but not _rotatingKey).
    await mgr.handleOffer(PEER_ID, "enc", "iv");

    // The new holder immediately leaves — we are re-elected. This must not
    // be a silent no-op just because a rotation is still in flight.
    await mgr.handleParticipantLeft(99);

    // Let the original (stalled) rotation finish.
    releaseRotationSetKey();
    await rotationPromise;

    // The re-election's finally -> drainPendingRotationOrArmTimer must have
    // run a fresh rotation as holder: one more epoch bump and key-provider
    // update beyond the two already accounted for (initial holder setup +
    // the stalled rotation).
    expect(mgr.epoch).toBe(3);
    expect(mgr.rotatingKey).toBe(false);
  });

  it("[finding 2] marks a first-sight peer 'unverified' (not 'verified') when the identity-pin write fails", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    await mgr.setupKeyExchange(true, 1); // establishes our keypair
    vi.mocked(storeIdentityPin).mockResolvedValueOnce("failed");

    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");

    expect(storeIdentityPin).toHaveBeenCalledWith(
      "localhost:7880",
      String(PEER_ID),
      "peer-identity-b64",
    );
    expect(setPeerVerification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: PEER_ID, status: "unverified", safetyNumber: null }),
    );
    expect(setPeerVerification).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: PEER_ID, status: "verified" }),
    );
  });

  it("[finding 3] discards a stale offer even when epoch is unchanged, because the keypair belongs to a cleared session", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    // Session 1 (non-key-holder): our keypair + the peer's key.
    const setup1 = mgr.setupKeyExchange(false, 1);
    await vi.waitFor(() => {
      expect(sendsOfType(ws, "voice_e2ee_announce").length).toBeGreaterThan(0);
    });
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");

    // This offer's unwrap stalls — still in flight when the user leaves voice.
    let releaseUnwrap!: (v: { roomKey: Uint8Array; epoch: number | null }) => void;
    const stalledUnwrap = new Promise<{ roomKey: Uint8Array; epoch: number | null }>((resolve) => {
      releaseUnwrap = resolve;
    });
    vi.mocked(unwrapRoomKey).mockReturnValueOnce(stalledUnwrap);
    const offerPromise = mgr.handleOffer(PEER_ID, "enc-old", "iv-old");
    await vi.waitFor(() => expect(unwrapRoomKey).toHaveBeenCalled());

    // Leave voice mid-unwrap.
    mgr.clearState();
    await expect(setup1).resolves.toBe(false);

    // A brand-new voice session generates a fresh keypair (forward secrecy).
    // Epoch is 0 in both sessions (non-key-holder never bumps it), so only
    // keypair identity can distinguish session 1's stale offer from session 2.
    const newKeyPair = {
      publicKey: { type: "public-2" } as unknown as CryptoKey,
      privateKey: { type: "private-2" } as unknown as CryptoKey,
    };
    vi.mocked(generateECDHKeyPair).mockResolvedValueOnce(newKeyPair);
    await mgr.reannounceForReconnect();
    mockSetKey.mockClear();

    // The stale session-1 offer now resolves.
    releaseUnwrap({ roomKey: new Uint8Array(32).fill(9), epoch: 0 });
    await offerPromise;

    // Must be discarded: epoch alone (0 === 0) would have let it through.
    expect(mockSetKey).not.toHaveBeenCalled();
  });

  it("[finding 4] discards a stale announce-offer if the room key rotates while wrapRoomKey is in flight", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    await mgr.setupKeyExchange(true, 1); // holder, epoch 1

    let releaseWrap!: (v: { encryptedKey: string; iv: string }) => void;
    const stalledWrap = new Promise<{ encryptedKey: string; iv: string }>((resolve) => {
      releaseWrap = resolve;
    });
    vi.mocked(wrapRoomKey).mockReturnValueOnce(stalledWrap);

    const announcePromise = mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    await vi.waitFor(() => expect(wrapRoomKey).toHaveBeenCalled());

    // A rotation completes while the announce's own wrap is still pending —
    // it sees PEER_ID already in _peerPublicKeys (stored synchronously before
    // the stalled wrap) and sends it the fresh key.
    await mgr.rotateKeyPeriodically();
    ws.send.mockClear();

    // The stale (pre-rotation) wrap now resolves.
    releaseWrap({ encryptedKey: "stale-enc", iv: "stale-iv" });
    await announcePromise;

    // Must be discarded — the peer already has the fresh key from rotation.
    expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(0);
  });

  it("[finding 5] retries with a fresh promise after a decrypt failure, so a second good offer still completes setup", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    vi.mocked(unwrapRoomKey).mockRejectedValueOnce(new Error("bad offer"));

    const setupPromise = mgr.setupKeyExchange(false, 1);
    await vi.waitFor(() => {
      expect(sendsOfType(ws, "voice_e2ee_announce").length).toBeGreaterThan(0);
    });
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");

    // A corrupt/undecryptable offer arrives — handleOfferInner's catch
    // rejects the wait.
    await mgr.handleOffer(PEER_ID, "enc-bad", "iv-bad");

    // The retry must re-announce and give a FRESH window — a second, valid
    // offer must still be able to complete setup.
    await vi.waitFor(() => {
      expect(sendsOfType(ws, "voice_e2ee_announce").length).toBeGreaterThan(1);
    });
    await mgr.handleOffer(PEER_ID, "enc-good", "iv-good");

    await expect(setupPromise).resolves.toBe(true);
  });

  it("[finding 6] queues (does not drop) a live announce that arrives during setup, before isKeyHolder/roomKey are ready", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    // Stall the identity-key load inside buildAnnouncePayload so a "live"
    // handleAnnounce can land while setup is still in its prefix — before
    // _isKeyHolder/_roomKey (and, with the fix, _ecdhKeyPair) are ready.
    let releaseIdentity!: () => void;
    const stalledIdentity = new Promise<typeof mockIdentityKeyPair>((resolve) => {
      releaseIdentity = () => resolve(mockIdentityKeyPair);
    });
    vi.mocked(getOrCreateIdentityKeyPair).mockReturnValueOnce(stalledIdentity);

    const setupPromise = mgr.setupKeyExchange(true, 1); // becoming key holder
    await vi.waitFor(() => expect(getOrCreateIdentityKeyPair).toHaveBeenCalled());

    // A peer announces "live" (server-relayed) while our own setup is still
    // in flight.
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");

    releaseIdentity();
    await setupPromise;

    // The peer must receive a room-key offer — either queued-then-drained, or
    // handled live after isKeyHolder/roomKey became ready. It must never be
    // silently stored with no offer ever sent.
    expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);
    expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(1);
  });

  // ── Batch ts:livekit-e2ee findings ──────────────────────────────────────

  it("[finding v011] keeps the mismatch block when the re-pin write fails", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    vi.mocked(storeIdentityPin).mockResolvedValueOnce("failed");

    const result = await mgr.rePinPeerIdentity(PEER_ID, "verified-key-b64");

    // A failed write must not report the re-pin as successful — the OLD pin
    // is still on disk, so clearing the mismatch block here would let the
    // UI claim trust was re-established when it wasn't.
    expect(result).toBe(false);
    expect(clearPeerVerification).not.toHaveBeenCalled();
  });

  it("[finding v011] clears the mismatch block when the re-pin write succeeds", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    const result = await mgr.rePinPeerIdentity(PEER_ID, "verified-key-b64");

    expect(result).toBe(true);
    expect(clearPeerVerification).toHaveBeenCalledWith(PEER_ID);
  });

  it("[finding v043] a superseded attempt's retry guard checks keypair ownership, not just null, so it never re-announces a dead key over a live session", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    const keypairA = {
      publicKey: { type: "pubA" } as unknown as CryptoKey,
      privateKey: { type: "privA" } as unknown as CryptoKey,
    };
    const keypairB = {
      publicKey: { type: "pubB" } as unknown as CryptoKey,
      privateKey: { type: "privB" } as unknown as CryptoKey,
    };
    vi.mocked(generateECDHKeyPair).mockResolvedValueOnce(keypairA).mockResolvedValueOnce(keypairB);

    // Session A: non-key-holder, waiting for the key holder's offer.
    const setupA = mgr.setupKeyExchange(false, 1);
    await vi.waitFor(() => {
      expect(sendsOfType(ws, "voice_e2ee_announce").length).toBeGreaterThan(0);
    });

    // Session A is superseded by a fresh session B (e.g. the user left and
    // rejoined) before A's 10s window elapses. B publishes its own keypair,
    // overwriting A's — a plain `=== null` check on _ecdhKeyPair can't see
    // this, since it is now non-null (B's).
    const setupB = mgr.setupKeyExchange(true, 2);
    await expect(setupB).resolves.toBe(true);

    // Re-populate the peer key B's setup wiped, so a decrypt failure can
    // reach A's still-installed rejector without an early return.
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    ws.send.mockClear();

    // A corrupt offer rejects A's still-pending roomKeyPromise via its
    // rejector — the only field B's (key-holder) setup never touches.
    vi.mocked(unwrapRoomKey).mockRejectedValueOnce(new Error("bad offer"));
    await mgr.handleOffer(PEER_ID, "enc-bad", "iv-bad");

    // A must give up instead of re-announcing its dead ephemeral key over
    // B's live session and reinstalling a resolver nothing will ever call.
    await expect(setupA).resolves.toBe(false);
    expect(sendsOfType(ws, "voice_e2ee_announce")).toHaveLength(0);
  });

  it("[finding v043] a superseded setup does not wipe the live session's peer keys", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    // Attempt A stalls inside generateECDHKeyPair — before it has written
    // anything, so clearState() has no rejector to reject and A survives its
    // own teardown.
    let releaseGen!: (v: CryptoKeyPair) => void;
    const stalledGen = new Promise<CryptoKeyPair>((resolve) => {
      releaseGen = resolve;
    });
    vi.mocked(generateECDHKeyPair).mockReturnValueOnce(stalledGen);
    const setupA = mgr.setupKeyExchange(false, 1);
    await vi.waitFor(() => expect(generateECDHKeyPair).toHaveBeenCalled());

    // The user leaves and joins another channel; that session completes and
    // learns a peer's ECDH key.
    mgr.clearState();
    await expect(mgr.setupKeyExchange(true, 2)).resolves.toBe(true);
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");

    // Attempt A only now resumes, long after its own teardown.
    releaseGen({
      publicKey: { type: "stale-pub" } as unknown as CryptoKey,
      privateKey: { type: "stale-priv" } as unknown as CryptoKey,
    });
    await expect(setupA).resolves.toBe(false);

    // The live session's peer key must survive: nothing repopulates this map
    // mid-call, so clearing it here would make handleOffer's unknown-peer
    // guard drop every later rotation from that peer.
    expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);
  });

  it("[finding v043] a superseded setup does not clobber the live session's key-holder role", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    // Attempt A (non-key-holder) stalls inside buildAnnouncePayload's keyring
    // round trip — the widest pre-publication window.
    let releaseIdentity!: () => void;
    const stalledIdentity = new Promise<typeof mockIdentityKeyPair>((resolve) => {
      releaseIdentity = () => resolve(mockIdentityKeyPair);
    });
    vi.mocked(getOrCreateIdentityKeyPair).mockReturnValueOnce(stalledIdentity);
    const setupA = mgr.setupKeyExchange(false, 1);
    await vi.waitFor(() => expect(getOrCreateIdentityKeyPair).toHaveBeenCalled());

    // The user leaves and joins another channel as key holder.
    mgr.clearState();
    await expect(mgr.setupKeyExchange(true, 2)).resolves.toBe(true);
    const epochAfterLiveSetup = mgr.epoch;

    releaseIdentity();
    await expect(setupA).resolves.toBe(false);
    ws.send.mockClear();

    // A's `_isKeyHolder = false` must never land on the live session: it
    // would silently stop its rotations AND its offers to peers that
    // announce later, with nothing to re-elect it.
    expect(mgr.epoch).toBe(epochAfterLiveSetup);
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(1);
  });

  it("[finding v015] applies concurrent announces in arrival order, not completion order", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    await mgr.setupKeyExchange(true, 1); // establishes our keypair + room key

    // The first announce's key import stalls; the second is unimpeded. WS
    // delivery order must still win — otherwise _peerPublicKeys ends up on
    // the peer's superseded key and every later rotation is wrapped for a
    // private key they no longer hold.
    const keyOne = { type: "peer-key-1" } as unknown as CryptoKey;
    const keyTwo = { type: "peer-key-2" } as unknown as CryptoKey;
    let releaseFirst!: (v: CryptoKey) => void;
    const firstImport = new Promise<CryptoKey>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(importPublicKey).mockReturnValueOnce(firstImport).mockResolvedValueOnce(keyTwo);

    const first = mgr.handleAnnounce(PEER_ID, "b2xk", "sig1");
    const second = mgr.handleAnnounce(PEER_ID, "bmV3", "sig2");
    // Drain every pending microtask: unserialized, the second announce runs
    // to completion right here while the first is still stalled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirst(keyOne);
    await Promise.all([first, second]);

    expect(mgr.peerPublicKeys.get(PEER_ID)).toBe(keyTwo);
  });

  it("[finding v093] does not resurrect the keypair or send a stray announce if clearState() runs during reannounceForReconnect", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    await mgr.setupKeyExchange(true, 1);
    ws.send.mockClear();

    let releaseGen!: (v: CryptoKeyPair) => void;
    const stalledGen = new Promise<CryptoKeyPair>((resolve) => {
      releaseGen = resolve;
    });
    vi.mocked(generateECDHKeyPair).mockReturnValueOnce(stalledGen);

    const reconnectPromise = mgr.reannounceForReconnect();
    await vi.waitFor(() => expect(generateECDHKeyPair).toHaveBeenCalled());

    // The user disconnects while the reconnect's keypair generation is
    // still in flight.
    mgr.clearState();

    releaseGen({
      publicKey: { type: "reconnect-pub" } as unknown as CryptoKey,
      privateKey: { type: "reconnect-priv" } as unknown as CryptoKey,
    });
    await reconnectPromise;

    // Must not resurrect the torn-down keypair or send a stray announce for
    // a channel we already left.
    expect((mgr as unknown as { _ecdhKeyPair: unknown })._ecdhKeyPair).toBeNull();
    expect(sendsOfType(ws, "voice_e2ee_announce")).toHaveLength(0);
  });

  it("[finding v101] discards a stale announce-offer if the keypair (not epoch) changes while wrapRoomKey is in flight", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    await mgr.setupKeyExchange(true, 1); // holder, epoch 1

    let releaseWrap!: (v: { encryptedKey: string; iv: string }) => void;
    const stalledWrap = new Promise<{ encryptedKey: string; iv: string }>((resolve) => {
      releaseWrap = resolve;
    });
    vi.mocked(wrapRoomKey).mockReturnValueOnce(stalledWrap);

    const announcePromise = mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    await vi.waitFor(() => expect(wrapRoomKey).toHaveBeenCalled());

    // A concurrent reconnect swaps the keypair WITHOUT bumping the epoch —
    // an epoch-only staleness check would miss this entirely.
    vi.mocked(generateECDHKeyPair).mockResolvedValueOnce({
      publicKey: { type: "public-2" } as unknown as CryptoKey,
      privateKey: { type: "private-2" } as unknown as CryptoKey,
    });
    await mgr.reannounceForReconnect();
    ws.send.mockClear();

    // The stale (pre-reconnect) wrap now resolves.
    releaseWrap({ encryptedKey: "stale-enc", iv: "stale-iv" });
    await announcePromise;

    expect(mgr.epoch).toBe(1); // epoch never moved — proves the epoch-only check would miss this
    expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(0);
  });

  it("[finding v045] aborts room-key distribution mid-loop when a concurrent reconnect swaps the keypair", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    mockVoiceState.voiceUsers.set(1, new Map([[1, {}]])); // we (uid 1) are always lowest

    await mgr.setupKeyExchange(true, 1); // epoch 1, holder
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    await mgr.handleAnnounce(PEER_ID + 1, "cGVlcjI=", "sig2");

    // A lower-userID peer's offer stands us down (mirrors the "stops
    // rotating" test above), so the next participant-left re-elects us.
    await mgr.handleOffer(PEER_ID, "enc", "iv");
    expect(mgr.rotatingKey).toBe(false);

    // Stall the first peer's wrap in the become-holder redistribution loop.
    // (wrapRoomKey was already called twice above, wrapping for each peer's
    // announce — clear that history so the count below tracks only the
    // redistribution loop.)
    vi.mocked(wrapRoomKey).mockClear();
    let releaseWrap!: (v: { encryptedKey: string; iv: string }) => void;
    const stalledWrap = new Promise<{ encryptedKey: string; iv: string }>((resolve) => {
      releaseWrap = resolve;
    });
    vi.mocked(wrapRoomKey).mockReturnValueOnce(stalledWrap);

    const leftPromise = mgr.handleParticipantLeft(99); // re-elects us as holder
    await vi.waitFor(() => expect(wrapRoomKey).toHaveBeenCalledTimes(1));
    ws.send.mockClear();

    // A concurrent reconnect swaps the keypair mid-loop, without bumping
    // the epoch.
    vi.mocked(generateECDHKeyPair).mockResolvedValueOnce({
      publicKey: { type: "reconnect-pub" } as unknown as CryptoKey,
      privateKey: { type: "reconnect-priv" } as unknown as CryptoKey,
    });
    await mgr.reannounceForReconnect();
    ws.send.mockClear();

    releaseWrap({ encryptedKey: "stale-enc", iv: "stale-iv" });
    await leftPromise;

    // Neither peer should receive an offer wrapped under the abandoned
    // keypair — the loop must abort as soon as it notices the swap.
    expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(0);
  });

  // ── Batch B3 findings ───────────────────────────────────────────────────

  it("[B3-2] preserves a key-holder promotion that lands during setupKeyExchange's pre-publish awaits, instead of clobbering it with the stale server value", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    // After the real holder (PEER_ID) leaves, we (uid 1) are the only
    // remaining participant — client-side election promotes us.
    mockVoiceState.voiceUsers.set(1, new Map([[1, {}]]));

    // Stall the identity-key load inside buildAnnouncePayload so a
    // participant-left promotion can land BEFORE setupKeyExchange assigns
    // this._isKeyHolder from the (now-stale) server value.
    let releaseIdentity!: () => void;
    const stalledIdentity = new Promise<typeof mockIdentityKeyPair>((resolve) => {
      releaseIdentity = () => resolve(mockIdentityKeyPair);
    });
    vi.mocked(getOrCreateIdentityKeyPair).mockReturnValueOnce(stalledIdentity);

    // Server said we are NOT the key holder when we started joining...
    const setupPromise = mgr.setupKeyExchange(false, 1);
    await vi.waitFor(() => expect(getOrCreateIdentityKeyPair).toHaveBeenCalled());

    // ...but the real holder leaves before we finish setting up, and since we
    // are the only participant left, client-side election promotes us.
    await mgr.handleParticipantLeft(PEER_ID);

    releaseIdentity();
    // On the buggy path this falls through to the non-holder wait-for-offer
    // branch and burns the full 10s + 5s timeout before resolving false —
    // fast-forward past it so the test does not block on a real 15s wait.
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(20_000);
    } finally {
      vi.useRealTimers();
    }

    // The promotion must win: we end up as key holder (generated + applied a
    // room key and announced) instead of waiting for an offer that only WE
    // could have sent — the exact interleaving that times out and gets the
    // joiner ejected from voice.
    await expect(setupPromise).resolves.toBe(true);
    expect(mockSetKey).toHaveBeenCalledWith("mock-room-key-base64");
  });

  it("[B3-7] does not resurrect peer key/verification state into a torn-down session when clearState() runs during verifyPeerAnnounce's pin lookup", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    await mgr.setupKeyExchange(true, 1); // establishes our keypair

    let releasePin!: (v: { status: "unpinned" }) => void;
    const stalledPin = new Promise<{ status: "unpinned" }>((resolve) => {
      releasePin = resolve;
    });
    vi.mocked(getIdentityPin).mockReturnValueOnce(stalledPin);

    const announcePromise = mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    await vi.waitFor(() => expect(getIdentityPin).toHaveBeenCalled());

    // Disconnect mid-verify.
    mgr.clearState();
    vi.mocked(setPeerVerification).mockClear();

    releasePin({ status: "unpinned" });
    await announcePromise;

    // The torn-down session's peer map and verification state must not be
    // resurrected by a continuation that resumes after teardown.
    expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);
    expect(setPeerVerification).not.toHaveBeenCalled();
  });

  it("[identity-scope guard] does not mint an identity keypair when no user is authenticated yet — announce goes out unsigned instead of under a placeholder host:0 scope", async () => {
    // If this ever ran before auth state landed, falling back to `?? 0`
    // would mint (or migrate-and-DELETE the real legacy key into) a bogus
    // `host:0` keyring scope; the ready hook's later, authenticated call
    // then mints a SECOND, DIFFERENT keypair under `host:<realId>` — so the
    // published key and the announce signing key permanently disagree and
    // every peer's verifyPeerAnnounce reports a false MITM "mismatch".
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    vi.mocked(authStore.getState).mockReturnValueOnce({ user: null } as never);

    const ok = await mgr.setupKeyExchange(true, 1);

    expect(ok).toBe(true);
    expect(getOrCreateIdentityKeyPair).not.toHaveBeenCalled();
    const announces = sendsOfType(ws, "voice_e2ee_announce");
    expect(announces).toHaveLength(1);
    // Same contract as "no server host": degrade to an unsigned announce
    // rather than sign/scope under a placeholder id.
    expect((announces[0] as any).payload.signature).toBeUndefined();
  });

  // ── Ledger findings OC-0098 / OC-0004 / OC-0006 / OC-0005 / OC-0007 ──

  it("[OC-0098] sends its own announce before offering the room key to a drained peer", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    // A peer's announce arrives (relayed by voice_join sync) before our own
    // keypair is ready — it queues.
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    expect(mgr.pendingAnnounces).toHaveLength(1);

    // We become key holder and drain the queued announce, which sends that
    // peer a voice_e2ee_offer. The peer can only unwrap it if it already has
    // OUR ephemeral public key on file — which only our own announce
    // provides. Both land in the same inbound WS queue on the peer's side,
    // so the order we send them in here IS the order they arrive there.
    await mgr.setupKeyExchange(true, 1);

    const calls = ws.send.mock.calls.map((c) => c[0] as { type: string });
    const announceIndex = calls.findIndex((m) => m.type === "voice_e2ee_announce");
    const offerIndex = calls.findIndex((m) => m.type === "voice_e2ee_offer");
    expect(announceIndex).toBeGreaterThanOrEqual(0);
    expect(offerIndex).toBeGreaterThanOrEqual(0);
    expect(announceIndex).toBeLessThan(offerIndex);
  });

  it("[OC-0004] elects us key holder on a participant-left even when our own voice_state hasn't landed in the roster yet", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws); // getCurrentChannelId() => 1
    // mockVoiceState.voiceUsers has NO entry for channel 1: our own
    // voice_state broadcast hasn't landed (it's still queued behind the
    // leaver's on the server), and the leaver's own roster entry was just
    // deleted by removeVoiceUser before this handler runs.
    expect(mockVoiceState.voiceUsers.has(1)).toBe(false);

    await mgr.handleParticipantLeft(PEER_ID);

    // Client-side election must still run using our own authenticated id
    // (uid 1) even though the local roster has nothing recorded for the
    // channel yet — otherwise the server's promotion is silently missed and
    // the join that provoked it times out 15s later.
    expect(mgr.epoch).toBe(1);
    expect(mockSetKey).toHaveBeenCalledWith("mock-room-key-base64");
  });

  it("[OC-0006] self-heals the shared key provider when a rotation's setKey resolves after clearState() tore the session down", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    mockVoiceState.voiceUsers.set(1, new Map([[1, {}]]));

    await mgr.setupKeyExchange(true, 1); // epoch 1, holder

    vi.mocked(roomKeyToBase64).mockImplementation((k: Uint8Array) => `key-${k[0]}`);
    try {
      vi.mocked(generateRoomKey).mockReturnValueOnce(new Uint8Array(32).fill(9)); // this rotation's key
      let releaseStale!: () => void;
      const staleSetKey = new Promise<void>((resolve) => {
        releaseStale = resolve;
      });
      mockSetKey.mockImplementationOnce(() => staleSetKey);

      const rotationPromise = mgr.rotateKeyPeriodically();
      await vi.waitFor(() => expect(mockSetKey).toHaveBeenCalledWith("key-9"));

      // The session is torn down (user hit Disconnect) while that setKey
      // call is still in flight, and a brand-new session becomes holder
      // with its OWN key before the stale call resolves.
      mgr.clearState();
      vi.mocked(generateRoomKey).mockReturnValueOnce(new Uint8Array(32).fill(7)); // live session's key
      mockSetKey.mockClear();
      await mgr.setupKeyExchange(true, 2);
      expect(mockSetKey).toHaveBeenCalledWith("key-7");
      mockSetKey.mockClear();

      // The abandoned rotation's setKey call now resolves.
      releaseStale();
      await rotationPromise;

      // The shared key provider must end up on the LIVE session's key, not
      // silently left on the abandoned one — narrow race, but real: nothing
      // else re-applies the live key once the stale call lands.
      expect(mockSetKey).toHaveBeenCalledWith("key-7");
    } finally {
      vi.mocked(roomKeyToBase64).mockImplementation(() => "mock-room-key-base64");
    }
  });

  it("[OC-0005] paces room-key offers so a large channel's rotation stays under the server's per-second rate limit", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    mockVoiceState.voiceUsers.set(1, new Map([[1, {}]]));
    await mgr.setupKeyExchange(true, 1); // holder

    // Seed 62 peers directly — well past the server's 64/sec cap for a
    // single rotation's worth of offers.
    for (let i = 0; i < 62; i++) {
      mgr.peerPublicKeys.set(1000 + i, { type: `peer-${i}` } as unknown as CryptoKey);
    }
    ws.send.mockClear();

    vi.useFakeTimers();
    try {
      const rotationPromise = mgr.rotateKeyPeriodically();
      // Let every microtask-bound send that doesn't need a real timer run.
      await vi.advanceTimersByTimeAsync(0);
      const sentBeforePause = sendsOfType(ws, "voice_e2ee_offer").length;
      // Must not have blown through the whole 62 in one burst.
      expect(sentBeforePause).toBeLessThan(62);
      expect(sentBeforePause).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(2000);
      await rotationPromise;

      expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(62);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[OC-0155] shares the offer-pacing budget across back-to-back rotations instead of resetting it per call", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    mockVoiceState.voiceUsers.set(1, new Map([[1, {}]]));
    await mgr.setupKeyExchange(true, 1); // holder

    // Seed 40 peers — under the server's 60-offer cap for a SINGLE rotation,
    // but two back-to-back rotations of 40 each (80 offers total) blow
    // through the server's shared per-second window if each rotation gets
    // its own fresh pacing budget instead of sharing one.
    for (let i = 0; i < 40; i++) {
      mgr.peerPublicKeys.set(2000 + i, { type: `peer-${i}` } as unknown as CryptoKey);
    }
    ws.send.mockClear();

    // A second keyed-peer leave lands while this rotation is conceptually
    // in flight — drainPendingRotationOrArmTimer (livekitE2EE.ts:1256-1263)
    // runs a second rotation immediately once this one finishes, exactly
    // like handleParticipantLeft's wasKeyHolder branch does.
    mgr.rotationPending = true;

    vi.useFakeTimers();
    try {
      const rotationPromise = mgr.rotateKeyPeriodically();
      // Let every microtask-bound send that doesn't need a real timer run —
      // this covers BOTH rotations if neither individually hits the cap.
      await vi.advanceTimersByTimeAsync(0);
      const sentBeforePause = sendsOfType(ws, "voice_e2ee_offer").length;
      // The combined 80 offers across both rotations must not all go out
      // unpaced just because neither rotation's own 40-offer batch exceeds
      // the 60 cap in isolation — the budget must be shared.
      expect(sentBeforePause).toBeLessThanOrEqual(60);

      await vi.advanceTimersByTimeAsync(2000);
      await rotationPromise;

      // Both rotations' offers (40 + 40) eventually go out.
      expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(80);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[OC-0167] paces announce-driven offers through the same shared budget as rotation offers", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    // 70 existing participants' announces are relayed to the future key
    // holder before its own keypair is ready — exactly what voiceJoinComplete
    // does for a joiner elected key holder in a large ongoing channel
    // (Server/ws/voice_join.go:490-495). They queue.
    for (let i = 0; i < 70; i++) {
      await mgr.handleAnnounce(3000 + i, "cGVlcg==", "sig");
    }
    expect(mgr.pendingAnnounces).toHaveLength(70);

    mockVoiceState.voiceUsers.set(1, new Map([[1, {}]]));
    ws.send.mockClear();

    vi.useFakeTimers();
    try {
      // setupKeyExchange generates the room key, then drains all 70 queued
      // announces in a tight loop — each drained announce sends a
      // voice_e2ee_offer directly (handleAnnounceInner), bypassing
      // distributeRoomKey's pacing entirely.
      const setupPromise = mgr.setupKeyExchange(true, 1);
      await vi.advanceTimersByTimeAsync(0);
      const sentBeforePause = sendsOfType(ws, "voice_e2ee_offer").length;
      // Must not blow through all 70 announce-driven offers in one unpaced
      // burst.
      expect(sentBeforePause).toBeLessThan(70);
      expect(sentBeforePause).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(2000);
      await setupPromise;

      expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(70);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Ledger findings OC-0010 / OC-0011 ─────────────────────────────────

  it("[OC-0010] does not stand down a new session's key-holder role when a stale offer's setKey resolves after teardown+rejoin", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    // Session A: we are the holder in channel 1, with PEER_ID's key on file.
    await mgr.setupKeyExchange(true, 1);
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");

    // An offer from PEER_ID arrives and stalls at the keyProvider.setKey
    // await — AFTER the epoch/keypair guard (checked right after unwrap) has
    // already passed.
    let releaseSetKey!: () => void;
    const stalledSetKey = new Promise<void>((resolve) => {
      releaseSetKey = resolve;
    });
    mockSetKey.mockClear();
    mockSetKey.mockImplementationOnce(() => stalledSetKey);
    const offerPromise = mgr.handleOffer(PEER_ID, "enc", "iv");
    await vi.waitFor(() => expect(mockSetKey).toHaveBeenCalled());

    // Mid-flight: the user leaves channel 1 and rejoins channel 2 as the new
    // key holder — a distinct keypair, exactly as real ECDH keygen produces.
    mgr.clearState();
    vi.mocked(generateECDHKeyPair).mockResolvedValueOnce({
      publicKey: { type: "chan2-pub" } as unknown as CryptoKey,
      privateKey: { type: "chan2-priv" } as unknown as CryptoKey,
    });
    await mgr.setupKeyExchange(true, 2);
    expect((mgr as unknown as { _isKeyHolder: boolean })._isKeyHolder).toBe(true);

    // The stale (session-1) offer's setKey now resolves.
    releaseSetKey();
    await offerPromise;

    // Channel 2's holder role must survive — the stale continuation must not
    // stand it down (it re-checks staleness before the setKey await, not
    // after — the write happens on the far side of that await).
    expect((mgr as unknown as { _isKeyHolder: boolean })._isKeyHolder).toBe(true);
  });

  it("[OC-0010] does not write a stale peer key into a new session's map when clearState()+rejoin lands during the announce's key-import await", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    // Session A: holder in channel 1.
    await mgr.setupKeyExchange(true, 1);

    // The announce's importPublicKey stalls — the "final await" before the
    // _peerPublicKeys.set write, which today has no re-check after it.
    let releaseImport!: (v: CryptoKey) => void;
    const stalledImport = new Promise<CryptoKey>((resolve) => {
      releaseImport = resolve;
    });
    vi.mocked(importPublicKey).mockReturnValueOnce(stalledImport);

    const announcePromise = mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    await vi.waitFor(() => expect(importPublicKey).toHaveBeenCalled());

    // Mid-flight: the user leaves channel 1 and rejoins channel 2.
    mgr.clearState();
    await mgr.setupKeyExchange(true, 2);

    // The stale announce's import now resolves.
    releaseImport({ type: "stale-peer-key" } as unknown as CryptoKey);
    await announcePromise;

    // The new session's peer map must not be polluted by the torn-down
    // session's announce.
    expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);
  });

  it("[OC-0011] rejects a replayed announce carrying a previously-retired peer key instead of overwriting the live key", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    await mgr.setupKeyExchange(true, 1); // establishes our keypair

    // Make import/export round-trip faithfully on the announced base64
    // string (the shared mock default returns a fixed constant from
    // exportPublicKey regardless of input, which would mask this bug).
    vi.mocked(importPublicKey).mockImplementation(
      async (b64: string) => ({ type: `peer-key-${b64}` }) as unknown as CryptoKey,
    );
    vi.mocked(exportPublicKey).mockImplementation(async (key: CryptoKey) =>
      (key as unknown as { type: string }).type.replace("peer-key-", ""),
    );

    // Valid base64 (must decode cleanly — rawFromBase64 uses atob() to build
    // the signed message bytes). "b2xk"/"bmV3" already prove out elsewhere in
    // this suite as distinct valid ephemeral-key payloads.
    const KEY_A = "b2xk";
    const KEY_B = "bmV3";

    try {
      // Peer announces key A — accepted as their first (live) key.
      await mgr.handleAnnounce(PEER_ID, KEY_A, "sigA");
      expect(mgr.peerPublicKeys.get(PEER_ID)).toEqual({ type: `peer-key-${KEY_A}` });

      // Peer reconnects and announces a genuinely new key B — a legitimate
      // change, so key A is now retired.
      await mgr.handleAnnounce(PEER_ID, KEY_B, "sigB");
      expect(mgr.peerPublicKeys.get(PEER_ID)).toEqual({ type: `peer-key-${KEY_B}` });

      // A malicious relay re-emits the OLD, still validly-signed announce for
      // key A. No channel/epoch/nonce binds the signed message, so it
      // verifies cleanly — it must still be rejected as a replay, not
      // overwrite the live key B.
      await mgr.handleAnnounce(PEER_ID, KEY_A, "sigA");

      expect(mgr.peerPublicKeys.get(PEER_ID)).toEqual({ type: `peer-key-${KEY_B}` });
    } finally {
      vi.mocked(importPublicKey).mockImplementation(
        async () => ({ type: "public" }) as unknown as CryptoKey,
      );
      vi.mocked(exportPublicKey).mockImplementation(async () => "bW9ja2VwaGVtZXJhbA==");
    }
  });

  it("[OC-0007] confirms the room key after a reconnect re-announce instead of declaring it fresh unconditionally", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    // Non-key-holder session with an already-established room key from
    // before the (simulated) disconnect.
    await mgr.setupKeyExchange(true, 1);
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig"); // peer key known, so the offer below is accepted
    await mgr.handleOffer(PEER_ID, "enc", "iv"); // stands us down — now a non-holder
    ws.send.mockClear();

    vi.useFakeTimers();
    try {
      await mgr.reannounceForReconnect();
      // Nothing has confirmed the re-applied key is current yet. If the
      // holder's fresh offer never arrives, this must not be a silent,
      // unbounded wait for the next 5-minute rotation — it must retry.
      await vi.advanceTimersByTimeAsync(6000);

      const announces = sendsOfType(ws, "voice_e2ee_announce");
      expect(announces.length).toBeGreaterThan(1); // the reconnect announce PLUS a retry
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Ledger findings OC-0002 / OC-0020 ─────────────────────────────────

  it("[OC-0002] applies an offer that arrives while its sender's own announce is still verifying, instead of dropping it as an unknown peer", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    // We were previously key holder (mirrors B in the repro): own keypair +
    // room key already established.
    await mgr.setupKeyExchange(true, 1);
    mockSetKey.mockClear();
    vi.mocked(unwrapRoomKey).mockClear();

    // Stall the identity-pin lookup inside verifyPeerAnnounce so the
    // announce is still mid-flight (queued on _announceChain, not yet
    // applied to _peerPublicKeys) when the offer from the SAME sender
    // arrives right behind it — exactly the WS delivery order OC-0098
    // guarantees the sender used.
    let releasePin!: (v: { status: "unpinned" }) => void;
    const stalledPin = new Promise<{ status: "unpinned" }>((resolve) => {
      releasePin = resolve;
    });
    vi.mocked(getIdentityPin).mockReturnValueOnce(stalledPin);

    const announcePromise = mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    await vi.waitFor(() => expect(getIdentityPin).toHaveBeenCalled());

    // The offer is dispatched immediately behind the announce, before the
    // announce has stored the peer's ECDH key.
    const offerPromise = mgr.handleOffer(PEER_ID, "enc", "iv");

    releasePin({ status: "unpinned" });
    await Promise.all([announcePromise, offerPromise]);

    // The offer must have been applied once the announce (which arrived
    // first) finished verifying — not silently dropped as "unknown peer"
    // with no retry until the next 5-minute rotation.
    expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);
    expect(unwrapRoomKey).toHaveBeenCalled();
    expect(mockSetKey).toHaveBeenCalledWith("mock-room-key-base64");
  });

  it("[OC-0020] retires a departed peer's key on leave, so a replay of it after they rejoin with a fresh key cannot resurrect it", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    await mgr.setupKeyExchange(true, 1); // establishes our keypair, holder

    // Make import/export round-trip faithfully on the announced base64
    // string (the shared mock default returns a fixed constant regardless
    // of input, which would mask this bug).
    vi.mocked(importPublicKey).mockImplementation(
      async (b64: string) => ({ type: `peer-key-${b64}` }) as unknown as CryptoKey,
    );
    vi.mocked(exportPublicKey).mockImplementation(async (key: CryptoKey) =>
      (key as unknown as { type: string }).type.replace("peer-key-", ""),
    );

    const KEY_A = "b2xk";
    const KEY_B = "bmV3";

    try {
      // Peer announces key A — accepted as their first (live) key.
      await mgr.handleAnnounce(PEER_ID, KEY_A, "sigA");
      expect(mgr.peerPublicKeys.get(PEER_ID)).toEqual({ type: `peer-key-${KEY_A}` });

      // Peer leaves the channel.
      await mgr.handleParticipantLeft(PEER_ID);
      expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);

      // Peer rejoins and announces a fresh key B.
      await mgr.handleAnnounce(PEER_ID, KEY_B, "sigB");
      expect(mgr.peerPublicKeys.get(PEER_ID)).toEqual({ type: `peer-key-${KEY_B}` });

      // A malicious relay re-emits the pre-leave, still validly-signed
      // announce for key A. No channel/epoch/nonce binds the signed
      // message, so it verifies cleanly — it must still be rejected as a
      // replay of a retired key, not overwrite the live key B.
      await mgr.handleAnnounce(PEER_ID, KEY_A, "sigA");

      expect(mgr.peerPublicKeys.get(PEER_ID)).toEqual({ type: `peer-key-${KEY_B}` });
    } finally {
      vi.mocked(importPublicKey).mockImplementation(
        async () => ({ type: "public" }) as unknown as CryptoKey,
      );
      vi.mocked(exportPublicKey).mockImplementation(async () => "bW9ja2VwaGVtZXJhbA==");
    }
  });

  // ── OC-0001: per-sender offer epoch high-water mark ───────────────────────

  const unwrapAt = (epoch: number | null, fill = 1) =>
    vi.mocked(unwrapRoomKey).mockResolvedValueOnce({
      roomKey: new Uint8Array(32).fill(fill),
      epoch,
    });

  async function holderWithPeer(): Promise<{
    ws: { send: ReturnType<typeof vi.fn> };
    mgr: E2EEManager;
  }> {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    await mgr.setupKeyExchange(true, 1);
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    mockSetKey.mockClear();
    vi.mocked(roomKeyToBase64).mockImplementation((k: Uint8Array) => `key-${k[0]}`);
    return { ws, mgr };
  }

  it("[OC-0001] wraps each offer with the sender's current epoch", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    await mgr.setupKeyExchange(true, 1);
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    expect(wrapRoomKey).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mgr.epoch,
    );

    await mgr.rotateKeyPeriodically();
    expect(wrapRoomKey).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mgr.epoch,
    );
  });

  it("[OC-0001] discards an offer carrying an older epoch than one already applied from that sender", async () => {
    const { mgr } = await holderWithPeer();
    try {
      unwrapAt(3, 3);
      await mgr.handleOffer(PEER_ID, "enc3", "iv3");
      expect(mockSetKey).toHaveBeenLastCalledWith("key-3");

      unwrapAt(2, 2);
      await mgr.handleOffer(PEER_ID, "enc2", "iv2");
      expect(mockSetKey).toHaveBeenLastCalledWith("key-3");
      expect(mockSetKey).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(roomKeyToBase64).mockImplementation(() => "mock-room-key-base64");
    }
  });

  it("[OC-0001] applies an offer at the same epoch as the last applied one (holder re-sends the current key)", async () => {
    const { mgr } = await holderWithPeer();
    try {
      unwrapAt(3, 3);
      await mgr.handleOffer(PEER_ID, "enc3", "iv3");
      unwrapAt(3, 4);
      await mgr.handleOffer(PEER_ID, "enc3b", "iv3b");
      expect(mockSetKey).toHaveBeenLastCalledWith("key-4");
    } finally {
      vi.mocked(roomKeyToBase64).mockImplementation(() => "mock-room-key-base64");
    }
  });

  it("[OC-0001] resets the sender's high-water mark when they announce a fresh ephemeral key", async () => {
    const { mgr } = await holderWithPeer();
    vi.mocked(importPublicKey).mockImplementation(
      async (b64: string) => ({ type: `peer-key-${b64}` }) as unknown as CryptoKey,
    );
    vi.mocked(exportPublicKey).mockImplementation(async (key: CryptoKey) =>
      (key as unknown as { type: string }).type.replace("peer-key-", ""),
    );
    try {
      unwrapAt(5, 5);
      await mgr.handleOffer(PEER_ID, "enc5", "iv5");
      expect(mockSetKey).toHaveBeenLastCalledWith("key-5");

      // Peer rejoined: new ephemeral key, new (local) epoch counter from 1.
      await mgr.handleAnnounce(PEER_ID, "bmV3", "sigB");
      unwrapAt(1, 1);
      await mgr.handleOffer(PEER_ID, "enc1", "iv1");
      expect(mockSetKey).toHaveBeenLastCalledWith("key-1");
    } finally {
      vi.mocked(roomKeyToBase64).mockImplementation(() => "mock-room-key-base64");
      vi.mocked(importPublicKey).mockImplementation(
        async () => ({ type: "public" }) as unknown as CryptoKey,
      );
      vi.mocked(exportPublicKey).mockImplementation(async () => "bW9ja2VwaGVtZXJhbA==");
    }
  });

  it("[OC-0001] still applies a legacy offer (no epoch) from a holder on the old build", async () => {
    const { mgr } = await holderWithPeer();
    try {
      unwrapAt(null, 7);
      await mgr.handleOffer(PEER_ID, "legacy", "iv");
      expect(mockSetKey).toHaveBeenLastCalledWith("key-7");
    } finally {
      vi.mocked(roomKeyToBase64).mockImplementation(() => "mock-room-key-base64");
    }
  });

  // ── OC-0003: per-session fingerprint for every peer ───────────────────────

  it("[OC-0003] publishes a session fingerprint of the ephemeral key for a legacy (unverified) peer while safetyNumber stays null", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    mockMembers.set(PEER_ID, { identityPublicKey: null });
    await mgr.setupKeyExchange(true, 1);

    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", undefined);

    expect(setPeerVerification).toHaveBeenCalledWith({
      userId: PEER_ID,
      status: "unverified",
      safetyNumber: null,
      sessionFingerprint: "5E55 1234 5678 9ABC",
    });
  });

  it("[OC-0003] publishes the session fingerprint alongside the safety number for a verified peer", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);
    await mgr.setupKeyExchange(true, 1);

    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");

    expect(setPeerVerification).toHaveBeenCalledWith({
      userId: PEER_ID,
      status: "verified",
      safetyNumber: "AB12 CD34 EF56 7890",
      sessionFingerprint: "5E55 1234 5678 9ABC",
    });
  });

  it("[OC-0003] publishes the local session fingerprint on setup and clears it on teardown", async () => {
    const ws = { send: vi.fn() };
    const mgr = createManager(ws);

    await mgr.setupKeyExchange(true, 1);
    expect(setLocalSessionFingerprint).toHaveBeenLastCalledWith("5E55 1234 5678 9ABC");

    mgr.clearState();
    expect(setLocalSessionFingerprint).toHaveBeenLastCalledWith(null);
  });
});

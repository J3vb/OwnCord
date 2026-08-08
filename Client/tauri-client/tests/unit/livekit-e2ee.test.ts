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
  unwrapRoomKey: vi.fn(async () => new Uint8Array(32)),
  signEphemeralKey: vi.fn(async () => "mock-signature"),
  verifyEphemeralKeySignature: vi.fn(async () => true),
  importIdentityPublicKey: vi.fn(
    async () => ({ type: "id-public-imported" }) as unknown as CryptoKey,
  ),
  computeKeyFingerprint: vi.fn(async () => "AB12 CD34 EF56 7890"),
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
import { setPeerVerification, clearPeerVerification } from "@stores/voice.store";
import {
  unwrapRoomKey,
  roomKeyToBase64,
  wrapRoomKey,
  generateECDHKeyPair,
  importPublicKey,
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
    const firstUnwrap = new Promise<Uint8Array>((resolve) => {
      releaseFirst = () => resolve(new Uint8Array(32).fill(1));
    });
    vi.mocked(unwrapRoomKey)
      .mockReturnValueOnce(firstUnwrap)
      .mockResolvedValueOnce(new Uint8Array(32).fill(2));
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
    let releaseUnwrap!: (v: Uint8Array) => void;
    const stalledUnwrap = new Promise<Uint8Array>((resolve) => {
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
    releaseUnwrap(new Uint8Array(32).fill(9));
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
});

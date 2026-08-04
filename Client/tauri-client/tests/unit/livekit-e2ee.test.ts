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
  getIdentityPin: vi.fn(async () => null),
  storeIdentityPin: vi.fn(async () => true),
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
import { setPeerVerification } from "@stores/voice.store";
import { unwrapRoomKey, roomKeyToBase64 } from "@lib/e2eeCrypto";

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
});

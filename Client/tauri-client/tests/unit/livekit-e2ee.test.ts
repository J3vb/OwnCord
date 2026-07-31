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

    // Drained through the verifying receive path and stored. No offer yet:
    // the drain runs before the room key is generated.
    expect(mgr.pendingAnnounces).toHaveLength(0);
    expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);
    expect(setPeerVerification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: PEER_ID, status: "verified" }),
    );
    expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(0);

    // A repeat announce after keying (dedupe path) re-sends the room-key offer.
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(1);
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

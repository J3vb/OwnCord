import { describe, it, expect, vi, beforeEach } from "vitest";
import * as mocks from "../../helpers/livekitE2eeMocks";
import { E2EEManager } from "../../../src/lib/voice/livekitE2EE";
import { markJoinMilestone } from "@lib/voice/voiceJoinTrace";
import { setPeerVerification, clearPeerVerification } from "@stores/voice.store";
import {
  unwrapRoomKey,
  roomKeyToBase64,
  wrapRoomKey,
  generateECDHKeyPair,
} from "@lib/net/e2eeCrypto";
import { getOrCreateIdentityKeyPair, storeIdentityPin } from "@lib/net/identity";
import { PEER_ID, newManager, sendsOfType, stallNextWrap } from "../../helpers/livekitE2eeHarness";

vi.mock("livekit-client", () => mocks.livekitClientMock());
vi.mock("@lib/net/e2eeCrypto", () => mocks.netE2eeCryptoMock());
vi.mock("@lib/net/identity", () => mocks.netIdentityMock());
vi.mock("@stores/auth.store", () => mocks.authStoreMock());
vi.mock("@stores/members.store", () => mocks.membersStoreMock());
vi.mock("@stores/voice.store", () => mocks.voiceStoreMock());
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/voice/voiceJoinTrace", (importOriginal) =>
  mocks.voiceVoiceJoinTraceMock(importOriginal),
);

const { mockSetKey, mockIdentityKeyPair, mockMembers, mockVoiceState } = mocks;

describe("E2EEManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMembers.clear();
    mockMembers.set(PEER_ID, { identityPublicKey: "peer-identity-b64" });
    mockVoiceState.voiceUsers.clear();
  });

  it("setupKeyExchange as key holder generates the room key and sends a signed announce", async () => {
    const { ws, mgr } = newManager();

    const ok = await mgr.setupKeyExchange(true, 1);

    expect(ok).toBe(true);
    expect(mgr.epoch).toBe(1);
    expect(mockSetKey).toHaveBeenCalledWith("mock-room-key-base64");
    const announces = sendsOfType(ws, "voice_e2ee_announce");
    expect(announces).toHaveLength(1);
    expect((announces[0] as any).payload.signature).toBe("mock-signature");
  });

  it("SRE-M2: marks the key holder's E2EE join milestones in order", async () => {
    const { mgr } = newManager();

    await mgr.setupKeyExchange(true, 1);

    expect(vi.mocked(markJoinMilestone).mock.calls.map(([m]) => m)).toEqual([
      "e2ee room key generated",
      "e2ee announce sent",
    ]);
  });

  it("SRE-M2: marks the non-key-holder's E2EE join milestones in order", async () => {
    const { ws, mgr } = newManager();
    await mgr.setupKeyExchange(true, 1);
    mgr.clearState();
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    ws.send.mockClear();
    vi.mocked(markJoinMilestone).mockClear();

    const setupPromise = mgr.setupKeyExchange(false, 1);
    await vi.waitFor(() => {
      expect(sendsOfType(ws, "voice_e2ee_announce").length).toBeGreaterThan(0);
    });
    await mgr.handleOffer(PEER_ID, "enc", "iv");
    await expect(setupPromise).resolves.toBe(true);

    expect(vi.mocked(markJoinMilestone).mock.calls.map(([m]) => m)).toEqual([
      "e2ee announce sent",
      "e2ee key holder offer received",
      "e2ee room key applied",
    ]);
  });

  it("queues an announce before the keypair exists and drains it on setup, sending an offer", async () => {
    const { ws, mgr } = newManager();

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

  describe("announces held for a join queued behind the one in flight", () => {
    it("replays them into the queued channel's exchange, which survives the queued join's clearState", async () => {
      const { ws, mgr } = newManager();
      try {
        mgr.holdAnnouncesForQueuedJoin(2);
        await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
        expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);

        mgr.clearState({ keepHeldAnnounces: true });
        await mgr.setupKeyExchange(true, 2);

        expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);
        expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(1);
      } finally {
        mgr.clearState();
      }
    });

    it("never applies announces held for one channel to another channel's exchange", async () => {
      const { ws, mgr } = newManager();
      try {
        mgr.holdAnnouncesForQueuedJoin(2);
        await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");

        mgr.clearState({ keepHeldAnnounces: true });
        await mgr.setupKeyExchange(true, 1);

        expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);
        expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(0);
      } finally {
        mgr.clearState();
      }
    });

    it("drops what was held for the previous channel when the queued join is retargeted", async () => {
      const { mgr } = newManager();
      try {
        mgr.holdAnnouncesForQueuedJoin(2);
        await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
        mgr.holdAnnouncesForQueuedJoin(3);
        await mgr.handleAnnounce(99, "b3RoZXI=", "sig");

        mgr.clearState({ keepHeldAnnounces: true });
        await mgr.setupKeyExchange(true, 3);

        expect([...mgr.peerPublicKeys.keys()]).toEqual([99]);
      } finally {
        mgr.clearState();
      }
    });

    it("forgets a held announce whose peer leaves before the exchange starts", async () => {
      const { mgr } = newManager();
      try {
        mgr.holdAnnouncesForQueuedJoin(2);
        await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
        await mgr.handleParticipantLeft(PEER_ID);

        mgr.clearState({ keepHeldAnnounces: true });
        await mgr.setupKeyExchange(true, 2);

        expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);
      } finally {
        mgr.clearState();
      }
    });

    it("drops them on a real leave, and lets live announces through once released", async () => {
      const { mgr } = newManager();
      try {
        mgr.holdAnnouncesForQueuedJoin(2);
        await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
        mgr.clearState();
        await mgr.setupKeyExchange(true, 2);
        expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);

        mgr.holdAnnouncesForQueuedJoin(3);
        mgr.releaseHeldAnnounces(2);
        await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
        expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);
      } finally {
        mgr.clearState();
      }
    });

    it("hands what was held for the live channel to its exchange when released", async () => {
      const { ws, mgr } = newManager();
      try {
        mgr.clearState();
        mgr.holdAnnouncesForQueuedJoin(5);
        await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
        mgr.releaseHeldAnnounces(5);
        await mgr.setupKeyExchange(true, 5);

        expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);
        expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(1);
      } finally {
        mgr.clearState();
      }
    });
  });

  it("setupKeyExchange as non-key-holder resolves once the key holder's offer arrives", async () => {
    const { ws, mgr } = newManager();
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
    const { ws, mgr } = newManager();

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
    const ws = { send: vi.fn(), getState: () => "connected" };
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
    const { mgr } = newManager();
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
    const { ws, mgr } = newManager();
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
    const { mgr } = newManager();
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

  it("skips the keypair swap and send when the WS is not connected, so the published key can't diverge from the local one", async () => {
    const { ws, mgr } = newManager();
    await mgr.setupKeyExchange(true, 1);
    const pairBefore = (mgr as unknown as { _ecdhKeyPair: unknown })._ecdhKeyPair;
    ws.send.mockClear();

    ws.getState = () => "reconnecting";
    await mgr.reannounceForReconnect();

    expect(sendsOfType(ws, "voice_e2ee_announce")).toHaveLength(0);
    expect((mgr as unknown as { _ecdhKeyPair: unknown })._ecdhKeyPair).toBe(pairBefore);
  });

  it("rotateKeyPeriodically advances the epoch and redistributes the key to peers", async () => {
    const { ws, mgr } = newManager();
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

  it("resumes as key holder when re-elected while a prior rotation is still in flight", async () => {
    const { mgr } = newManager();
    mockVoiceState.voiceUsers.set(1, new Map([[1, {}]])); // we (uid 1) are always lowest

    await mgr.setupKeyExchange(true, 1); // epoch 1, holder
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig"); // peer key known

    // Hold distribution open after the provider import so an offer can be
    // applied while the original rotation still owns the rotation guard.
    let releaseDistribution!: (offer: { encryptedKey: string; iv: string }) => void;
    const stall = new Promise<{ encryptedKey: string; iv: string }>((resolve) => {
      releaseDistribution = resolve;
    });
    vi.mocked(wrapRoomKey).mockClear();
    vi.mocked(wrapRoomKey).mockReturnValueOnce(stall);
    const rotationPromise = mgr.rotateKeyPeriodically();
    await vi.waitFor(() => expect(wrapRoomKey).toHaveBeenCalled());
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
    releaseDistribution({ encryptedKey: "enc", iv: "iv" });
    await rotationPromise;

    // The re-election's finally -> drainPendingRotationOrArmTimer must have
    // run a fresh rotation as holder: one more epoch bump and key-provider
    // update beyond the two already accounted for (initial holder setup +
    // the stalled rotation).
    expect(mgr.epoch).toBe(3);
    expect(mgr.rotatingKey).toBe(false);
  });

  it("marks a first-sight peer 'unverified' (not 'verified') when the identity-pin write fails", async () => {
    const { mgr } = newManager();
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

  it("discards a stale offer even when epoch is unchanged, because the keypair belongs to a cleared session", async () => {
    const { ws, mgr } = newManager();

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

  it("discards a stale announce-offer if the room key rotates while wrapRoomKey is in flight", async () => {
    const { ws, mgr } = newManager();
    await mgr.setupKeyExchange(true, 1); // holder, epoch 1

    const releaseWrap = stallNextWrap();

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

  it("retries with a fresh promise after a decrypt failure, so a second good offer still completes setup", async () => {
    const { ws, mgr } = newManager();

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

  it("queues (does not drop) a live announce that arrives during setup, before isKeyHolder/roomKey are ready", async () => {
    const { ws, mgr } = newManager();

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
    const { mgr } = newManager();
    vi.mocked(storeIdentityPin).mockResolvedValueOnce("failed");

    const result = await mgr.rePinPeerIdentity(PEER_ID, "verified-key-b64");

    // A failed write must not report the re-pin as successful — the OLD pin
    // is still on disk, so clearing the mismatch block here would let the
    // UI claim trust was re-established when it wasn't.
    expect(result).toBe(false);
    expect(clearPeerVerification).not.toHaveBeenCalled();
  });

  it("[finding v011] clears the mismatch block when the re-pin write succeeds", async () => {
    const { mgr } = newManager();

    const result = await mgr.rePinPeerIdentity(PEER_ID, "verified-key-b64");

    expect(result).toBe(true);
    expect(clearPeerVerification).toHaveBeenCalledWith(PEER_ID);
  });

  it("[finding v043] a superseded attempt's retry guard checks keypair ownership, not just null, so it never re-announces a dead key over a live session", async () => {
    const { ws, mgr } = newManager();

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
});

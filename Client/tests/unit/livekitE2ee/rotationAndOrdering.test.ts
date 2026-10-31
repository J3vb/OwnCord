import { describe, it, expect, vi, beforeEach } from "vitest";
import * as mocks from "../../helpers/livekitE2eeMocks";
import { setPeerVerification } from "@stores/voice.store";
import {
  unwrapRoomKey,
  roomKeyToBase64,
  wrapRoomKey,
  generateECDHKeyPair,
  generateRoomKey,
  importPublicKey,
} from "@lib/net/e2eeCrypto";
import { getOrCreateIdentityKeyPair, getIdentityPin } from "@lib/net/identity";
import { authStore } from "@stores/auth.store";
import {
  PEER_ID,
  newManager,
  roundTripPeerKeys,
  restorePeerKeyMocks,
  createManager,
  sendsOfType,
} from "../../helpers/livekitE2eeHarness";

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

  it("[finding v043] a superseded setup does not wipe the live session's peer keys", async () => {
    const { mgr } = newManager();

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
    const { ws, mgr } = newManager();

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
    const { mgr } = newManager();
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
    const { ws, mgr } = newManager();
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
    const { ws, mgr } = newManager();
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
    const { ws, mgr } = newManager();
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

  it("preserves a key-holder promotion that lands during setupKeyExchange's pre-publish awaits, instead of clobbering it with the stale server value", async () => {
    const { mgr } = newManager();
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

  it("does not resurrect peer key/verification state into a torn-down session when clearState() runs during verifyPeerAnnounce's pin lookup", async () => {
    const { mgr } = newManager();
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
    const { ws, mgr } = newManager();
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

  it("sends its own announce before offering the room key to a drained peer", async () => {
    const { ws, mgr } = newManager();

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

  it("elects us key holder on a participant-left even when our own voice_state hasn't landed in the roster yet", async () => {
    const ws = { send: vi.fn(), getState: () => "connected" };
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

  it("serializes a new session's key after an unfinished rotation", async () => {
    const { mgr } = newManager();
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

      // The new session waits for the unfinished import before applying its key.
      mgr.clearState();
      vi.mocked(generateRoomKey).mockReturnValueOnce(new Uint8Array(32).fill(7)); // live session's key
      mockSetKey.mockClear();
      const newSetup = mgr.setupKeyExchange(true, 2);
      await vi.waitFor(() => expect(mgr.epoch).toBe(1));
      expect(mockSetKey).not.toHaveBeenCalled();

      // The abandoned rotation's setKey call now resolves.
      releaseStale();
      await Promise.all([rotationPromise, newSetup]);

      // The shared key provider must end up on the LIVE session's key, not
      // silently left on the abandoned one — narrow race, but real: nothing
      // else re-applies the live key once the stale call lands.
      expect(mockSetKey).toHaveBeenCalledWith("key-7");
      expect(mockSetKey).toHaveBeenCalledTimes(1);
    } finally {
      mgr.clearState();
      vi.mocked(roomKeyToBase64).mockImplementation(() => "mock-room-key-base64");
    }
  });

  it("paces room-key offers so a large channel's rotation stays under the server's per-second rate limit", async () => {
    const { ws, mgr } = newManager();
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

  it("shares the offer-pacing budget across back-to-back rotations instead of resetting it per call", async () => {
    const { ws, mgr } = newManager();
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

  it("paces announce-driven offers through the same shared budget as rotation offers", async () => {
    const { ws, mgr } = newManager();

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

  it("does not stand down a new session's key-holder role when a stale offer's setKey resolves after teardown+rejoin", async () => {
    const { mgr } = newManager();

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
    const newSetup = mgr.setupKeyExchange(true, 2);
    await vi.waitFor(() =>
      expect((mgr as unknown as { _isKeyHolder: boolean })._isKeyHolder).toBe(true),
    );

    // The stale (session-1) offer's setKey now resolves.
    releaseSetKey();
    await Promise.all([offerPromise, newSetup]);

    // Channel 2's holder role must survive — the stale continuation must not
    // stand it down (it re-checks staleness before the setKey await, not
    // after — the write happens on the far side of that await).
    expect((mgr as unknown as { _isKeyHolder: boolean })._isKeyHolder).toBe(true);
  });

  it("does not write a stale peer key into a new session's map when clearState()+rejoin lands during the announce's key-import await", async () => {
    const { mgr } = newManager();

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

  it("rejects a replayed announce carrying a previously-retired peer key instead of overwriting the live key", async () => {
    const { mgr } = newManager();
    await mgr.setupKeyExchange(true, 1); // establishes our keypair

    // Make import/export round-trip faithfully on the announced base64
    // string (the shared mock default returns a fixed constant from
    // exportPublicKey regardless of input, which would mask this bug).
    roundTripPeerKeys();

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
      restorePeerKeyMocks();
    }
  });

  it("confirms the room key after a reconnect re-announce instead of declaring it fresh unconditionally", async () => {
    const { ws, mgr } = newManager();
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

  it("applies an offer that arrives while its sender's own announce is still verifying, instead of dropping it as an unknown peer", async () => {
    const { mgr } = newManager();
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

  it("stays at securing for the full 10 s + 5 s when the key holder's announce is refused, dropping its offer", async () => {
    // One way a joiner sits at "securing" and then leaves on its own with the
    // key holder online and answering: a fail-closed TOFU check (here an
    // unreadable pin store, DC-08) refuses the holder's announce, so the
    // holder's offer finds no sender key and is dropped. The re-announce only
    // earns the same offer again, and the exchange gives up after 15 s.
    vi.useFakeTimers();
    try {
      vi.mocked(getIdentityPin).mockResolvedValueOnce({ status: "unavailable" });
      const { ws, mgr } = newManager();
      let result: boolean | undefined;
      void mgr.setupKeyExchange(false, 1).then((ok) => (result = ok));
      await vi.advanceTimersByTimeAsync(0);
      expect(sendsOfType(ws, "voice_e2ee_announce")).toHaveLength(1);

      await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
      await mgr.handleOffer(PEER_ID, "enc", "iv");
      expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);
      expect(unwrapRoomKey).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(sendsOfType(ws, "voice_e2ee_announce")).toHaveLength(2);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(result).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires a departed peer's key on leave, so a replay of it after they rejoin with a fresh key cannot resurrect it", async () => {
    const { mgr } = newManager();
    await mgr.setupKeyExchange(true, 1); // establishes our keypair, holder

    // Make import/export round-trip faithfully on the announced base64
    // string (the shared mock default returns a fixed constant regardless
    // of input, which would mask this bug).
    roundTripPeerKeys();

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
      restorePeerKeyMocks();
    }
  });
});

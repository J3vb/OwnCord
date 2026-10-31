import { describe, it, expect, vi, beforeEach } from "vitest";
import * as mocks from "../../helpers/livekitE2eeMocks";
import { E2EEManager } from "../../../src/lib/voice/livekitE2EE";
import {
  setPeerVerification,
  setLocalSessionFingerprint,
  setLocalSafetyNumber,
} from "@stores/voice.store";
import {
  unwrapRoomKey,
  roomKeyToBase64,
  wrapRoomKey,
  generateECDHKeyPair,
  generateRoomKey,
  importPublicKey,
  exportPublicKey,
  computeRawKeyFingerprint,
  computeKeyFingerprint,
  signEphemeralKey,
  verifyEphemeralKeySignature,
} from "@lib/net/e2eeCrypto";
import { getOrCreateIdentityKeyPair, getIdentityPin, storeIdentityPin } from "@lib/net/identity";
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
    const { ws, mgr } = newManager();
    await mgr.setupKeyExchange(true, 1);
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    mockSetKey.mockClear();
    vi.mocked(roomKeyToBase64).mockImplementation((k: Uint8Array) => `key-${k[0]}`);
    return { ws, mgr };
  }

  it("wraps each offer with the sender's current epoch", async () => {
    const { mgr } = newManager();
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

  it("discards an offer carrying an older epoch than one already applied from that sender", async () => {
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

  it("applies an offer at the same epoch as the last applied one (holder re-sends the current key)", async () => {
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

  it("resets the sender's high-water mark when they announce a fresh ephemeral key", async () => {
    const { mgr } = await holderWithPeer();
    roundTripPeerKeys();
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
      restorePeerKeyMocks();
    }
  });

  it("still applies a legacy offer (no epoch) from a holder on the old build", async () => {
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

  it("publishes a session fingerprint of the ephemeral key for a legacy (unverified) peer while safetyNumber stays null", async () => {
    const { mgr } = newManager();
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

  it("publishes the session fingerprint alongside the safety number for a verified peer", async () => {
    const { mgr } = newManager();
    await mgr.setupKeyExchange(true, 1);

    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");

    expect(setPeerVerification).toHaveBeenCalledWith({
      userId: PEER_ID,
      status: "verified",
      safetyNumber: "AB12 CD34 EF56 7890",
      sessionFingerprint: "5E55 1234 5678 9ABC",
    });
  });

  it("publishes the local session fingerprint on setup and clears it on teardown", async () => {
    const { mgr } = newManager();

    await mgr.setupKeyExchange(true, 1);
    expect(setLocalSessionFingerprint).toHaveBeenLastCalledWith("5E55 1234 5678 9ABC");

    mgr.clearState();
    expect(setLocalSessionFingerprint).toHaveBeenLastCalledWith(null);
  });

  it("publishes the local user's own safety number on setup and clears it on teardown", async () => {
    const { mgr } = newManager();

    await mgr.setupKeyExchange(true, 1);
    // The fingerprint of the identity key the announce was signed with: the
    // number a peer sees on our shield.
    expect(computeKeyFingerprint).toHaveBeenCalledWith(mockIdentityKeyPair.publicKey);
    expect(setLocalSafetyNumber).toHaveBeenLastCalledWith("AB12 CD34 EF56 7890");

    mgr.clearState();
    expect(setLocalSafetyNumber).toHaveBeenLastCalledWith(null);
  });

  it("an unsigned announce publishes no own safety number", async () => {
    const { mgr } = newManager();
    vi.mocked(signEphemeralKey).mockRejectedValueOnce(new Error("keyring down"));

    await mgr.setupKeyExchange(true, 1);

    // Peers see us as unverified, so there is no number for them to compare.
    expect(setLocalSafetyNumber).toHaveBeenLastCalledWith(null);
    expect(setLocalSafetyNumber).not.toHaveBeenCalledWith("AB12 CD34 EF56 7890");
  });

  // ── Guards the suite reached but never pinned (mutation audit T-2026-08-19-47) ──

  it("aborts setup when a teardown lands during the key holder's keyProvider.setKey", async () => {
    const { ws, mgr } = newManager();

    // Stall the holder's setKey — the last await before the keypair is
    // published. A teardown here leaves nothing about our local state null,
    // so only the session-generation check can see it.
    let releaseSetKey!: () => void;
    mockSetKey.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseSetKey = resolve;
      }),
    );

    const setupPromise = mgr.setupKeyExchange(true, 1);
    await vi.waitFor(() => expect(mockSetKey).toHaveBeenCalled());

    mgr.clearState();
    vi.mocked(setLocalSafetyNumber).mockClear();
    releaseSetKey();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Nor does the dead attempt show its safety number over the torn-down session.
    expect(setLocalSafetyNumber).not.toHaveBeenCalled();

    // Publishing the keypair here would defeat handleAnnounceInner's queue
    // guard and go on to announce a dead ephemeral key over a live call.
    expect((mgr as unknown as { _ecdhKeyPair: unknown })._ecdhKeyPair).toBeNull();
    expect(sendsOfType(ws, "voice_e2ee_announce")).toHaveLength(0);
    await expect(setupPromise).resolves.toBe(false);
  });

  it("a superseded reconnect re-announce publishes neither its fingerprint nor a stray announce", async () => {
    const { ws, mgr } = newManager();
    await mgr.setupKeyExchange(true, 1);
    ws.send.mockClear();
    vi.mocked(setLocalSessionFingerprint).mockClear();
    vi.mocked(computeRawKeyFingerprint).mockClear();

    // Attempt A stalls after publishing its keypair, while computing its own
    // session fingerprint.
    let releaseFingerprint!: (v: string) => void;
    const stalledFingerprint = new Promise<string>((resolve) => {
      releaseFingerprint = resolve;
    });
    vi.mocked(computeRawKeyFingerprint)
      .mockReturnValueOnce(stalledFingerprint)
      .mockResolvedValueOnce("FP-B");

    const reconnectA = mgr.reannounceForReconnect();
    await vi.waitFor(() => expect(computeRawKeyFingerprint).toHaveBeenCalled());

    // A second reconnect wins the race and publishes its own keypair.
    vi.mocked(generateECDHKeyPair).mockResolvedValueOnce({
      publicKey: { type: "pub-B" } as unknown as CryptoKey,
      privateKey: { type: "priv-B" } as unknown as CryptoKey,
    });
    await mgr.reannounceForReconnect();

    releaseFingerprint("FP-A-STALE");
    await reconnectA;

    // A owns neither the published keypair nor the announce: showing the user
    // A's fingerprint (or re-announcing A's dead key) misrepresents the live
    // session's identity.
    expect(setLocalSessionFingerprint).toHaveBeenCalledWith("FP-B");
    expect(setLocalSessionFingerprint).not.toHaveBeenCalledWith("FP-A-STALE");
    expect(sendsOfType(ws, "voice_e2ee_announce")).toHaveLength(1);
  });

  it("does not arm a reconnect-confirmation retry when there was no room key to go stale", async () => {
    vi.useFakeTimers();
    try {
      const ws = { send: vi.fn(), getState: () => "connected" };
      const mgr = createManager(ws); // never keyed: non-holder, no room key

      await mgr.reannounceForReconnect();
      expect(sendsOfType(ws, "voice_e2ee_announce")).toHaveLength(1);

      // Nothing could have gone stale — waiting for the first offer is
      // setupKeyExchange's concern, so no confirmation retry belongs here.
      await vi.advanceTimersByTimeAsync(6000);
      expect(sendsOfType(ws, "voice_e2ee_announce")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the reconnect-confirmation retry once a fresh offer replaced the room key", async () => {
    const { ws, mgr } = newManager();
    await mgr.setupKeyExchange(true, 1);
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
    await mgr.handleOffer(PEER_ID, "enc", "iv"); // stands us down — now a non-holder with a key
    ws.send.mockClear();

    vi.useFakeTimers();
    try {
      await mgr.reannounceForReconnect();
      // The holder's confirming offer arrives well inside the window.
      vi.mocked(unwrapRoomKey).mockResolvedValueOnce({
        roomKey: new Uint8Array(32).fill(9),
        epoch: 1,
      });
      await mgr.handleOffer(PEER_ID, "enc2", "iv2");

      await vi.advanceTimersByTimeAsync(6000);
      expect(sendsOfType(ws, "voice_e2ee_announce")).toHaveLength(1); // no retry
    } finally {
      vi.useRealTimers();
    }
  });

  it("a duplicate announce does not reset the sender's offer high-water mark", async () => {
    const { mgr } = newManager();
    await mgr.setupKeyExchange(true, 1);
    // Announce the exact key the export mock echoes back, so the repeat below
    // takes the dedupe path rather than the key-changed path.
    await mgr.handleAnnounce(PEER_ID, "bW9ja2VwaGVtZXJhbA==", "sig");
    mockSetKey.mockClear();
    vi.mocked(roomKeyToBase64).mockImplementation((k: Uint8Array) => `key-${k[0]}`);

    try {
      unwrapAt(5, 5);
      await mgr.handleOffer(PEER_ID, "enc5", "iv5");
      expect(mockSetKey).toHaveBeenLastCalledWith("key-5");

      // A replayed (validly signed) announce carrying the peer's CURRENT key
      // must not clear the high-water mark — that would re-open the OC-0001
      // downgrade window for every superseded offer of theirs.
      await mgr.handleAnnounce(PEER_ID, "bW9ja2VwaGVtZXJhbA==", "sig");

      unwrapAt(2, 2);
      await mgr.handleOffer(PEER_ID, "enc2", "iv2");
      expect(mockSetKey).toHaveBeenLastCalledWith("key-5");
    } finally {
      vi.mocked(roomKeyToBase64).mockImplementation(() => "mock-room-key-base64");
    }
  });

  it("does not promote itself on a leave while a lower-id participant remains", async () => {
    const { ws, mgr } = newManager();
    // We are uid 50; uid 10 stays behind, so the election must pick them.
    vi.mocked(authStore.getState).mockImplementation(() => ({ user: { id: 50 } }) as never);
    mockVoiceState.voiceUsers.set(1, new Map([[10, {}] as const, [50, {}] as const]));

    try {
      await mgr.handleParticipantLeft(PEER_ID);

      // Self-promoting here means two holders rotating against each other:
      // our offers get NOT_KEY_HOLDER'd only after we applied our own key.
      expect(mgr.epoch).toBe(0);
      expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(0);
    } finally {
      vi.mocked(authStore.getState).mockImplementation(() => ({ user: { id: 1 } }) as never);
    }
  });

  it("arms the periodic rotation timer for the key holder so forward secrecy actually fires", async () => {
    vi.useFakeTimers();
    try {
      const { ws, mgr } = newManager();
      await mgr.setupKeyExchange(true, 1);
      await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
      ws.send.mockClear();

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(mgr.epoch).toBe(2);
      expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Ledger findings OC-0209 / OC-0212 / OC-0213 ───────────────────────────

  it("rejects a replayed retired-key announce before it overwrites the peer's verification badge", async () => {
    const { mgr } = newManager();
    await mgr.setupKeyExchange(true, 1); // establishes our keypair, holder

    // Make import/export round-trip faithfully on the announced base64
    // string (the shared mock default returns a fixed constant regardless
    // of input, which would mask this bug).
    roundTripPeerKeys();

    const KEY_A = "b2xk";
    const KEY_B = "bmV3";

    try {
      // Peer announces key A, then a genuine key change to B — A is now retired.
      await mgr.handleAnnounce(PEER_ID, KEY_A, "sigA");
      await mgr.handleAnnounce(PEER_ID, KEY_B, "sigB");
      expect(mgr.peerPublicKeys.get(PEER_ID)).toEqual({ type: `peer-key-${KEY_B}` });

      vi.mocked(setPeerVerification).mockClear();

      // A malicious relay replays the old, still validly-signed announce for
      // the retired key A. The replay guard must reject it BEFORE any
      // verification write — a replay that reaches verifyPeerAnnounce first
      // would overwrite the peer's badge (status + sessionFingerprint) with
      // the retired key's, even though the guard then rejects the announce
      // and _peerPublicKeys is left untouched.
      await mgr.handleAnnounce(PEER_ID, KEY_A, "sigA");

      expect(setPeerVerification).not.toHaveBeenCalled();
      expect(mgr.peerPublicKeys.get(PEER_ID)).toEqual({ type: `peer-key-${KEY_B}` });
    } finally {
      restorePeerKeyMocks();
    }
  });

  it("replays the blocked announce after a successful re-pin, restoring the peer instead of leaving them un-keyed with the badge cleared", async () => {
    const { mgr } = newManager();
    await mgr.setupKeyExchange(true, 1); // holder in channel 1

    const NEW_IDENTITY = "new-identity-key-b64";

    // A still has the peer pinned, but the server is not delivering their
    // identity key, so the announce is blocked.
    mockMembers.set(PEER_ID, { identityPublicKey: null });
    vi.mocked(getIdentityPin).mockResolvedValueOnce({
      status: "pinned",
      pin: "old-identity-key-b64",
    });
    await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");

    expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);
    expect(setPeerVerification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: PEER_ID, status: "mismatch" }),
    );
    vi.mocked(setPeerVerification).mockClear();

    // A key is delivered again; the user confirms its fingerprint out of band
    // and re-pins to it.
    mockMembers.set(PEER_ID, { identityPublicKey: NEW_IDENTITY });
    vi.mocked(getIdentityPin).mockResolvedValueOnce({ status: "pinned", pin: NEW_IDENTITY });
    const result = await mgr.rePinPeerIdentity(PEER_ID, NEW_IDENTITY);

    expect(result).toBe(true);
    // The blocked announce must be replayed against the new pin — not just
    // discarded with the badge cleared — so the peer actually re-enters
    // _peerPublicKeys and is offered the room key for the rest of the call.
    expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);
    expect(setPeerVerification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: PEER_ID, status: "verified" }),
    );
  });

  it("does not permanently retire a peer's key on a stale voice_leave when the peer is still listed as present in the channel roster", async () => {
    const { mgr } = newManager();
    await mgr.setupKeyExchange(true, 1); // holder in channel 1

    roundTripPeerKeys();

    const KEY = "b2xk";

    try {
      // The peer's rejoin announce (carrying a fresh key) arrives first —
      // the OC-0213 repro's reordering, where the directly-published
      // voice_e2ee_announce overtakes the still-queued voice_leave for the
      // join instance it superseded.
      await mgr.handleAnnounce(PEER_ID, KEY, "sig");
      expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);

      // voice_state (the local roster) still lists the peer as present in
      // the channel — this is what tells apart a stale, lagging leave for a
      // superseded join instance from a genuine departure.
      mockVoiceState.voiceUsers.set(1, new Map([[PEER_ID, {}]]));

      // The stale voice_leave for the superseded join instance now arrives.
      await mgr.handleParticipantLeft(PEER_ID);

      // Removed from the live peer map (unchanged behavior)...
      expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);

      // ...but the key must not be permanently retired: the peer's own,
      // still-valid re-announce of the SAME key must be accepted again, not
      // rejected as a replay of a "retired" key — otherwise the peer is
      // stranded, un-re-announceable, for the rest of the call.
      await mgr.handleAnnounce(PEER_ID, KEY, "sig");
      expect(mgr.peerPublicKeys.get(PEER_ID)).toEqual({ type: `peer-key-${KEY}` });
    } finally {
      restorePeerKeyMocks();
    }
  });

  // OC-0239 tried to have the caller pass a pre-mutation "was this peer
  // still in the roster?" snapshot into handleParticipantLeft so a stale,
  // superseded-rejoin voice_leave (OC-0213) would not retire a peer's live
  // key. OC-0283 found that snapshot is true on every genuine departure too
  // — a departing peer's roster entry is only ever removed by the very
  // voice_leave event being handled, so a read taken relative to it, before
  // or after the mutation, cannot distinguish the two cases. Threading that
  // flag through therefore disabled the OC-0020 retirement defense in
  // production outright. The parameter is gone; this test now pins the
  // corrected behavior: a genuine departure retires the key even though the
  // roster looked "still present" right up until this event, matching what
  // production's real (post-mutation) roster read looks like.
  it("retires a departed peer's key even though the roster listed them as present right up until this event", async () => {
    const { mgr } = newManager();
    await mgr.setupKeyExchange(true, 1); // holder in channel 1

    roundTripPeerKeys();

    const KEY = "b2xk";

    try {
      await mgr.handleAnnounce(PEER_ID, KEY, "sig");
      expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);

      // Reproduce dispatcher.ts's real VOICE_LEAVE ordering: removeVoiceUser()
      // deletes the peer from the roster BEFORE handleParticipantLeft runs, so
      // by the time this fires the local roster no longer lists them.
      mockVoiceState.voiceUsers.set(1, new Map()); // peer already removed from roster
      await mgr.handleParticipantLeft(PEER_ID);

      // Removed from the live peer map...
      expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);

      // ...AND retired: a replay of the peer's old, still-validly-signed
      // announce must now be rejected, not accepted as if they never left.
      await mgr.handleAnnounce(PEER_ID, KEY, "sig");
      expect(mgr.peerPublicKeys.get(PEER_ID)).toBeUndefined();
    } finally {
      restorePeerKeyMocks();
    }
  });

  it("a stale (demoted) key holder must not send a doomed voice_e2ee_offer to a peer with a lower user id", async () => {
    const { ws, mgr } = newManager();
    // We are uid 10 and became holder while we were the lowest connected id.
    vi.mocked(authStore.getState).mockImplementation(() => ({ user: { id: 10 } }) as never);

    try {
      const ok = await mgr.setupKeyExchange(true, 1);
      expect(ok).toBe(true);
      ws.send.mockClear();

      // A peer with a LOWER user id (5) joins and announces. The server
      // always elects the lowest connected user id as holder
      // (Server/ws/voice_e2ee.go) and re-runs election on every join, but
      // sends no demotion message — voice_token_refresh's corrected
      // is_key_holder is thrown away too (handleVoiceTokenRefresh) — so our
      // stale _isKeyHolder flag would otherwise wrap the room key and send a
      // voice_e2ee_offer the server refuses with NOT_KEY_HOLDER, surfacing
      // as a spurious error toast for a call that is actually fine.
      await mgr.handleAnnounce(5, "cGVlcg==", "sig");

      expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(0);
    } finally {
      vi.mocked(authStore.getState).mockImplementation(() => ({ user: { id: 1 } }) as never);
    }
  });
});

// ── HP-2 question 4: adversarial membership and key-change rules ───────────
// Each test pins one rule from docs/trust-model.md §"What is end-to-end
// encrypted" that had no dedicated test before HP-2, or records a known gap
// so the fix has a RED waiting for it.

describe("E2EEManager — adversarial membership and key-change rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMembers.clear();
    mockMembers.set(PEER_ID, { identityPublicKey: "peer-identity-b64" });
    mockVoiceState.voiceUsers.clear();
    vi.mocked(getIdentityPin).mockResolvedValue({ status: "unpinned" });
    vi.mocked(storeIdentityPin).mockResolvedValue("stored");
  });

  it("known gap] a modified server that adds an unknown member at first contact gets the room key wrapped to it", async () => {
    // Membership is server-controlled and the client accepts any first-sight
    // identity (verifyPeerAnnounce). A server that inserts a member row it
    // holds the identity key for, then relays a well-signed announce for it,
    // is keyed by the holder like any real peer. The client has no
    // independent membership evidence — the voice roster is server state
    // too, and here it does not even list the newcomer.
    //
    // This pins TODAY's behaviour. When authenticated membership (or
    // "refuse unrecognised participants") lands, this test goes RED and the
    // expectations below invert. docs/trust-model.md §"What beta does not
    // claim" names the gap.
    const INTRUDER = 99;
    mockMembers.set(INTRUDER, { identityPublicKey: "server-supplied-identity-b64" });
    expect(mockVoiceState.voiceUsers.size).toBe(0);
    const { ws, mgr } = newManager();
    await mgr.setupKeyExchange(true, 1);
    ws.send.mockClear();

    await mgr.handleAnnounce(INTRUDER, "aW50cnVkZXI=", "sig-the-server-can-make");

    // Today: keyed, pinned, verified — the RED of the desired rule (no offer,
    // no pin) is recorded in docs/archive/plans/hp-2-scorecard-2026-08-29.md Q4.
    const offers = sendsOfType(ws, "voice_e2ee_offer");
    expect(offers).toHaveLength(1);
    expect((offers[0] as any).payload.target_user_id).toBe(INTRUDER);
    expect(mgr.peerPublicKeys.has(INTRUDER)).toBe(true);
    expect(storeIdentityPin).toHaveBeenCalledWith(
      "localhost:7880",
      String(INTRUDER),
      "server-supplied-identity-b64",
    );
    expect(setPeerVerification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: INTRUDER, status: "verified" }),
    );
  });

  it("a second device's key overwrites the account pin automatically, and so does the first device's when it returns", async () => {
    // Pins are one per account ({host}:{userId}) while identity keys are per
    // install (identity.ts; migration 017 holds one identity_public_key per
    // user). A changed key whose announce verifies is accepted and re-pinned
    // automatically, so two devices flip the one pin back and forth, each
    // change flagged on the badge. docs/trust-model.md
    // §"What is end-to-end encrypted" states the flip-flop; this pins it.
    const DEVICE1 = "device1-identity-b64";
    const DEVICE2 = "device2-identity-b64";
    vi.mocked(getIdentityPin).mockResolvedValue({ status: "pinned", pin: DEVICE1 });
    mockMembers.set(PEER_ID, { identityPublicKey: DEVICE2 }); // server row: last announcer wins
    const { ws, mgr } = newManager();
    await mgr.setupKeyExchange(true, 1);
    ws.send.mockClear();

    // Device 2 announces: pinned key differs, the announce verifies against
    // the delivered key → accepted, the ONE slot is overwritten, keyed.
    await mgr.handleAnnounce(PEER_ID, "ZGV2aWNlMg==", "sig2");
    expect(setPeerVerification).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: PEER_ID, status: "changed" }),
    );
    expect(storeIdentityPin).toHaveBeenCalledTimes(1);
    expect(storeIdentityPin).toHaveBeenCalledWith("localhost:7880", String(PEER_ID), DEVICE2);
    expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(1);

    // Device 1 comes back (the server row carries its key again): the same
    // rule re-pins device 1's key.
    vi.mocked(getIdentityPin).mockResolvedValue({ status: "pinned", pin: DEVICE2 });
    mockMembers.set(PEER_ID, { identityPublicKey: DEVICE1 });
    await mgr.handleAnnounce(PEER_ID, "ZGV2aWNlMQ==", "sig1");
    expect(storeIdentityPin).toHaveBeenCalledTimes(2);
    expect(storeIdentityPin).toHaveBeenLastCalledWith("localhost:7880", String(PEER_ID), DEVICE1);
    expect(setPeerVerification).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: PEER_ID, status: "changed" }),
    );

    // An announce that does not verify against the delivered key is still
    // rejected — no offer, no key imported, no pin write.
    vi.mocked(getIdentityPin).mockResolvedValue({ status: "pinned", pin: DEVICE1 });
    mockMembers.set(PEER_ID, { identityPublicKey: DEVICE2 });
    vi.mocked(verifyEphemeralKeySignature).mockResolvedValueOnce(false);
    const offersBefore = sendsOfType(ws, "voice_e2ee_offer").length;
    const importsBefore = vi.mocked(importPublicKey).mock.calls.length;
    await mgr.handleAnnounce(PEER_ID, "Zm9yZ2Vk", "bad-sig");
    expect(setPeerVerification).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: PEER_ID, status: "mismatch" }),
    );
    expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(offersBefore);
    expect(vi.mocked(importPublicKey).mock.calls.length).toBe(importsBefore);
    expect(storeIdentityPin).toHaveBeenCalledTimes(2);
  });

  it("a peer whose socket dropped across a rotation is re-keyed with the rotated key when the server replays its announce", async () => {
    // Server side: hub.go re-relays the resumed client's stored announce to
    // the channel (TestRegisterNow_ReannouncesOwnKeyOnResume). Holder side,
    // pinned here: that replay is a duplicate announce, and the offer it
    // triggers must carry the CURRENT room key and epoch — not the key the
    // peer held before its outage.
    // Round-trip import/export so the replayed announce is recognised as the
    // SAME ephemeral key (the duplicate path), not a changed one.
    roundTripPeerKeys();
    try {
      const { ws, mgr } = newManager();
      await mgr.setupKeyExchange(true, 1);
      await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
      expect(mgr.epoch).toBe(1);

      // Peer's WebSocket drops (media stays up, so no participant-left); the
      // periodic rotation fires meanwhile.
      await mgr.rotateKeyPeriodically();
      expect(mgr.epoch).toBe(2);
      const rotatedKey = (mgr as any)._roomKey as Uint8Array;
      ws.send.mockClear();
      vi.mocked(wrapRoomKey).mockClear();
      vi.mocked(importPublicKey).mockClear();

      // Peer resumes; the server replays its unchanged announce to us.
      await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");

      expect(importPublicKey).not.toHaveBeenCalled(); // duplicate, not a new key
      const offers = sendsOfType(ws, "voice_e2ee_offer");
      expect(offers).toHaveLength(1);
      expect((offers[0] as any).payload.target_user_id).toBe(PEER_ID);
      expect(wrapRoomKey).toHaveBeenCalledTimes(1);
      const [, , wrappedKey, wrappedEpoch] = vi.mocked(wrapRoomKey).mock.calls[0]!;
      expect(wrappedKey).toBe(rotatedKey);
      expect(wrappedEpoch).toBe(2);
    } finally {
      restorePeerKeyMocks();
    }
  });
});

describe("E2EE operation ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetKey.mockResolvedValue(undefined);
    vi.mocked(getIdentityPin).mockResolvedValue({ status: "unpinned" });
    vi.mocked(getOrCreateIdentityKeyPair).mockResolvedValue(mockIdentityKeyPair);
    vi.mocked(authStore.getState).mockReturnValue({ user: { id: 1 } } as never);
    mockMembers.clear();
    mockMembers.set(PEER_ID, { identityPublicKey: "peer-identity-b64" });
    mockVoiceState.voiceUsers.clear();
  });

  it("commits the current session key after an unfinished offer import", async () => {
    const { mgr } = newManager();
    const appliedKeys: string[] = [];
    let appliedKey: string | undefined;
    const apply = (key: string) => {
      appliedKey = key;
      appliedKeys.push(key);
    };
    vi.mocked(roomKeyToBase64).mockImplementation((key) => `key-${key[0]}`);
    vi.mocked(generateRoomKey)
      .mockReturnValueOnce(new Uint8Array(32).fill(1))
      .mockReturnValueOnce(new Uint8Array(32).fill(2));
    vi.mocked(unwrapRoomKey).mockResolvedValueOnce({
      roomKey: new Uint8Array(32).fill(3),
      epoch: 9,
    });
    mockSetKey.mockImplementation(async (key: string) => apply(key));
    try {
      await mgr.setupKeyExchange(true, 1);
      await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
      let finishImport!: () => void;
      mockSetKey.mockImplementationOnce(
        (key: string) =>
          new Promise<void>((resolve) => {
            finishImport = () => {
              apply(key);
              resolve();
            };
          }),
      );
      const offer = mgr.handleOffer(PEER_ID, "enc", "iv");
      await vi.waitFor(() => expect(finishImport).toBeDefined());
      mgr.clearState();
      const newSetup = mgr.setupKeyExchange(true, 2);
      await vi.waitFor(() => expect(mgr.epoch).toBe(1));
      expect(mockSetKey).not.toHaveBeenCalledWith("key-2");
      finishImport();
      await Promise.all([offer, newSetup]);
      expect(appliedKeys).toEqual(["key-1", "key-3", "key-2"]);
      expect(appliedKey).toBe("key-2");
      expect((mgr as unknown as { _isKeyHolder: boolean })._isKeyHolder).toBe(true);
    } finally {
      mgr.clearState();
      vi.mocked(roomKeyToBase64).mockReturnValue("mock-room-key-base64");
    }
  });

  it("skips a queued provider key when its session has already ended", async () => {
    const { mgr } = newManager();
    vi.mocked(roomKeyToBase64).mockImplementation((key) => `key-${key[0]}`);
    vi.mocked(generateRoomKey)
      .mockReturnValueOnce(new Uint8Array(32).fill(1))
      .mockReturnValueOnce(new Uint8Array(32).fill(2))
      .mockReturnValueOnce(new Uint8Array(32).fill(3));
    try {
      let finishImport!: () => void;
      mockSetKey.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishImport = resolve;
          }),
      );
      const firstSetup = mgr.setupKeyExchange(true, 1);
      await vi.waitFor(() => expect(finishImport).toBeDefined());
      mgr.clearState();
      const secondSetup = mgr.setupKeyExchange(true, 2);
      await vi.waitFor(() => expect(mgr.epoch).toBe(1));
      mgr.clearState();
      const thirdSetup = mgr.setupKeyExchange(true, 3);
      await vi.waitFor(() => expect(mgr.epoch).toBe(1));
      finishImport();
      await expect(Promise.all([firstSetup, secondSetup, thirdSetup])).resolves.toEqual([
        false,
        false,
        true,
      ]);
      expect(mockSetKey.mock.calls.map(([key]) => key)).toEqual(["key-1", "key-3"]);
    } finally {
      mgr.clearState();
      vi.mocked(roomKeyToBase64).mockReturnValue("mock-room-key-base64");
    }
  });

  it("allows a later provider import after an earlier import fails", async () => {
    const { mgr } = newManager();
    try {
      mockSetKey.mockRejectedValueOnce(new Error("key import failed"));
      await expect(mgr.setupKeyExchange(true, 1)).rejects.toThrow("key import failed");
      mgr.clearState();
      await expect(mgr.setupKeyExchange(true, 2)).resolves.toBe(true);
      expect(mockSetKey).toHaveBeenCalledTimes(2);
    } finally {
      mgr.clearState();
    }
  });

  it("drains a deferred membership rotation when an offer supersedes a pending key", async () => {
    const { mgr } = newManager();
    const offeredKey = new Uint8Array(32).fill(4);
    try {
      await mgr.setupKeyExchange(true, 1);
      await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
      let finishImport!: () => void;
      mockSetKey.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishImport = resolve;
          }),
      );
      const rotation = mgr.rotateKeyPeriodically();
      await vi.waitFor(() => expect(finishImport).toBeDefined());
      vi.mocked(unwrapRoomKey).mockResolvedValueOnce({ roomKey: offeredKey, epoch: 8 });
      const offer = mgr.handleOffer(PEER_ID, "enc", "iv");
      await vi.waitFor(() =>
        expect((mgr as unknown as { _roomKey: Uint8Array })._roomKey).toBe(offeredKey),
      );
      await mgr.handleParticipantLeft(PEER_ID);
      expect(mgr.rotationPending).toBe(true);
      finishImport();
      await Promise.all([rotation, offer]);
      expect(mgr.epoch).toBe(3);
      expect(mgr.rotationPending).toBe(false);
      expect(mgr.rotatingKey).toBe(false);
      expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);
    } finally {
      mgr.clearState();
    }
  });

  it("keeps an unfinished current rotation guarded when an older session finishes", async () => {
    const { ws, mgr } = newManager();
    try {
      await mgr.setupKeyExchange(true, 1);
      let finishOldImport!: () => void;
      mockSetKey.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishOldImport = resolve;
          }),
      );
      const oldRotation = mgr.rotateKeyPeriodically();
      await vi.waitFor(() => expect(finishOldImport).toBeDefined());
      mgr.clearState();
      ws.send.mockClear();
      const newSetup = mgr.setupKeyExchange(false, 2);
      await vi.waitFor(() => expect(sendsOfType(ws, "voice_e2ee_announce")).toHaveLength(1));
      let finishCurrentImport!: () => void;
      mockSetKey.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishCurrentImport = resolve;
          }),
      );
      const currentRotation = mgr.handleParticipantLeft(99);
      expect(mgr.rotatingKey).toBe(true);
      finishOldImport();
      await oldRotation;
      await vi.waitFor(() => expect(finishCurrentImport).toBeDefined());
      expect(mgr.rotatingKey).toBe(true);
      finishCurrentImport();
      await Promise.all([currentRotation, newSetup]);
      expect(mgr.rotatingKey).toBe(false);
      expect(mgr.epoch).toBe(1);
    } finally {
      mgr.clearState();
    }
  });

  it("keeps queued announcements scoped to the call that received them", async () => {
    const { mgr } = newManager();
    try {
      await mgr.setupKeyExchange(true, 1);
      let releasePin!: (v: { status: "unpinned" }) => void;
      vi.mocked(getIdentityPin).mockReturnValueOnce(
        new Promise((resolve) => {
          releasePin = resolve;
        }),
      );
      const first = mgr.handleAnnounce(PEER_ID, "Zmlyc3Q=", "sig");
      await vi.waitFor(() => expect(getIdentityPin).toHaveBeenCalledTimes(1));
      const second = mgr.handleAnnounce(99, "c2Vjb25k", "sig");
      mgr.clearState();
      await mgr.setupKeyExchange(true, 2);
      releasePin({ status: "unpinned" });
      await Promise.all([first, second]);
      expect([...mgr.peerPublicKeys.keys()]).toEqual([]);
      expect(setPeerVerification).not.toHaveBeenCalled();
    } finally {
      mgr.clearState();
    }
  });

  it("keeps queued offers scoped to the call that received them", async () => {
    const { mgr } = newManager();
    try {
      await mgr.setupKeyExchange(true, 1);
      let releasePin!: (v: { status: "unpinned" }) => void;
      vi.mocked(getIdentityPin).mockReturnValueOnce(
        new Promise((resolve) => {
          releasePin = resolve;
        }),
      );
      const announce = mgr.handleAnnounce(PEER_ID, "Zmlyc3Q=", "sig");
      await vi.waitFor(() => expect(getIdentityPin).toHaveBeenCalledTimes(1));
      const offer = mgr.handleOffer(PEER_ID, "enc", "iv");
      mgr.clearState();
      await mgr.setupKeyExchange(true, 2);
      await mgr.handleAnnounce(PEER_ID, "c2Vjb25k", "sig");
      vi.mocked(unwrapRoomKey).mockClear();
      releasePin({ status: "unpinned" });
      await Promise.all([announce, offer]);
      expect(unwrapRoomKey).not.toHaveBeenCalled();
    } finally {
      mgr.clearState();
    }
  });

  it("stops an announcement drain when its call ends", async () => {
    const { mgr } = newManager();
    try {
      await mgr.handleAnnounce(PEER_ID, "Zmlyc3Q=", "sig");
      await mgr.handleAnnounce(99, "c2Vjb25k", "sig");
      let releasePin!: (v: { status: "unpinned" }) => void;
      vi.mocked(getIdentityPin).mockReturnValueOnce(
        new Promise((resolve) => {
          releasePin = resolve;
        }),
      );
      const firstSetup = mgr.setupKeyExchange(true, 1);
      await vi.waitFor(() => expect(getIdentityPin).toHaveBeenCalledTimes(1));
      mgr.clearState();
      await mgr.setupKeyExchange(true, 2);
      releasePin({ status: "unpinned" });
      await expect(firstSetup).resolves.toBe(false);
      expect([...mgr.peerPublicKeys.keys()]).toEqual([]);
    } finally {
      mgr.clearState();
    }
  });

  it("keeps verification scoped to the current membership and accepts a fresh rejoin", async () => {
    const { mgr } = newManager();
    try {
      await mgr.setupKeyExchange(true, 1);
      let releasePin!: (v: { status: "unpinned" }) => void;
      vi.mocked(getIdentityPin).mockReturnValueOnce(
        new Promise((resolve) => {
          releasePin = resolve;
        }),
      );
      const announce = mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
      await vi.waitFor(() => expect(getIdentityPin).toHaveBeenCalledTimes(1));
      await mgr.handleParticipantLeft(PEER_ID);
      releasePin({ status: "unpinned" });
      await announce;
      expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);
      expect(setPeerVerification).not.toHaveBeenCalled();
      await mgr.handleAnnounce(PEER_ID, "cmVqb2lu", "sig");
      expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);
    } finally {
      mgr.clearState();
    }
  });

  it("removes pre-keypair announcements when that membership ends", async () => {
    const { mgr } = newManager();
    try {
      await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
      await mgr.handleParticipantLeft(PEER_ID);
      expect(mgr.pendingAnnounces).toEqual([]);
      await mgr.setupKeyExchange(true, 1);
      expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);
    } finally {
      mgr.clearState();
    }
  });

  it("retains the current host identity when a superseded load completes", async () => {
    const ws = { send: vi.fn(), getState: () => "connected" };
    let host = "old.example.com";
    const mgr = new E2EEManager({
      getWs: () => ws as never,
      getServerHost: () => host,
      getCurrentChannelId: () => 1,
    });
    const oldIdentity = {
      publicKey: { type: "old-public" },
      privateKey: { type: "old-private" },
    } as unknown as CryptoKeyPair;
    const newIdentity = {
      publicKey: { type: "new-public" },
      privateKey: { type: "new-private" },
    } as unknown as CryptoKeyPair;
    try {
      let releaseIdentity!: (key: CryptoKeyPair) => void;
      vi.mocked(getOrCreateIdentityKeyPair).mockReturnValueOnce(
        new Promise((resolve) => {
          releaseIdentity = resolve;
        }),
      );
      vi.mocked(getOrCreateIdentityKeyPair).mockResolvedValue(newIdentity);
      const oldSetup = mgr.setupKeyExchange(true, 1);
      await vi.waitFor(() => expect(getOrCreateIdentityKeyPair).toHaveBeenCalledTimes(1));
      mgr.clearState();
      mgr.clearIdentityKeyPair();
      host = "new.example.com";
      await mgr.setupKeyExchange(true, 1);
      releaseIdentity(oldIdentity);
      await expect(oldSetup).resolves.toBe(false);
      vi.mocked(signEphemeralKey).mockClear();
      await mgr.reannounceForReconnect();
      expect(signEphemeralKey).toHaveBeenCalledWith(
        newIdentity.privateKey,
        1,
        expect.any(Uint8Array),
      );
    } finally {
      mgr.clearState();
    }
  });

  it("uses the current account identity on a shared host", async () => {
    const { mgr } = newManager();
    const secondIdentity = {
      publicKey: { type: "second-public" },
      privateKey: { type: "second-private" },
    } as unknown as CryptoKeyPair;
    try {
      await mgr.setupKeyExchange(true, 1);
      mgr.clearState();
      vi.mocked(authStore.getState).mockReturnValue({ user: { id: 2 } } as never);
      vi.mocked(getOrCreateIdentityKeyPair).mockResolvedValueOnce(secondIdentity);
      await mgr.setupKeyExchange(true, 1);
      expect(getOrCreateIdentityKeyPair).toHaveBeenLastCalledWith("localhost:7880", 2);
      expect(signEphemeralKey).toHaveBeenLastCalledWith(
        secondIdentity.privateKey,
        2,
        expect.any(Uint8Array),
      );
    } finally {
      mgr.clearState();
      vi.mocked(authStore.getState).mockReturnValue({ user: { id: 1 } } as never);
    }
  });

  it("still rotates the room key when a second voice_leave for the same peer lands mid-retirement", async () => {
    const { mgr } = newManager();
    try {
      await mgr.setupKeyExchange(true, 1); // epoch 1, holder
      await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
      expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(true);

      let releaseExport!: (v: string) => void;
      vi.mocked(exportPublicKey).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseExport = resolve;
          }),
      );

      // First voice_leave for PEER_ID: deletes the peer key synchronously,
      // then suspends on exportPublicKey(departingKey) before reaching the
      // election / membership-forward-secrecy rekey block.
      const firstLeave = mgr.handleParticipantLeft(PEER_ID);
      await vi.waitFor(() => expect(releaseExport).toBeDefined());
      expect(mgr.peerPublicKeys.has(PEER_ID)).toBe(false);

      // A second voice_leave for the SAME peer (server resend + local
      // reconciliation both firing handleParticipantLeft) lands and runs to
      // completion before the first resumes: departingKey is already gone,
      // so its own hadPeerKey is false and it rotates nothing — but it DOES
      // bump this peer's generation counter.
      await mgr.handleParticipantLeft(PEER_ID);

      releaseExport("bW9ja2VwaGVtZXJhbA==");
      await firstLeave;

      // The first invocation observed hadPeerKey=true while still the key
      // holder — membership forward secrecy requires it to still rotate the
      // room key even though the peer generation moved on under it during
      // the await, which must only skip the (now-redundant) retirement
      // write, not the whole handler.
      expect(mgr.epoch).toBe(2);
      expect(mockSetKey).toHaveBeenCalledWith("mock-room-key-base64");
    } finally {
      mgr.clearState();
    }
  });

  it("abandons the whole handler when the SESSION is torn down mid-retirement", async () => {
    // The companion to OC-0416. peerAttemptIsCurrent() conflates two very
    // different reasons to go stale: a duplicate leave for the same peer
    // (harmless — this invocation's own captures stay correct, so only the
    // redundant retirement write is skipped) and a clearState() that ended
    // the session entirely. The second must still abort everything: the
    // captured channelId and roster now describe a room that no longer
    // exists, and electing a holder or rotating _roomKey off them writes
    // teardown-violating state that a freshly joined room then inherits.
    const { mgr } = newManager();
    try {
      await mgr.setupKeyExchange(true, 1);
      await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");

      let releaseExport!: (v: string) => void;
      vi.mocked(exportPublicKey).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseExport = resolve;
          }),
      );

      const leave = mgr.handleParticipantLeft(PEER_ID);
      await vi.waitFor(() => expect(releaseExport).toBeDefined());

      // The local user leaves voice (or switches rooms) while the export is
      // still pending: clearState() bumps the session generation and resets
      // _isKeyHolder, _roomKey and the epoch.
      mgr.clearState();
      mockSetKey.mockClear();

      releaseExport("bW9ja2VwaGVtZXJhbA==");
      await leave;

      // Nothing from the dead session may land on the torn-down manager.
      expect(mgr.epoch).toBe(0);
      expect(mockSetKey).not.toHaveBeenCalled();
      expect(mgr.rotatingKey).toBe(false);
    } finally {
      mgr.clearState();
    }
  });
});

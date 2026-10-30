import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/livekitSessionMocks";
import { LiveKitSession } from "../../../src/lib/voice/livekitSession";
import { setPeerVerification, setEncryptionDegraded } from "@stores/voice.store";
import { getIdentityPin, storeIdentityPin } from "@lib/net/identity";
import { verifyEphemeralKeySignature } from "@lib/net/e2eeCrypto";
import { setMembers } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import type { ReadyMember } from "../../../src/lib/types";
import { useLiveKitSessionHarness } from "../../helpers/livekitSessionHarness";

vi.mock("livekit-client", () => mocks.livekitClientMock());
vi.mock("@stores/voice.store", () => mocks.voiceStoreMock());
vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@lib/prefs/preferences", (importOriginal) => mocks.prefsPreferencesMock(importOriginal));
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/noiseSuppression", () => mocks.voiceNoiseSuppressionMock());
vi.mock("@lib/net/e2eeCrypto", () => mocks.netE2eeCryptoMock());
vi.mock("@lib/net/identity", () => mocks.netIdentityMock());

const { mockVoiceState, mockRoom } = mocks;

describe("LiveKitSession", () => {
  let session: LiveKitSession;

  useLiveKitSessionHarness({
    wired: (s) => {
      session = s;
    },
    currentSession: () => session,
  });

  describe("E2EE worker lifecycle", () => {
    // The key provider lives for the whole process while livekit registers a
    // new SetKey listener on it per Room — with no matching removal — and the
    // per-room E2EE Worker is never terminated. Without explicit teardown,
    // every join/switch/reconnect-attempt leaks a running worker that keeps
    // receiving every future room key via setKey fan-out.
    it("clears stale provider listeners and terminates the previous worker on createRoom", () => {
      (session as any).createRoom();
      const workerMock = globalThis.Worker as unknown as ReturnType<typeof vi.fn>;
      const worker1 = workerMock.mock.instances.at(-1) as unknown as { terminate: () => void };

      (session as any).createRoom();

      expect(worker1.terminate).toHaveBeenCalled();
      const provider = (session as any)._e2ee.keyProvider;
      expect(provider.removeAllListeners).toHaveBeenCalled();
    });

    it("terminates the current worker on leaveVoice so the last room key does not stay resident", () => {
      (session as any).createRoom();
      const workerMock = globalThis.Worker as unknown as ReturnType<typeof vi.fn>;
      const worker = workerMock.mock.instances.at(-1) as unknown as { terminate: () => void };

      session.leaveVoice(false);

      expect(worker.terminate).toHaveBeenCalled();
    });

    // OC-0095: room.setE2EEEnabled(true) was never called anywhere, so the
    // key exchange (ECDH/HKDF/AES-GCM, TOFU identity, key-holder rotation)
    // ran end-to-end but every media frame still reached the SFU in
    // plaintext — the local cryptor stayed disabled.
    it("enables E2EE on the room created by createRoom", async () => {
      mockRoom.setE2EEEnabled.mockClear();

      await (session as any).createRoom();

      expect(mockRoom.setE2EEEnabled).toHaveBeenCalledWith(true);
    });

    it("enables E2EE on the room used for a normal voice join", async () => {
      mockRoom.setE2EEEnabled.mockClear();
      session.setServerHost("localhost:7880");
      mockRoom.connect.mockResolvedValue(undefined);

      await session.handleVoiceToken("token", "/livekit", 1, "ws://localhost:7880", true);

      expect(mockRoom.setE2EEEnabled).toHaveBeenCalledWith(true);
    });

    // OC-0002: a dead E2EE worker (CSP block, WASM load failure, WebView2
    // quirk) fails asynchronously, after keyProvider.setKey already resolved
    // and voiceStatus already reached "connected" — livekit-client's own
    // signal for this is RoomEvent.EncryptionError (E2eeManager.onWorkerError).
    // Nothing subscribed to it, so the Secured badge had no way to ever know.
    it("wires an EncryptionError listener onto the room so a dead worker cannot stay invisible", async () => {
      mockRoom.on.mockClear();
      (setEncryptionDegraded as ReturnType<typeof vi.fn>).mockClear();

      await (session as any).createRoom();

      const call = mockRoom.on.mock.calls.find((c: unknown[]) => c[0] === "encryptionError");
      expect(call).toBeDefined();

      const handler = call![1] as (error: Error) => void;
      handler(new Error("e2ee worker crashed"));

      expect(setEncryptionDegraded).toHaveBeenCalledWith(true);
    });
  });

  // -----------------------------------------------------------------------
  // F3: Voice E2EE identity-key signing + TOFU verification (receive path)
  // -----------------------------------------------------------------------

  describe("E2EE announce verification (F3 TOFU)", () => {
    const HOST = "localhost:7880";
    const PEER_ID = 42;

    function seedPeer(identityPublicKey: string | null): void {
      const peer: ReadyMember = {
        id: PEER_ID,
        username: "peer",
        avatar: null,
        role: "member",
        status: "online",
        identity_public_key: identityPublicKey,
      };
      setMembers([peer]);
    }

    async function joinAsKeyHolder(ws: { send: ReturnType<typeof vi.fn> }): Promise<void> {
      session.setServerHost(HOST);
      session.setWsClient(ws as any);
      await session.handleVoiceToken("tok", "/lk", 1, "ws://localhost:7880", true);
    }

    function offerSends(ws: { send: ReturnType<typeof vi.fn> }): unknown[] {
      return ws.send.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === "voice_e2ee_offer");
    }

    beforeEach(() => {
      // Restore TOFU mock defaults — persistent overrides survive clearAllMocks.
      (getIdentityPin as any).mockResolvedValue({ status: "unpinned" });
      (storeIdentityPin as any).mockResolvedValue(true);
      (verifyEphemeralKeySignature as any).mockResolvedValue(true);
      // Joining voice requires an authenticated session, and the identity
      // keypair is scoped by host AND user id — with no user the announce is
      // deliberately sent unsigned rather than scoped under a placeholder id.
      // Kept below PEER_ID so key-holder election (lowest id wins) is unchanged.
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 1, username: "me", role: "member" } as never,
        isAuthenticated: true,
      }));
    });

    afterEach(() => {
      // Do not leak the authenticated user into the rest of the file — an
      // earlier bug in this suite was one test leaving a role set for every
      // test after it.
      authStore.setState((prev) => ({ ...prev, user: null, isAuthenticated: false }));
    });

    it("signs the ephemeral announce sent on join", async () => {
      seedPeer("peer-identity-b64");
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);

      const announce = ws.send.mock.calls
        .map((c) => c[0])
        .find((m: any) => m?.type === "voice_e2ee_announce");
      expect(announce).toBeDefined();
      expect((announce as any).payload.signature).toBe("mock-signature");
    });

    it("rejects a server-substituted peer ephemeral key (signature verify fails)", async () => {
      seedPeer("peer-identity-b64");
      (verifyEphemeralKeySignature as any).mockResolvedValue(false);
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      ws.send.mockClear();

      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");

      // No room-key offer wrapped for an unverifiable peer, key not stored.
      expect(offerSends(ws)).toHaveLength(0);
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(false);
      expect(setPeerVerification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "mismatch" }),
      );
      expect(storeIdentityPin).not.toHaveBeenCalled();
    });

    it("pins the peer identity key on first sight and marks it verified", async () => {
      seedPeer("peer-identity-b64");
      (getIdentityPin as any).mockResolvedValue({ status: "unpinned" });
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      ws.send.mockClear();

      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");

      expect(storeIdentityPin).toHaveBeenCalledWith(HOST, String(PEER_ID), "peer-identity-b64");
      expect(setPeerVerification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: PEER_ID,
          status: "verified",
          safetyNumber: "AB12 CD34 EF56 7890",
        }),
      );
      // Verified peer is stored and (we are key holder) receives a room-key offer.
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(true);
      expect(offerSends(ws)).toHaveLength(1);
    });

    it("accepts a changed identity key automatically: verifies against it, re-pins, keys the peer", async () => {
      seedPeer("new-identity-b64");
      (getIdentityPin as any).mockResolvedValue({ status: "pinned", pin: "old-identity-b64" });
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      ws.send.mockClear();

      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");

      // The announce must verify against the NEW key before it is pinned.
      expect(verifyEphemeralKeySignature).toHaveBeenCalledTimes(1);
      expect(storeIdentityPin).toHaveBeenCalledWith(HOST, String(PEER_ID), "new-identity-b64");
      expect(setPeerVerification).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "changed" }),
      );
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(true);
      expect(offerSends(ws)).toHaveLength(1);
    });

    it("fails closed when the pin store cannot be read: rejects, never re-pins", async () => {
      // A transient keyring error used to read as "no pin stored", sending the
      // peer down the first-sight path — verifying against and RE-PINNING the
      // server-delivered key. With the pin unknown, no trust decision is
      // possible: reject the announce and surface the distinct "unknown" state.
      seedPeer("peer-identity-b64");
      (getIdentityPin as any).mockResolvedValue({ status: "unavailable" });
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      ws.send.mockClear();
      (storeIdentityPin as any).mockClear();

      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");

      expect(setPeerVerification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "unknown", safetyNumber: null }),
      );
      // Not treated as first sight: no signature check, no pin write, no key
      // stored, no room-key offer.
      expect(verifyEphemeralKeySignature).not.toHaveBeenCalled();
      expect(storeIdentityPin).not.toHaveBeenCalled();
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(false);
      expect(offerSends(ws)).toHaveLength(0);
    });

    it("blocks a pinned peer when the server strips its published identity key", async () => {
      // Peer was pinned before; the server now omits identity_public_key to
      // shove the peer onto the legacy accept path (finding #2). A pinned peer
      // must never fall back to legacy — this is an identity mismatch.
      seedPeer(null);
      (getIdentityPin as any).mockResolvedValue({ status: "pinned", pin: "old-identity-b64" });
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      ws.send.mockClear();

      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");

      expect(setPeerVerification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "mismatch" }),
      );
      // Blocked: not accepted as legacy/unverified, key not stored, no offer.
      expect(setPeerVerification).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "unverified" }),
      );
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(false);
      expect(offerSends(ws)).toHaveLength(0);
      expect(storeIdentityPin).not.toHaveBeenCalled();
      expect(verifyEphemeralKeySignature).not.toHaveBeenCalled();
    });

    it("accepts a legacy peer with no identity key but marks it unverified", async () => {
      seedPeer(null);
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      ws.send.mockClear();

      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", undefined);

      expect(setPeerVerification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "unverified", safetyNumber: null }),
      );
      // Legacy peer still works: stored + wrapped, without verify or pin.
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(true);
      expect(offerSends(ws)).toHaveLength(1);
      expect(verifyEphemeralKeySignature).not.toHaveBeenCalled();
      expect(storeIdentityPin).not.toHaveBeenCalled();
    });

    it("re-pin recovers a peer blocked for a missing key once a key is delivered again", async () => {
      // The server stopped delivering a pinned peer's identity key → blocked.
      seedPeer(null);
      (getIdentityPin as any).mockResolvedValue({ status: "pinned", pin: "old-identity-b64" });
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      ws.send.mockClear();

      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");
      expect(setPeerVerification).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "mismatch" }),
      );
      expect(offerSends(ws)).toHaveLength(0);

      // A key is delivered again and the user trusts it: re-pin overwrites the
      // stored pin with that key and replays the blocked announce against it.
      seedPeer("new-identity-b64");
      (getIdentityPin as any).mockResolvedValue({ status: "pinned", pin: "new-identity-b64" });
      const recovered = await session.rePinPeerIdentity(PEER_ID, "new-identity-b64");
      expect(recovered).toBe(true);
      expect(storeIdentityPin).toHaveBeenCalledWith(HOST, String(PEER_ID), "new-identity-b64");

      expect(setPeerVerification).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: PEER_ID, status: "verified" }),
      );
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(true);
      expect(offerSends(ws)).toHaveLength(1);
    });

    it("re-pins the verified key, not a store re-read a malicious server mutated (TOCTOU)", async () => {
      // The store holds whatever the server most recently pushed. If re-pin
      // re-read the store it would pin the attacker's swapped-in key; it must
      // instead pin the exact key it was handed — the one whose fingerprint the
      // user verified out-of-band.
      seedPeer("attacker-swapped-key-b64");
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);

      const pinned = await session.rePinPeerIdentity(PEER_ID, "verified-key-b64");

      expect(pinned).toBe(true);
      expect(storeIdentityPin).toHaveBeenCalledWith(HOST, String(PEER_ID), "verified-key-b64");
      expect(storeIdentityPin).not.toHaveBeenCalledWith(
        HOST,
        String(PEER_ID),
        "attacker-swapped-key-b64",
      );
    });

    it("rotates the room key when a keyed peer leaves while I stay key holder (forward secrecy)", async () => {
      seedPeer("peer-identity-b64");
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws); // I hold the key for channel 1
      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig"); // peer now holds the room key
      // A participant remains, so the leave handler proceeds past the empty check.
      (mockVoiceState as any).voiceUsers = new Map([[1, new Map([[1, {}]])]]);
      const epochBefore = (session as any)._e2eeEpoch;

      await session.handleParticipantLeft(PEER_ID);

      // Room key rotated (epoch advanced) so the departed peer's copy is dead.
      expect((session as any)._e2eeEpoch).toBe(epochBefore + 1);
    });

    it("does not rotate the room key when the leaver never held it", async () => {
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      (mockVoiceState as any).voiceUsers = new Map([[1, new Map([[1, {}]])]]);
      const epochBefore = (session as any)._e2eeEpoch;

      await session.handleParticipantLeft(999); // 999 never announced → held no key

      expect((session as any)._e2eeEpoch).toBe(epochBefore);
    });

    it("defers a keyed-peer leave rotation instead of dropping it when one is in flight", async () => {
      seedPeer("peer-identity-b64");
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig"); // peer holds the room key
      (mockVoiceState as any).voiceUsers = new Map([[1, new Map([[1, {}]])]]);
      // A rotation is already in flight (e.g. an earlier peer's leave).
      (session as any)._rotatingKey = true;
      const epochBefore = (session as any)._e2eeEpoch;

      await session.handleParticipantLeft(PEER_ID);

      // Not dropped by the _rotatingKey guard: the rekey is queued and no second
      // rotation ran underneath the in-flight one.
      expect((session as any)._rotationPending).toBe(true);
      expect((session as any)._e2eeEpoch).toBe(epochBefore);
    });

    it("runs the deferred rotation once the in-flight one completes", async () => {
      const ws = { send: vi.fn() };
      await joinAsKeyHolder(ws);
      (mockVoiceState as any).voiceUsers = new Map([[1, new Map([[1, {}]])]]);
      // A keyed-peer leave was deferred while a rotation was in flight.
      (session as any)._rotationPending = true;
      const epochBefore = (session as any)._e2eeEpoch;

      // The completing rotation must drain the pending one (excludes the leaver).
      await (session as any).rotateKeyPeriodically();

      expect((session as any)._e2eeEpoch).toBe(epochBefore + 2);
      expect((session as any)._rotationPending).toBe(false);
    });

    it("verifies a server-substituted key when drained from the pending queue", async () => {
      seedPeer("peer-identity-b64");
      (verifyEphemeralKeySignature as any).mockResolvedValue(false);
      const ws = { send: vi.fn() };
      // Announce arrives BEFORE the keypair is ready → queued, drained on join.
      await session.handleE2EEAnnounce(PEER_ID, "cGVlcg==", "sig");
      expect((session as any)._pendingAnnounces).toHaveLength(1);

      await joinAsKeyHolder(ws);

      // Drain ran through the verifying path → substituted key rejected.
      expect((session as any)._peerPublicKeys.has(PEER_ID)).toBe(false);
      expect(offerSends(ws)).toHaveLength(0);
    });
  });
});

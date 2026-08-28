// LiveKit E2EE manager — client-side ECDH key exchange extracted from livekitSession.ts.
// Owns the E2EE state (ephemeral keypair, room key, peer keys, rotation timers)
// and the key-exchange protocol: identity signing / TOFU pin verification (F3),
// announce/offer handling, and room-key generation/rotation.
import { ExternalE2EEKeyProvider } from "livekit-client";
import type { WsClient } from "@lib/ws";
import {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  generateRoomKey,
  roomKeyToBase64,
  wrapRoomKey,
  unwrapRoomKey,
  signEphemeralKey,
  verifyEphemeralKeySignature,
  importIdentityPublicKey,
  computeKeyFingerprint,
  computeRawKeyFingerprint,
} from "@lib/e2eeCrypto";
import { getOrCreateIdentityKeyPair, getIdentityPin, storeIdentityPin } from "@lib/identity";
import { authStore } from "@stores/auth.store";
import { membersStore } from "@stores/members.store";
import {
  voiceStore,
  setPeerVerification,
  clearPeerVerification,
  clearPeerVerifications,
  setLocalSessionFingerprint,
} from "@stores/voice.store";
import { createLogger } from "@lib/logger";

const log = createLogger("livekitE2EE");

// --- Dependencies passed from LiveKitSession ---

export interface E2EEDeps {
  getWs: () => WsClient | null;
  getServerHost: () => string | null;
  getCurrentChannelId: () => number | null;
}

// --- E2EEManager class ---

export class E2EEManager {
  /** E2EE key provider — shared across Room instances. The room key is generated
   *  and exchanged client-side via ECDH; the server never sees it. */
  readonly keyProvider = new ExternalE2EEKeyProvider();

  // ── Client-side E2EE state (ECDH key exchange) ───────────────────────────
  /** Ephemeral ECDH P-256 keypair for the current voice session. */
  private _ecdhKeyPair: CryptoKeyPair | null = null;
  /** The 256-bit symmetric room key (plaintext). Only held by the key holder
   *  initially; other participants receive it via ECDH-wrapped offers. */
  private _roomKey: Uint8Array | null = null;
  /** Peer ECDH public keys indexed by userId. */
  private _peerPublicKeys: Map<number, CryptoKey> = new Map();
  /** Ephemeral keys we've seen superseded for a given peer this session
   *  (base64), indexed by userId. A signed announce carries no channel/epoch/
   *  nonce (F3), so a validly-signed announce replays cleanly — this blocks a
   *  replay of a key we already moved a peer off of from overwriting their
   *  current live key (OC-0011). */
  private _retiredPeerKeys: Map<number, Set<string>> = new Map();
  /** Highest offer epoch applied per sender (OC-0001). The holder binds its
   *  epoch into every wrapped room key; an offer below this mark is a
   *  superseded key and is discarded. Per sender because each client's epoch
   *  counter is local; reset when that sender's ephemeral key is replaced. */
  private _peerOfferEpochs: Map<number, number> = new Map();
  /** This client's long-term ECDSA identity keypair (F3 TOFU), used to sign our
   *  ephemeral announces. Loaded lazily from the OS keyring, cached per session. */
  private _identityKeyPair: CryptoKeyPair | null = null;
  /** True if this client is the key holder (longest-present participant). */
  private _isKeyHolder = false;
  /** Channel this exchange runs in, set at setupKeyExchange entry. The session
   *  facade publishes its channel id only once "connected", which is after the
   *  whole key-exchange wait — key-holder re-elections arriving in that window
   *  must not be dropped for lack of a channel id. */
  private _channelId: number | null = null;
  /** Resolver/rejector for non-key-holders waiting to receive the room key via offer. */
  private _roomKeyResolver: (() => void) | null = null;
  private _roomKeyRejector: ((err: Error) => void) | null = null;
  /** Guard: true while a key rotation is in progress (prevents concurrent rotations). */
  private _rotatingKey = false;
  /** Set when a keyed-peer leave coincides with an in-flight rotation: the rekey
   *  is deferred (not dropped) and re-run when the current rotation finishes, so
   *  a member that left mid-rotation is excluded from the fresh room key. */
  private _rotationPending = false;
  /** Monotonic counter incremented on every key rotation. handleOffer captures the
   *  epoch before async work and discards the result if epoch changed (stale offer). */
  private _e2eeEpoch = 0;
  /** Announces that arrived before our ECDH keypair was ready. Drained after keypair init. */
  private _pendingAnnounces: Array<{
    userId: number;
    publicKeyBase64: string;
    signatureBase64?: string;
  }> = [];
  /** Announce that verifyPeerAnnounce rejected as a TOFU pin mismatch, keyed
   *  by userId — buffered so a subsequent successful rePinPeerIdentity can
   *  replay it instead of leaving the recovery a no-op for the live call
   *  (OC-0212): a mid-call peer never re-announces on its own, so nothing
   *  else would re-run verification against the freshly-stored pin. At most
   *  one entry per peer; a later mismatch (or a later legitimate announce)
   *  simply overwrites the previous one. Cleared in clearState(). */
  private _blockedAnnounces: Map<number, { publicKeyBase64: string; signatureBase64?: string }> =
    new Map();
  /** Periodic key rotation timer — fires every KEY_ROTATION_INTERVAL_MS when key holder. */
  private _keyRotationTimer: ReturnType<typeof setTimeout> | null = null;
  /** Interval between periodic key rotations (5 minutes). */
  private static readonly KEY_ROTATION_INTERVAL_MS = 5 * 60 * 1000;
  /** Bumped every time clearState() tears down a session. An in-flight
   *  setupKeyExchange/reannounceForReconnect captures this before its first
   *  await and re-checks it before publishing to this._ecdhKeyPair — a plain
   *  `this._ecdhKeyPair === null` check can't see a teardown-then-restart
   *  that happens entirely during those awaits, since nothing is null by the
   *  time the abandoned attempt resumes. */
  private _sessionGeneration = 0;

  constructor(private deps: E2EEDeps) {}

  // --- Internal state accessors (used by LiveKitSession's test-compat proxies) ---

  get peerPublicKeys(): Map<number, CryptoKey> {
    return this._peerPublicKeys;
  }
  get epoch(): number {
    return this._e2eeEpoch;
  }
  get rotatingKey(): boolean {
    return this._rotatingKey;
  }
  set rotatingKey(value: boolean) {
    this._rotatingKey = value;
  }
  get rotationPending(): boolean {
    return this._rotationPending;
  }
  set rotationPending(value: boolean) {
    this._rotationPending = value;
  }
  get pendingAnnounces(): Array<{
    userId: number;
    publicKeyBase64: string;
    signatureBase64?: string;
  }> {
    return this._pendingAnnounces;
  }

  // ── Join-time key exchange ───────────────────────────────────────────────

  /**
   * Run the client-side E2EE key exchange for a join (called from
   * connectAndSetup before room.connect). Generates a fresh ECDH keypair,
   * drains queued announces, then either generates the room key (key holder)
   * or announces and waits for the key holder's offer.
   *
   * Returns false when the key exchange timed out after retry — the caller
   * surfaces the "e2ee_timeout" error and leaves voice.
   */
  async setupKeyExchange(isKeyHolder: boolean, channelId: number): Promise<boolean> {
    // Captured before any await so a clearState() that lands anywhere below
    // (before we publish this._ecdhKeyPair) can be detected even though
    // nothing about our local state is null yet — see the field comment.
    const myGeneration = this._sessionGeneration;
    this._channelId = channelId;
    // Generate a fresh ECDH keypair for this session, but keep it local and
    // do NOT publish it to this._ecdhKeyPair until right before the drain
    // below (after _isKeyHolder/_roomKey are ready). Until then,
    // handleAnnounce's `!this._ecdhKeyPair` guard queues any announce that
    // arrives concurrently instead of running it through the live path —
    // where it would be stored in _peerPublicKeys but sent no offer (isKeyHolder
    // /roomKey not set up yet) and then never seen by the drain either (it was
    // never queued), stranding that peer until the next 5-minute rotation.
    const ecdhKeyPair = await generateECDHKeyPair();
    // Superseded already? Everything below this point mutates state a newer
    // session owns, so bail before the first write — clearing the live
    // session's peer keys/verifications would drop every subsequent rotation
    // for those peers (handleOffer's unknown-peer guard).
    if (this._sessionGeneration !== myGeneration) {
      log.warn("E2EE: setup superseded during keypair generation — aborting", { channelId });
      return false;
    }
    this._peerPublicKeys.clear();
    this._retiredPeerKeys.clear();
    this._peerOfferEpochs.clear();
    clearPeerVerifications();
    const myPubKeyBase64 = await exportPublicKey(ecdhKeyPair.publicKey);
    const myFingerprint = await computeRawKeyFingerprint(this.rawFromBase64(myPubKeyBase64));
    // Build the signed announce up front — this loads the identity key from
    // the keyring once, so the added identity round-trip does NOT stack on
    // the non-key-holder's 10s key-exchange stall below (F3).
    const announcePayload = await this.buildAnnouncePayload(myPubKeyBase64);

    // Same check again after the keyring round trip — the widest window of
    // the three, and the next statements install OUR role and room key over
    // whatever session is live now: a superseded non-holder attempt would
    // clear the live holder's _isKeyHolder (silently stopping its rotations
    // and its offers to new peers), and a superseded holder attempt would
    // push a room key nobody else has onto the shared key provider.
    if (this._sessionGeneration !== myGeneration) {
      log.warn("E2EE: setup superseded before key-holder setup — aborting", { channelId });
      return false;
    }

    // Use server-authoritative is_key_holder from voice_token payload — OR'd
    // with whatever this._isKeyHolder already is. The server value was
    // captured when we started joining and cannot see a handleParticipantLeft
    // promotion that landed during the awaits above: the generation check
    // just above proves no clearState() ran since myGeneration was captured,
    // so the only other writer of this field for THIS generation is that
    // promotion — unconditionally overwriting it with the stale server value
    // strands the newly-elected holder waiting for an offer nobody (least of
    // all itself) will ever send, timing out and ejecting it from voice.
    this._isKeyHolder = isKeyHolder || this._isKeyHolder;

    if (this._isKeyHolder) {
      // Generate the room key BEFORE draining queued announces, so the
      // drain's handleAnnounce calls hit the wrap-and-offer branch and every
      // drained peer receives the fresh key immediately. Mid-call peers never
      // re-announce (handleAnnounce replies with an offer, not a
      // counter-announce), so the only later delivery would be the 5-minute
      // rotation timer — stranding them on a dead key whenever a new key
      // holder joins an ongoing call.
      this._e2eeEpoch++;
      this._roomKey = generateRoomKey();
      await this.keyProvider.setKey(roomKeyToBase64(this._roomKey));
      log.info("E2EE: key holder — generated room key", { channelId });
      this.startKeyRotationTimer();
    }

    // And once more after keyProvider.setKey's await: a torn-down attempt
    // that resurrects this._ecdhKeyPair here would defeat the queue guard in
    // handleAnnounceInner and go on to announce a dead ephemeral key over a
    // live call (finding v043).
    if (this._sessionGeneration !== myGeneration) {
      log.warn("E2EE: setup superseded before keypair publish — aborting", { channelId });
      return false;
    }

    // Publish the keypair now — right before the drain, so every announce
    // that arrived during the awaits above was queued (not silently
    // processed with no offer sent) and gets its offer sent below.
    this._ecdhKeyPair = ecdhKeyPair;
    setLocalSessionFingerprint(myFingerprint);

    if (this._isKeyHolder) {
      // Announce our (signed) key BEFORE draining queued announces. The
      // drain below sends each drained peer a voice_e2ee_offer, and the
      // receiver can only unwrap it once it has OUR ephemeral public key on
      // file — which only our own announce provides. The relayed announce
      // and our offer land in the SAME inbound WS queue on the peer's side
      // (voice_join relay and the offer send both go through the peer's
      // c.send queue), so the send order here is the delivery order there.
      // Announcing AFTER the drain (the old order) meant every existing
      // participant's handleOfferInner discarded our offer as "unknown
      // peer" and never recovered short of the 5-minute rotation (OC-0098).
      this.deps.getWs()?.send({ type: "voice_e2ee_announce", payload: announcePayload });
    }

    // Drain any announces that arrived before our keypair was ready. These
    // are existing participants whose keys the server relayed during
    // voice_join sync — run them through the normal verifying receive path
    // so a server-substituted peer key is caught here too.
    const queued = this._pendingAnnounces.splice(0);
    for (const { userId: qId, publicKeyBase64: qKey, signatureBase64: qSig } of queued) {
      // oxlint-disable-next-line no-await-in-loop -- sequential drain: verify each queued announce
      await this.handleAnnounce(qId, qKey, qSig);
      log.info("E2EE: drained queued announce", { userId: qId });
    }

    if (!this._isKeyHolder) {
      // Wait for the key holder to send us the room key via voice_e2ee_offer.
      // This promise resolves when handleOffer() sets _roomKey.
      log.info("E2EE: waiting for room key from key holder", { channelId });
      const roomKeyPromise = new Promise<void>((resolve, reject) => {
        this._roomKeyResolver = resolve;
        this._roomKeyRejector = reject;
      });
      // Announce BEFORE waiting (moved earlier per F3) so the key holder can
      // offer immediately. The resolver is set above, so an immediate offer
      // won't be missed.
      this.deps.getWs()?.send({ type: "voice_e2ee_announce", payload: announcePayload });
      // Wait up to 10s for the key holder to send an offer. If the first
      // attempt times out, re-announce our public key (the offer may have been
      // lost if the key holder disconnected mid-send) and wait 5s more.
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const makeTimeout = (ms: number) =>
        new Promise<void>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("E2EE key exchange timeout")), ms);
        });
      try {
        await Promise.race([roomKeyPromise, makeTimeout(10_000)]);
      } catch {
        // First attempt failed — re-announce and retry once. This also
        // catches a decrypt failure in handleOfferInner (which rejects
        // roomKeyPromise directly), not just a genuine timeout.
        if (timeoutId !== null) clearTimeout(timeoutId);
        // clearState() (e.g. the user left voice) also rejects roomKeyPromise
        // and, unlike a decrypt failure, nulls _ecdhKeyPair — there is nobody
        // left to retry with. Stop here instead of re-announcing into a torn-
        // down session and reinstalling a resolver nothing will ever call.
        // Compare by identity, not just null: a torn-down-then-restarted
        // session can leave this._ecdhKeyPair non-null but owned by a
        // completely different (superseded) attempt — retrying would
        // re-announce our dead ephemeral key over that live session and
        // steal its single _roomKeyResolver slot (finding v043).
        if (this._ecdhKeyPair !== ecdhKeyPair) {
          log.warn("E2EE: key exchange aborted (session cleared or superseded)", { channelId });
          return false;
        }
        log.warn("E2EE: first key exchange attempt timed out, re-announcing", { channelId });
        this.deps.getWs()?.send({ type: "voice_e2ee_announce", payload: announcePayload });
        // roomKeyPromise may already be SETTLED (rejected) at this point — a
        // decrypt failure rejects it permanently, so racing the SAME promise
        // again would resolve rejected on the very next microtask instead of
        // giving the retry its intended 5s window. Create a fresh promise and
        // reinstall the resolver/rejector before racing again.
        const retryPromise = new Promise<void>((resolve, reject) => {
          this._roomKeyResolver = resolve;
          this._roomKeyRejector = reject;
        });
        try {
          await Promise.race([retryPromise, makeTimeout(5_000)]);
        } catch {
          log.error("E2EE: key exchange timed out after retry — disconnecting", { channelId });
          this._roomKeyResolver = null;
          this._roomKeyRejector = null;
          if (timeoutId !== null) clearTimeout(timeoutId);
          return false;
        }
      } finally {
        if (timeoutId !== null) clearTimeout(timeoutId);
      }
      this._roomKeyResolver = null;
      this._roomKeyRejector = null;
    }
    return true;
  }

  /**
   * E2EE re-setup for auto-reconnect: regenerate the ECDH keypair for the new
   * session (forward secrecy) and re-announce so other participants can re-wrap
   * the room key for us. If we still have the room key from before disconnect,
   * re-apply it now so audio works immediately; the key holder will send a
   * fresh offer if the key was rotated during our absence.
   */
  async reannounceForReconnect(): Promise<void> {
    // Captured before any await so a clearState() (e.g. the user hits
    // Disconnect during auto-reconnect) that lands during this method's
    // awaits can be detected instead of silently resurrecting
    // this._ecdhKeyPair / re-announcing for a channel we already left
    // (finding v093).
    const myGeneration = this._sessionGeneration;
    const pair = await generateECDHKeyPair();
    if (this._sessionGeneration !== myGeneration) {
      log.warn("E2EE: reconnect re-announce superseded before keypair publish — aborting");
      return;
    }
    this._ecdhKeyPair = pair;
    // Peers' ECDH public keys and their TOFU verifications survive: they are
    // unaffected by regenerating OUR pair, and ECDH still works (our new
    // private key against their existing public key). Clearing them here would
    // be permanent — handleAnnounce replies with an offer rather than a
    // counter-announce, and the server relays stored peer keys only on
    // voice_join — so handleOffer's unknown-peer guard would drop every
    // subsequent rotation, stranding us on the pre-reconnect key.
    if (this._roomKey) {
      await this.keyProvider.setKey(roomKeyToBase64(this._roomKey));
    }
    const reconnectPubKey = await exportPublicKey(pair.publicKey);
    const reconnectFingerprint = await computeRawKeyFingerprint(
      this.rawFromBase64(reconnectPubKey),
    );
    if (this._ecdhKeyPair === pair) {
      setLocalSessionFingerprint(reconnectFingerprint);
    }
    const reconnectAnnounce = await this.buildAnnouncePayload(reconnectPubKey);
    // Re-check ownership right before the send too: buildAnnouncePayload can
    // itself await a keyring round trip, another window for clearState() (or
    // a fresh setupKeyExchange) to have superseded this attempt.
    if (this._ecdhKeyPair !== pair) {
      log.warn("E2EE: reconnect re-announce superseded before send — discarding stray announce");
      return;
    }
    this.deps.getWs()?.send({ type: "voice_e2ee_announce", payload: reconnectAnnounce });

    // Non-key-holders: nothing here waits for, times out, or retries the
    // holder's confirming offer — the caller (connectAndSetup's reconnect
    // path) marks the call "Secured" the moment room.connect() resolves,
    // regardless of whether the re-applied (possibly stale, rotated-during-
    // the-outage) room key was ever confirmed current. Arm a bounded,
    // non-blocking check: if nothing has replaced this room key by the time
    // it fires, log it (there was previously no observable signal at all)
    // and retry the announce once — a real bound short of the 5-minute
    // periodic rotation (OC-0007). Holders don't need this: their own key
    // IS the current one.
    this.clearReconnectConfirmTimer();
    const roomKeyAtReconnect = this._roomKey;
    // Only meaningful when we actually re-applied a pre-existing key — with
    // none yet, there is nothing that could have gone "stale" and this is
    // just the ordinary first-offer wait (setupKeyExchange's own concern).
    if (!this._isKeyHolder && roomKeyAtReconnect !== null) {
      this._reconnectConfirmTimer = setTimeout(() => {
        this._reconnectConfirmTimer = null;
        if (
          this._ecdhKeyPair !== pair ||
          this._roomKey !== roomKeyAtReconnect ||
          this._isKeyHolder
        ) {
          return; // superseded, already reconfirmed by a fresh offer, or re-elected holder
        }
        log.error("E2EE: room key not reconfirmed after reconnect — may be stale, re-announcing", {
          channelId: this._channelId,
        });
        this.deps.getWs()?.send({ type: "voice_e2ee_announce", payload: reconnectAnnounce });
      }, E2EEManager.RECONNECT_CONFIRM_MS);
    }
  }

  /** How long to wait after a reconnect re-announce before treating a
   *  non-holder's re-applied room key as unconfirmed (see reannounceForReconnect). */
  private static readonly RECONNECT_CONFIRM_MS = 5_000;
  private _reconnectConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  private clearReconnectConfirmTimer(): void {
    if (this._reconnectConfirmTimer !== null) {
      clearTimeout(this._reconnectConfirmTimer);
      this._reconnectConfirmTimer = null;
    }
  }

  // ── Identity signing (F3 TOFU) ──────────────────────────────────────────

  /** Decode a base64 raw-key string to bytes for sign/verify. Throws on bad
   *  input (callers verifying a peer key already run inside try/catch). */
  private rawFromBase64(base64: string): Uint8Array {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }

  /** Load (once per session) this client's long-term identity keypair from the
   *  OS keyring so we can sign ephemeral announces. Returns null when there is
   *  no server host (identity is host-scoped) OR no authenticated user id yet
   *  (identity is host+user scoped, B3-3) — the announce then goes out
   *  unsigned and peers treat us as a legacy/unverified client. A missing user
   *  id must never fall back to a placeholder scope like `?? 0`:
   *  `getOrCreateIdentityKeyPair` would mint (or migrate-and-DELETE the real
   *  legacy key into) a bogus `host:0` keyring account, and a later
   *  authenticated call would then mint a second, different keypair under
   *  `host:<realId>` — so the published key and the announce signing key
   *  permanently disagree and every peer's verifyPeerAnnounce reports a false
   *  MITM "mismatch" (see identity.ts's `identityKeyPairCache` doc). */
  private async ensureIdentityKeyPair(): Promise<CryptoKeyPair | null> {
    if (this._identityKeyPair) return this._identityKeyPair;
    const host = this.deps.getServerHost();
    if (host === null) return null;
    const myUserId = authStore.getState().user?.id;
    if (myUserId === undefined) {
      log.warn(
        "E2EE: no authenticated user id yet — announcing unsigned instead of scoping under a placeholder id",
      );
      return null;
    }
    this._identityKeyPair = await getOrCreateIdentityKeyPair(host, myUserId);
    return this._identityKeyPair;
  }

  /** Identity keys are host-scoped — the session drops the cached keypair when
   *  the host changes (and on cleanupAll) so we never sign an announce with
   *  another host's identity key. */
  clearIdentityKeyPair(): void {
    this._identityKeyPair = null;
  }

  /** Build the voice_e2ee_announce payload, signing the ephemeral public key
   *  with our identity key (F3). Signing failures degrade to an unsigned
   *  announce rather than blocking the join. */
  private async buildAnnouncePayload(
    ephemeralPubBase64: string,
  ): Promise<{ public_key: string; signature?: string }> {
    try {
      const idKeyPair = await this.ensureIdentityKeyPair();
      if (idKeyPair) {
        const myUserId = authStore.getState().user?.id ?? 0;
        const ephemeralRaw = this.rawFromBase64(ephemeralPubBase64);
        const signature = await signEphemeralKey(idKeyPair.privateKey, myUserId, ephemeralRaw);
        return { public_key: ephemeralPubBase64, signature };
      }
    } catch (err) {
      log.error("E2EE: failed to sign announce — sending unsigned", err);
    }
    return { public_key: ephemeralPubBase64 };
  }

  /**
   * F3 TOFU: resolve a peer's identity key and verify their ephemeral-announce
   * signature. Pins the identity key on first sight; on a later change it emits
   * an identity-tofu "mismatch" (via the voice store) and blocks the peer until
   * the user re-pins. Returns true when the announce may be accepted (verified,
   * or a legacy peer with no identity key), false to reject/block. The store
   * write is the surfaced verification state the voice panel reads.
   *
   * Compatibility posture (transition):
   *   - peer HAS a published identity key, signature missing/invalid → reject
   *     (fail closed);
   *   - peer has NO identity key (legacy client) → accept, mark unverified
   *     (pin-pending).
   */
  private async verifyPeerAnnounce(
    userId: number,
    publicKeyBase64: string,
    signatureBase64: string | undefined,
    myGeneration: number,
  ): Promise<boolean> {
    const publishedIdentity =
      membersStore.getState().members.get(userId)?.identityPublicKey ?? null;
    const host = this.deps.getServerHost();

    // Resolve the persisted pin FIRST — before any legacy shortcut. A server
    // must not be able to strip a pinned peer's published key (or swap it) to
    // force it back onto the legacy accept path (finding #2: TOFU pin bypass).
    const lookup = host
      ? await getIdentityPin(host, String(userId))
      : ({ status: "unpinned" } as const);

    // Fail closed when the pin store could not be read (DC-08): with the pin
    // unknown, this peer might be pinned to a different key — proceeding down
    // the first-sight path would verify against, and then RE-PIN, whatever key
    // the server delivered. Reject the announce and surface the distinct
    // "unknown" state; the peer stays blocked for E2EE until the store recovers.
    if (lookup.status === "unavailable") {
      this.setPeerVerificationIfCurrent(myGeneration, {
        userId,
        status: "unknown",
        safetyNumber: null,
        sessionFingerprint: null,
      });
      log.error("E2EE: identity pin store unreadable — rejecting announce (fail closed)", {
        userId,
      });
      return false;
    }

    const pin = lookup.status === "pinned" ? lookup.pin : null;

    // Pinned peer whose delivered key is absent or differs from the pin —
    // possible server MITM. Block until the user re-pins.
    if (pin !== null && publishedIdentity !== pin) {
      // Buffer this announce (OC-0212) so a successful rePinPeerIdentity can
      // replay it: a mid-call peer never re-announces on its own, so without
      // this, re-pinning writes a new pin that nothing ever verifies the
      // peer's key against, leaving them un-keyed for the rest of the call.
      this._blockedAnnounces.set(userId, { publicKeyBase64, signatureBase64 });
      this.setPeerVerificationIfCurrent(myGeneration, {
        userId,
        status: "mismatch",
        safetyNumber: null,
        sessionFingerprint: null,
      });
      log.error("E2EE: pinned peer identity key missing/changed — blocking (identity-tofu)", {
        userId,
      });
      return false;
    }

    // Fingerprint of the ephemeral key this announce carries (OC-0003). Every
    // accepted peer gets one — for an unverified peer it is the only value
    // that can be compared out of band, since there is no identity key.
    const sessionFingerprint = await computeRawKeyFingerprint(this.rawFromBase64(publicKeyBase64));

    // Genuine legacy peer: never pinned AND no published identity key — accept
    // but mark unverified (pin-pending). This is the only case the compatibility
    // posture keeps open.
    if (!publishedIdentity) {
      this.setPeerVerificationIfCurrent(myGeneration, {
        userId,
        status: "unverified",
        safetyNumber: null,
        sessionFingerprint,
      });
      log.warn("E2EE: peer has no identity key — accepting as unverified (legacy)", { userId });
      return true;
    }

    // Verify the ephemeral-key signature against the trusted identity key
    // (the pin when we have one, else the first-sight published key).
    const anchorBase64 = pin ?? publishedIdentity;
    const identityKey = await importIdentityPublicKey(anchorBase64);
    const ephemeralRaw = this.rawFromBase64(publicKeyBase64);
    const ok = signatureBase64
      ? await verifyEphemeralKeySignature(identityKey, userId, ephemeralRaw, signatureBase64)
      : false;
    if (!ok) {
      // Fail closed: peer has an identity key but no valid signature (MITM).
      this.setPeerVerificationIfCurrent(myGeneration, {
        userId,
        status: "mismatch",
        safetyNumber: null,
        sessionFingerprint: null,
      });
      log.error("E2EE: peer announce signature invalid — rejecting (MITM?)", { userId });
      return false;
    }

    // First sight with a valid signature — pin the identity key now. A
    // failed write (disk full, unwritable pins file) must not display
    // "verified" with no pin ever persisted: the pin is what arms mismatch
    // detection on a LATER announce, so a peer we call verified but never
    // pinned can never have that check fire — the exact MITM window the pin
    // exists to close. "no-store" (non-Tauri: no pin store by design) is not
    // a failure and keeps the normal verified outcome below.
    let pinWriteFailed = false;
    if (pin === null && host) {
      const pinResult = await storeIdentityPin(host, String(userId), publishedIdentity);
      if (pinResult === "failed") {
        pinWriteFailed = true;
        log.error("E2EE: failed to persist identity pin — marking unverified, not verified", {
          userId,
        });
      } else {
        log.info("E2EE: pinned peer identity key on first sight", { userId });
      }
    }
    if (pinWriteFailed) {
      this.setPeerVerificationIfCurrent(myGeneration, {
        userId,
        status: "unverified",
        safetyNumber: null,
        sessionFingerprint,
      });
      return true; // still accept the announce — the write failure alone shouldn't block the call
    }
    const safetyNumber = await computeKeyFingerprint(identityKey);
    this.setPeerVerificationIfCurrent(myGeneration, {
      userId,
      status: "verified",
      safetyNumber,
      sessionFingerprint,
    });
    return true;
  }

  /** setPeerVerification, but a no-op if a clearState() teardown happened
   *  since myGeneration was captured. verifyPeerAnnounce awaits a Tauri IPC
   *  (identity pin lookup) internally and writes verification state on every
   *  branch, so a Disconnect mid-await must not let the resumed continuation
   *  resurrect voice-store state for a session that no longer exists
   *  (finding B3-7). */
  private setPeerVerificationIfCurrent(
    myGeneration: number,
    verification: Parameters<typeof setPeerVerification>[0],
  ): void {
    if (this._sessionGeneration !== myGeneration) return;
    setPeerVerification(verification);
  }

  /**
   * F3 TOFU re-pin recovery (finding #4). Pin the EXACT identity key
   * `verifiedKey` — the bytes whose fingerprint the caller displayed and the
   * user confirmed out-of-band — overwriting the stored pin for {host,userId}
   * and clearing the mismatch block (the identity-key analogue of accepting a
   * changed TLS cert). A legitimate key rotation (reinstall / new device /
   * wiped keyring) is thus recoverable instead of a permanent lockout; the next
   * announce re-verifies against the new pin.
   *
   * The verified key MUST be passed in, never re-read from membersStore here:
   * the store is server-writable (a `user_update` mutates it), so re-reading it
   * would let a malicious server swap in an attacker key during the human
   * out-of-band verification window and have us pin THAT — a TOCTOU that
   * silently defeats the mismatch prompt. Returns false when there is no host
   * or no key to pin.
   */
  async rePinPeerIdentity(userId: number, verifiedKey: string): Promise<boolean> {
    const host = this.deps.getServerHost();
    if (!host || !verifiedKey) {
      log.warn("E2EE: cannot re-pin peer without a host and the verified identity key", { userId });
      return false;
    }
    const result = await storeIdentityPin(host, String(userId), verifiedKey);
    if (result === "failed") {
      // The old pin is still on disk — do NOT clear the mismatch block. If we
      // did, the UI would report the peer trusted while nothing was actually
      // re-pinned, and the peer's very next announce would re-fail
      // verification against the stale pin with no error ever surfaced.
      log.error("E2EE: failed to persist re-pinned identity key — mismatch block kept", {
        userId,
      });
      return false;
    }
    // Replay the announce verifyPeerAnnounce buffered when it blocked this
    // peer as a mismatch (OC-0212). Without this, the pin write above is a
    // no-op for the live call: nothing else re-runs the peer's announce, so
    // they never (re-)enter _peerPublicKeys — staying out of every offer and
    // rotation for the rest of the call — and clearPeerVerification below
    // would erase the badge entirely rather than showing the real (now
    // hopefully "verified") outcome. handleAnnounce re-verifies against the
    // pin just stored above and writes the real status itself, so it stands
    // in for clearPeerVerification when a replay is available.
    const pending = this._blockedAnnounces.get(userId);
    if (pending) {
      this._blockedAnnounces.delete(userId);
      log.info("E2EE: replaying blocked announce after re-pin (TOFU recovery)", { userId });
      await this.handleAnnounce(userId, pending.publicKeyBase64, pending.signatureBase64);
    } else {
      clearPeerVerification(userId);
    }
    log.info("E2EE: re-pinned peer identity key (TOFU recovery)", { userId });
    return true;
  }

  // ── Client-side E2EE handlers (ECDH key exchange) ───────────────────────

  /** Serializes announce handling. Nothing chains concurrent invocations —
   *  dispatcher fires them unawaited and the queued-announce drain in
   *  setupKeyExchange is a separate, later pass — so two in-flight announces
   *  for the same peer could complete out of WS-delivery order, letting a
   *  stale announce's map write land after a fresher one and strand the peer
   *  on a dead key until the next rotation (finding v015). Mirrors
   *  _offerChain, whose identical ordering guarantee this file already
   *  relies on and tests; handleAnnounceInner swallows its own errors (see
   *  its try/catch below), so the chain cannot wedge on a failed announce. */
  private _announceChain: Promise<void> = Promise.resolve();

  /**
   * Handle a voice_e2ee_announce from the server — another participant has
   * announced their ECDH public key. Applied strictly in WS delivery order
   * (see _announceChain). Before trusting it we verify the peer's
   * identity-key signature (F3 TOFU): resolve the peer's identity key (pinning
   * it on first sight), reject on mismatch/invalid signature, and only then
   * store the ECDH key + (if key holder) wrap the room key for them. Peers with
   * no published identity key (legacy) are accepted but marked unverified.
   */
  handleAnnounce(userId: number, publicKeyBase64: string, signatureBase64?: string): Promise<void> {
    const run = this._announceChain.then(() =>
      this.handleAnnounceInner(userId, publicKeyBase64, signatureBase64),
    );
    this._announceChain = run;
    return run;
  }

  /** True if `publicKeyBase64` is a key we've already moved this peer off of
   *  in the current session (see `_retiredPeerKeys`). */
  private isRetiredPeerKey(userId: number, publicKeyBase64: string): boolean {
    return this._retiredPeerKeys.get(userId)?.has(publicKeyBase64) ?? false;
  }

  /** Record that `publicKeyBase64` is no longer this peer's live key —
   *  a later announce carrying it again is a replay, not a legitimate change. */
  private retirePeerKey(userId: number, publicKeyBase64: string): void {
    const retired = this._retiredPeerKeys.get(userId);
    if (retired) {
      retired.add(publicKeyBase64);
    } else {
      this._retiredPeerKeys.set(userId, new Set([publicKeyBase64]));
    }
  }

  private async handleAnnounceInner(
    userId: number,
    publicKeyBase64: string,
    signatureBase64?: string,
  ): Promise<void> {
    // Queue if our keypair isn't ready yet (announce arrived during connectAndSetup).
    if (!this._ecdhKeyPair) {
      this._pendingAnnounces.push({ userId, publicKeyBase64, signatureBase64 });
      log.info("E2EE: queued announce (keypair not ready)", { userId });
      return;
    }
    // Captured before verifyPeerAnnounce's awaits (a Tauri IPC pin lookup) so
    // a clearState() that lands during them — e.g. Disconnect mid-verify —
    // can be detected before this continuation writes into a session a newer
    // (or no) attempt now owns (finding B3-7).
    const myGeneration = this._sessionGeneration;
    // Reject a replay of a key we've already retired for this peer BEFORE
    // verifyPeerAnnounce runs (OC-0209). verifyPeerAnnounce writes the peer's
    // displayed verification (status + sessionFingerprint, computed from
    // THIS announce's key) on every branch it can take, including its
    // success branches — so if the replay guard ran only after verification
    // (as it used to, further below), a replayed announce would overwrite
    // the peer's badge with the retired key's fingerprint/status before
    // being rejected, even though _peerPublicKeys itself was never touched.
    // This check is synchronous (no await), so it introduces no new window
    // for a session to be superseded before it runs.
    if (this.isRetiredPeerKey(userId, publicKeyBase64)) {
      log.error("E2EE: rejecting replayed peer key announce (previously retired)", { userId });
      return;
    }
    try {
      // ── F3 TOFU verification gate ──────────────────────────────────────
      // Resolve the peer's identity key and verify the announce signature
      // BEFORE storing the ECDH key or wrapping the room key. A malicious
      // server that swaps user_id↔ephemeral-key or forges keys fails here.
      if (
        !(await this.verifyPeerAnnounce(userId, publicKeyBase64, signatureBase64, myGeneration))
      ) {
        return; // rejected/blocked — do not store or wrap
      }

      if (this._sessionGeneration !== myGeneration) {
        log.info("E2EE: discarding stale announce (session torn down during verify)", { userId });
        return;
      }

      // Deduplicate: if the key is identical, skip the import but still
      // re-send the room key offer (the peer may be re-requesting after a
      // missed offer or reconnect).
      const existingKey = this._peerPublicKeys.get(userId);
      let peerKey: CryptoKey;
      let isDuplicate = false;
      if (existingKey) {
        const existingB64 = await exportPublicKey(existingKey);
        if (existingB64 === publicKeyBase64) {
          peerKey = existingKey;
          isDuplicate = true;
          log.debug("E2EE: duplicate announce — will re-send offer if key holder", { userId });
        } else {
          // The replay-of-a-retired-key check now runs up front (OC-0209),
          // before verifyPeerAnnounce — see the comment there (was
          // previously duplicated in both branches here).
          this.retirePeerKey(userId, existingB64);
          peerKey = await importPublicKey(publicKeyBase64);
          log.warn("E2EE: peer public key changed (reconnect?)", { userId });
        }
      } else {
        peerKey = await importPublicKey(publicKeyBase64);
      }
      // Re-check after the export/import awaits above: a clearState()+rejoin
      // landing during either one must not have this stale continuation write
      // a torn-down session's peer key into the map a NEW session now owns —
      // the generation guard above only covers the window up to verification,
      // not this later await (OC-0010).
      if (this._sessionGeneration !== myGeneration) {
        log.info("E2EE: discarding stale announce (session torn down during key import)", {
          userId,
        });
        return;
      }
      if (!isDuplicate) {
        this._peerPublicKeys.set(userId, peerKey);
        this._peerOfferEpochs.delete(userId);
        log.info("E2EE: received peer public key", { userId });
      }

      // If we're the key holder and have a room key, wrap it for the new peer.
      // Capture keypair + roomKey before async work to avoid null dereference if
      // clearState() runs concurrently.
      const keypair = this._ecdhKeyPair;
      const currentRoomKey = this._roomKey;
      // OC-0257: key-holder election is server-authoritative — lowest
      // connected user id (Server/ws/voice_e2ee.go) — and is re-run on every
      // join, but the server has no demotion message and
      // handleVoiceTokenRefresh discards the corrected is_key_holder it gets
      // on every token refresh. So a stale holder's _isKeyHolder can outlive
      // its actual election. A peer announcing with a LOWER user id than
      // ours proves exactly that: the server would never have elected us
      // while they're connected, so wrapping and offering the room key here
      // would only earn a NOT_KEY_HOLDER refusal (surfaced to the user as a
      // spurious error toast) after wasting the wrap. Stand down here — same
      // as handleOfferInner does on accepting the real holder's offer —
      // instead of emitting a doomed offer.
      const myUserId = authStore.getState().user?.id ?? 0;
      if (this._isKeyHolder && myUserId !== 0 && userId < myUserId) {
        this._isKeyHolder = false;
        this.clearKeyRotationTimer();
        log.info("E2EE: stood down as key holder — announcing peer has a lower user id", {
          userId,
          myUserId,
        });
      } else if (this._isKeyHolder && currentRoomKey && keypair) {
        // Capture epoch before the wrap await — a rotation racing this
        // announce already added the peer to _peerPublicKeys before we got
        // here, so it offers them the fresh key on its own; if that
        // happened, ship this pre-rotation wrap and the receiver's
        // strictly-ordered _offerChain ends up on the dead key.
        const epochBefore = this._e2eeEpoch;
        const { encryptedKey, iv } = await wrapRoomKey(
          keypair.privateKey,
          peerKey,
          currentRoomKey,
          epochBefore,
        );
        // Discard if either the epoch advanced (a rotation landed during the
        // wrap) OR the keypair no longer matches (a concurrent
        // reannounceForReconnect() swapped it without bumping the epoch) —
        // mirrors handleOfferInner's dual guard. An offer wrapped under an
        // abandoned keypair is undecryptable by the peer (finding v101).
        if (this._e2eeEpoch !== epochBefore || this._ecdhKeyPair !== keypair) {
          log.info("E2EE: discarding stale announce-offer (epoch or keypair changed during wrap)", {
            userId,
            epochBefore,
            epochNow: this._e2eeEpoch,
          });
          return;
        }
        // Routed through the shared sendOfferPaced budget (OC-0167) rather
        // than sent directly — setupKeyExchange's queued-announce drain can
        // call this once per existing participant in an uninterrupted loop
        // (a key holder joining a large ongoing call), and those sends must
        // draw from the same per-second budget as rotation offers instead of
        // bypassing pacing entirely.
        const sent = await this.sendOfferPaced(
          userId,
          encryptedKey,
          iv,
          () => this._e2eeEpoch !== epochBefore || this._ecdhKeyPair !== keypair,
        );
        if (!sent) {
          log.info(
            "E2EE: discarding stale announce-offer (epoch or keypair changed during pacing pause)",
            { userId, epochBefore, epochNow: this._e2eeEpoch },
          );
          return;
        }
        log.info("E2EE: sent room key offer to peer", { userId });
      }
    } catch (err) {
      log.error("E2EE: failed to handle announce", err);
    }
  }

  /** Serializes offer application. The offer payload carries no epoch or
   *  sequence and WebCrypto gives no cross-operation ordering guarantee, so
   *  two in-flight offers could complete out of order — applying the older
   *  key last and stranding this receiver on a dead key until the next
   *  rotation. Chaining applies offers strictly in WS delivery order. */
  private _offerChain: Promise<void> = Promise.resolve();

  /**
   * Handle a voice_e2ee_offer from the server — the key holder has sent us
   * the encrypted room key. Unwrap it and apply to the E2EE key provider.
   * Offers are applied one at a time, in delivery order.
   *
   * Chained through _announceChain first (OC-0002): handleAnnounceInner only
   * stores the sender's ECDH key after several awaits (identity-pin lookup,
   * signature verification, key import), while handleOfferInner's first
   * statement is a synchronous _peerPublicKeys lookup. An offer dispatched
   * immediately behind that same sender's announce — the OC-0098 send order
   * guarantees exactly this WS delivery order — would otherwise reach the
   * lookup before the announce applied, and be dropped as "unknown peer"
   * with no retry until the next 5-minute rotation. Waiting on the announce
   * chain reproduces WS delivery order exactly: the announce is enqueued on
   * it before the offer's frame is even dispatched. No deadlock risk:
   * handleAnnounceInner never awaits the offer chain and never rejects (it
   * catches internally), and clearState() resets both chains together.
   */
  handleOffer(fromUserId: number, encryptedKeyBase64: string, ivBase64: string): Promise<void> {
    // handleOfferInner never rejects (it catches internally), so the chain
    // cannot wedge on a failed offer.
    const run = this._offerChain
      .then(() => this._announceChain)
      .then(() => this.handleOfferInner(fromUserId, encryptedKeyBase64, ivBase64));
    this._offerChain = run;
    return run;
  }

  private async handleOfferInner(
    fromUserId: number,
    encryptedKeyBase64: string,
    ivBase64: string,
  ): Promise<void> {
    try {
      const peerKey = this._peerPublicKeys.get(fromUserId);
      if (!peerKey) {
        log.warn("E2EE: received offer from unknown peer", { fromUserId });
        return;
      }
      const keypair = this._ecdhKeyPair;
      if (!keypair) {
        log.warn("E2EE: received offer but no ECDH keypair");
        return;
      }

      // Capture epoch before async work — if a key rotation occurs during
      // unwrap, the epoch will have advanced and we discard this stale result.
      const epochBefore = this._e2eeEpoch;

      const { roomKey: unwrapped, epoch } = await unwrapRoomKey(
        keypair.privateKey,
        peerKey,
        encryptedKeyBase64,
        ivBase64,
      );

      // Discard if either the epoch advanced (a rotation landed during
      // unwrap) OR the keypair no longer matches (clearState() ran and a new
      // session generated a fresh one — possible when the epoch is 0 in both
      // the old and new session, since a non-key-holder never bumps it).
      if (this._e2eeEpoch !== epochBefore || this._ecdhKeyPair !== keypair) {
        log.info("E2EE: discarding stale offer (epoch or session keypair changed during unwrap)", {
          fromUserId,
          epochBefore,
          epochNow: this._e2eeEpoch,
        });
        return;
      }

      // Freshness (OC-0001): the epoch is GCM-authenticated, so it is the
      // holder's own value. Equal is fine — the holder re-sends the current
      // key at the current epoch when a peer re-announces.
      if (epoch === null) {
        // ponytail: compat with holders on the pre-epoch build — remove with
        // the legacy branch in unwrapRoomKey.
        log.warn(
          "E2EE: offer carries no epoch (legacy holder) — applying without freshness check",
          {
            fromUserId,
          },
        );
      } else {
        const highWater = this._peerOfferEpochs.get(fromUserId);
        if (highWater !== undefined && epoch < highWater) {
          log.warn("E2EE: discarding superseded offer (epoch below high-water mark)", {
            fromUserId,
            epoch,
            highWater,
          });
          return;
        }
        this._peerOfferEpochs.set(fromUserId, epoch);
      }

      this._roomKey = unwrapped;
      await this.keyProvider.setKey(roomKeyToBase64(this._roomKey));
      log.info("E2EE: room key received and applied", { fromUserId, epoch });

      // Re-check after the setKey await too: the guard above only covers the
      // window up to unwrap, not this call. A teardown-and-rejoin-as-holder
      // landing here would otherwise have this stale continuation read the
      // NEW session's live _isKeyHolder/_roomKeyResolver below and stand it
      // down / resolve it — corrupting a session this attempt no longer owns
      // (OC-0010).
      if (this._e2eeEpoch !== epochBefore || this._ecdhKeyPair !== keypair) {
        log.info("E2EE: discarding stale offer after setKey (epoch or session keypair changed)", {
          fromUserId,
        });
        return;
      }

      // Accepting an offer proves the sender is the server-authoritative key
      // holder (the server gates outgoing offers on IsVoiceKeyHolder), so if we
      // still think we hold the key, we have been re-elected away — a lower
      // userID joined. Stand down: our rotations would be rejected with
      // NOT_KEY_HOLDER, but only after we applied the new key locally, leaving
      // us deaf and mute until the real holder rotates again.
      // handleParticipantLeft can still re-promote us later.
      if (this._isKeyHolder) {
        this._isKeyHolder = false;
        this.clearKeyRotationTimer();
        log.info("E2EE: stood down as key holder — accepted an offer from the elected holder", {
          fromUserId,
        });
      }

      // Resolve the pending connect promise if we were waiting for the key.
      if (this._roomKeyResolver) {
        this._roomKeyResolver();
        this._roomKeyResolver = null;
        this._roomKeyRejector = null;
      }
    } catch (err) {
      log.error("E2EE: failed to handle offer", err);
      // Propagate decryption failure so the waiting setupKeyExchange unblocks.
      if (this._roomKeyRejector) {
        this._roomKeyRejector(err instanceof Error ? err : new Error(String(err)));
        this._roomKeyResolver = null;
        this._roomKeyRejector = null;
      }
    }
  }

  /** Server-side cap is voiceE2EEOfferRateLimit = 64 offers per (sender,
   *  channel) per second (Server/ws/voice_e2ee.go) — a whole rotation's
   *  offers can exceed it in a large channel, and everything past the cap is
   *  dropped with no client-side signal, starving the same tail peers (in
   *  stable Map insertion order) on every subsequent rotation (OC-0005).
   *  Stay under it with margin rather than reading the limit back from the
   *  server. */
  private static readonly OFFER_RATE_LIMIT_PER_SEC = 60;
  /** Sliding-window length. The server window is a flat per-second cap, so
   *  "at most LIMIT sends inside any WINDOW_MS-wide slice" is the whole
   *  algorithm needed. Upgrade if the cap ever becomes variable or
   *  sub-second. */
  private static readonly OFFER_RATE_WINDOW_MS = 1_100;
  /** Timestamps (Date.now()) of every voice_e2ee_offer sent within the
   *  current OFFER_RATE_WINDOW_MS window — an INSTANCE-level sliding-window
   *  budget shared by every offer-send path (rotation, become-holder, its H3
   *  late-arrival pass, AND announce-driven offers), never a per-call
   *  counter. A per-call counter (the original OC-0005 fix) resets to zero
   *  on every distributeRoomKey invocation, so two back-to-back rotations —
   *  the second one run immediately by drainPendingRotationOrArmTimer —
   *  each got their own fresh budget and together could blow through the
   *  server's single per-second window (OC-0155); handleAnnounceInner's
   *  drain-time offer send bypassed the budget altogether (OC-0167). Reset
   *  in clearState(). */
  private _offerSendTimes: number[] = [];

  /** Drop timestamps that have aged out of the current pacing window. */
  private pruneOfferSendTimes(): void {
    const cutoff = Date.now() - E2EEManager.OFFER_RATE_WINDOW_MS;
    while (this._offerSendTimes.length > 0 && (this._offerSendTimes[0] ?? Infinity) <= cutoff) {
      this._offerSendTimes.shift();
    }
  }

  /**
   * Send one voice_e2ee_offer, pacing under the server's per-(sender,
   * channel) sliding-window rate limit (OC-0005/OC-0155/OC-0167;
   * Server/ws/voice_e2ee.go voiceE2EEOfferRateLimit=64/1s). Prunes this
   * instance's send timestamps older than OFFER_RATE_WINDOW_MS, and if
   * OFFER_RATE_LIMIT_PER_SEC sends already fall inside the window, waits for
   * the oldest of them to age out before sending — so every offer-send path
   * draws from ONE shared budget instead of each resetting its own.
   *
   * `isStale`, when given, is re-checked after any pacing wait (never
   * before) so a keypair/room-key/epoch swap that lands during the wait is
   * caught right before the send — the same protection distributeRoomKey and
   * handleAnnounceInner already apply around the wrap itself (findings v045,
   * v101). Returns false (and sends nothing) when `isStale` reports true
   * post-wait.
   */
  private async sendOfferPaced(
    targetUserId: number,
    encryptedKey: string,
    iv: string,
    isStale?: () => boolean,
  ): Promise<boolean> {
    this.pruneOfferSendTimes();
    if (this._offerSendTimes.length >= E2EEManager.OFFER_RATE_LIMIT_PER_SEC) {
      // Guarded by the length check above — the array is non-empty here.
      const oldest = this._offerSendTimes[0] as number;
      const waitMs = oldest + E2EEManager.OFFER_RATE_WINDOW_MS - Date.now();
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
      this.pruneOfferSendTimes();
      if (isStale?.()) {
        return false;
      }
    }
    this._offerSendTimes.push(Date.now());
    this.deps.getWs()?.send({
      type: "voice_e2ee_offer",
      payload: { target_user_id: targetUserId, encrypted_key: encryptedKey, iv },
    });
    return true;
  }

  /**
   * Wrap the room key for each peer and send an offer, one at a time. Bails
   * out (without sending further offers) as soon as a concurrent keypair
   * swap (reannounceForReconnect) or room-key change invalidates the wrap —
   * an offer wrapped under an abandoned keypair/key is undecryptable by the
   * peer and would otherwise silently strand them on the stale key until the
   * next rotation (finding v045). Shared by the become-holder distribution,
   * its late-arrival (H3) pass, and the periodic rotation loop.
   *
   * Sends go through sendOfferPaced's shared instance-level budget to stay
   * under the server's per-(sender,channel) rate limit (OC-0005/OC-0155) —
   * without this, a rotation (or two back-to-back rotations) in a large
   * channel silently drops every offer past the cap, and the same tail peers
   * stay stranded on the old key forever.
   */
  private async distributeRoomKey(
    keypair: CryptoKeyPair,
    roomKey: Uint8Array,
    peers: Iterable<[number, CryptoKey]>,
  ): Promise<void> {
    for (const [peerId, peerKey] of peers) {
      if (this._ecdhKeyPair !== keypair || this._roomKey !== roomKey) {
        log.warn("E2EE: aborting key distribution — keypair/room key changed mid-loop", {
          peerId,
        });
        return;
      }
      const { encryptedKey, iv } = await wrapRoomKey(
        keypair.privateKey,
        peerKey,
        roomKey,
        this._e2eeEpoch,
      );
      if (this._ecdhKeyPair !== keypair || this._roomKey !== roomKey) {
        log.info("E2EE: discarding stale room-key offer (keypair/room key changed during wrap)", {
          peerId,
        });
        return;
      }
      const sent = await this.sendOfferPaced(
        peerId,
        encryptedKey,
        iv,
        () => this._ecdhKeyPair !== keypair || this._roomKey !== roomKey,
      );
      if (!sent) {
        log.info(
          "E2EE: discarding stale room-key offer (keypair/room key changed during pacing pause)",
          { peerId },
        );
        return;
      }
    }
  }

  /**
   * Bump the epoch and install a fresh room key on the shared key provider —
   * the two mutations every rotation path performs before distributing to
   * peers. Shared so the session-generation guard lives in one place instead
   * of being duplicated (or omitted) at each call site (OC-0006).
   *
   * If a clearState()/rejoin supersedes this rotation while the `setKey`
   * await is in flight, the call has already been issued to the shared
   * keyProvider and cannot be un-sent — so on resume this re-applies
   * whatever room key the NOW-current session holds (if any), self-healing
   * the provider instead of silently leaving it on our abandoned key. Narrow
   * (it needs two setKey calls to resolve out of order), but real.
   *
   * Returns the new room key, or null if superseded — callers must skip
   * their own distribution step in that case.
   */
  private async rotateRoomKey(): Promise<Uint8Array | null> {
    const myGeneration = this._sessionGeneration;
    this._e2eeEpoch++;
    const roomKey = generateRoomKey();
    this._roomKey = roomKey;
    await this.keyProvider.setKey(roomKeyToBase64(roomKey));
    if (this._sessionGeneration !== myGeneration) {
      log.error(
        "E2EE: rotation superseded while setKey was in flight — re-applying the live session's key",
      );
      if (this._roomKey) {
        await this.keyProvider.setKey(roomKeyToBase64(this._roomKey));
      }
      return null;
    }
    return roomKey;
  }

  /**
   * Handle a participant leaving the voice channel. If we become the new key
   * holder, rotate the room key and distribute to remaining peers. If we are
   * ALREADY the key holder and a peer that held the room key left, we also
   * rotate — so the departed member's copy can no longer decrypt future audio
   * against the untrusted SFU (membership forward secrecy).
   *
   * Key holder election: the participant with the lowest user ID among remaining
   * participants is elected. This is deterministic and does not depend on Map
   * insertion order (which is not guaranteed to match server join order).
   */
  async handleParticipantLeft(userId: number): Promise<void> {
    const departingKey = this._peerPublicKeys.get(userId);
    const hadPeerKey = departingKey !== undefined;
    this._peerPublicKeys.delete(userId);
    this._peerOfferEpochs.delete(userId);
    clearPeerVerification(userId);

    const channelId = this._channelId ?? this.deps.getCurrentChannelId();
    const state = voiceStore.getState();
    const channelUsers = channelId ? state.voiceUsers.get(channelId) : undefined;

    // Retire the departing peer's key (OC-0020): _retiredPeerKeys is the only
    // defense against replay of a validly-signed announce (the signed
    // message carries no channel/epoch/nonce, F3) and handleAnnounceInner
    // only records a retirement on an in-session key CHANGE. Without this, a
    // peer that leaves and rejoins with a fresh key is neither live nor
    // retired on their pre-leave key — a replay of the recorded old announce
    // then passes both guards and overwrites the peer's live key with one
    // whose private half no longer exists (blackholing them). A genuine
    // rejoin always mints a fresh ECDH pair (setupKeyExchange,
    // reannounceForReconnect), so this never rejects a legitimate re-announce.
    //
    // BUT: voice_leave travels through the buffered hub broadcast queue while
    // voice_e2ee_announce is published straight into the recipient's send
    // queue from the sender's read-pump (Server/ws/hub_broadcast.go documents
    // this as a reordering hazard) — a peer's rejoin announce can overtake
    // the stale voice_leave for the join instance it superseded (OC-0213).
    // If the local roster (voice_state, kept current by the server) still
    // lists this peer as present in the channel, this IS that stale case:
    // retiring their (in that case, still-live) key would have every later,
    // genuine re-announce of it rejected as a replay, permanently stranding
    // a peer who never actually left. Skip retirement in that case — the key
    // is still removed from _peerPublicKeys above (and, below, this event
    // still correctly excludes them from any resulting rotation) so nothing
    // regresses for a genuine departure.
    //
    // `channelUsers` is a POST-mutation read: the only real VOICE_LEAVE
    // caller (dispatcher.ts) deletes the user from the voice-user roster
    // BEFORE calling this method, so `channelUsers?.has(userId)` is always
    // false by the time we get here in production — this guard only ever
    // protects the OC-0213 case for a caller that reads the roster itself
    // without that prior mutation (as tests do). OC-0239 tried to plug that
    // production gap by having the caller pass a PRE-mutation roster
    // snapshot (`stillInRoster`) instead, but that snapshot cannot tell the
    // two cases apart either (OC-0283): the roster still lists a departing
    // peer as present right up until this very event is what removes them,
    // so the snapshot reads "still present" on every genuine departure too,
    // not just the stale-leave case it was meant to isolate. Gating on it
    // made retirement never run in production, silently killing this replay
    // defense — worse than the gap it was meant to close. A real fix for the
    // OC-0213 race needs a discriminator the roster does not carry (e.g. the
    // server stamping a join/epoch id on voice_leave so a stale leave for a
    // superseded join can be dropped outright), not a roster read taken at
    // any point during this call.
    if (departingKey && !channelUsers?.has(userId)) {
      this.retirePeerKey(userId, await exportPublicKey(departingKey));
    }

    if (!channelId) return;

    const myUserId = authStore.getState().user?.id ?? 0;

    // Elect key holder: lowest user_id among remaining participants. The
    // local roster comes from voice_state broadcasts, including our own —
    // which can arrive AFTER a peer's voice_leave when we joined the channel
    // concurrently with their departure (the server already elected us; our
    // own broadcast is still queued behind theirs on the hub). Seed the
    // roster with our own id unconditionally so that race can't leave the
    // channel's roster entry empty/missing and silently skip election
    // (OC-0004) — the join that provoked it would otherwise time out 15s
    // later with no recovery.
    let lowestUserId = myUserId !== 0 ? myUserId : Infinity;
    if (channelUsers) {
      for (const uid of channelUsers.keys()) {
        if (uid < lowestUserId) lowestUserId = uid;
      }
    }
    if (lowestUserId === Infinity) return; // nobody known yet, including ourselves

    const wasKeyHolder = this._isKeyHolder;

    if (myUserId !== 0 && lowestUserId === myUserId && !wasKeyHolder) {
      // A rotation is already in flight (e.g. we stood down mid-rotation
      // after accepting another holder's offer, and are now re-elected
      // because THEY left). Don't drop the re-election — that would strand
      // the room with no key holder until the next voice_leave self-heals
      // it. Mirror the sibling branch below: defer, don't drop. The
      // in-flight rotation's finally -> drainPendingRotationOrArmTimer will
      // run rotateKeyPeriodically as holder once it completes.
      if (this._rotatingKey) {
        this._isKeyHolder = true;
        this._rotationPending = true;
        log.warn("E2EE: key rotation already in progress — deferring re-election as holder", {
          userId,
          channelId,
        });
        return;
      }
      this._rotatingKey = true;
      this._isKeyHolder = true;
      log.info("E2EE: became key holder after participant left", { userId, channelId });

      // Rotate the room key — generate a new one and distribute to all remaining peers.
      try {
        const roomKey = await this.rotateRoomKey();
        if (roomKey === null) {
          // Superseded while setKey was in flight — the now-current session
          // owns its own key-holder role and rotation; nothing left to do.
          return;
        }
        log.info("E2EE: rotated room key", { channelId, epoch: this._e2eeEpoch });

        // A client elected while still waiting inside setupKeyExchange has a
        // pending resolver — the offer it is waiting for will never arrive
        // (we are the holder now), so unblock it with the key just generated.
        if (this._roomKeyResolver) {
          this._roomKeyResolver();
          this._roomKeyResolver = null;
          this._roomKeyRejector = null;
        }

        // Snapshot peers (and the keypair) before the async loop — new peers
        // that arrive during wrapping are handled by the post-rotation check
        // below.
        const keypair = this._ecdhKeyPair;
        const peersSnapshot = new Map(this._peerPublicKeys);

        if (keypair) {
          await this.distributeRoomKey(keypair, roomKey, peersSnapshot);
          log.info("E2EE: distributed rotated key to peers", {
            peerCount: peersSnapshot.size,
          });

          // H3: Check for peers that arrived during the rotation loop and
          // send them the new key too.
          if (keypair === this._ecdhKeyPair && this._roomKey === roomKey) {
            const lateArrivals = [...this._peerPublicKeys].filter(
              ([peerId]) => !peersSnapshot.has(peerId),
            );
            if (lateArrivals.length > 0) {
              await this.distributeRoomKey(keypair, roomKey, lateArrivals);
              log.info("E2EE: sent rotated key to late-arriving peers", {
                peerCount: lateArrivals.length,
              });
            }
          }
        }
      } catch (err) {
        log.error("E2EE: failed to rotate room key", err);
      } finally {
        this._rotatingKey = false;
      }
      // If a keyed peer left while this become-holder rotation was in flight, its
      // rekey was deferred (not dropped) — run it now so the departed member is
      // excluded from the fresh key; otherwise re-arm the periodic timer.
      await this.drainPendingRotationOrArmTimer();
    } else if (wasKeyHolder && hadPeerKey) {
      // Membership forward secrecy: I remain the key holder and a peer that held
      // the room key left, so rotate + redistribute to the CURRENT peer set
      // (which already excludes the leaver, deleted above) — otherwise the
      // departed member keeps a valid room key against the untrusted SFU until
      // the next periodic rotation.
      if (this._rotatingKey) {
        // A rotation is already in flight and may already have sent the current
        // key to this leaver before they left. Don't DROP the rekey (that would
        // leave the departed member holding a live key) — defer it so it re-runs
        // when the in-flight rotation completes, excluding them.
        this._rotationPending = true;
      } else {
        await this.rotateKeyPeriodically();
      }
    }
  }

  // ── Periodic key rotation ──────────────────────────────────────────────────

  /** Start the periodic key rotation timer (only meaningful for key holders). */
  private startKeyRotationTimer(): void {
    this.clearKeyRotationTimer();
    if (!this._isKeyHolder) return;
    this._keyRotationTimer = setTimeout(() => {
      this._keyRotationTimer = null;
      void this.rotateKeyPeriodically();
    }, E2EEManager.KEY_ROTATION_INTERVAL_MS);
    log.debug("E2EE: key rotation timer started", {
      intervalMs: E2EEManager.KEY_ROTATION_INTERVAL_MS,
    });
  }

  private clearKeyRotationTimer(): void {
    if (this._keyRotationTimer !== null) {
      clearTimeout(this._keyRotationTimer);
      this._keyRotationTimer = null;
    }
  }

  /** Rotate the room key on a timer tick (forward secrecy improvement). */
  async rotateKeyPeriodically(): Promise<void> {
    if (!this._isKeyHolder || this._rotatingKey) return;
    const channelId = this._channelId ?? this.deps.getCurrentChannelId();
    if (!channelId) return;

    this._rotatingKey = true;
    try {
      const roomKey = await this.rotateRoomKey();
      if (roomKey === null) {
        // Superseded while setKey was in flight — the now-current session
        // owns its own key-holder role and rotation; nothing left to do.
        return;
      }
      log.info("E2EE: periodic key rotation", { channelId, epoch: this._e2eeEpoch });

      const keypair = this._ecdhKeyPair;
      if (keypair) {
        const peerCount = this._peerPublicKeys.size;
        // Pass the live map (not a snapshot): peers that arrive mid-loop are
        // still visited, matching the original behavior — only the
        // keypair/room-key ownership check is new here.
        await this.distributeRoomKey(keypair, roomKey, this._peerPublicKeys);
        log.info("E2EE: distributed periodically rotated key", { peerCount });
      }
    } catch (err) {
      log.error("E2EE: periodic key rotation failed", err);
    } finally {
      this._rotatingKey = false;
    }

    // Re-arm the periodic timer, or run a rotation deferred by a keyed-peer leave
    // that coincided with this one.
    await this.drainPendingRotationOrArmTimer();
  }

  /** After a rotation completes: if a keyed-peer leave coincided with it (its
   *  rekey was deferred, not dropped), run one more rotation to exclude the
   *  departed member; otherwise re-arm the periodic rotation timer. */
  private async drainPendingRotationOrArmTimer(): Promise<void> {
    if (this._rotationPending) {
      this._rotationPending = false;
      await this.rotateKeyPeriodically();
      return;
    }
    this.startKeyRotationTimer();
  }

  /** Clear all E2EE state (called on voice leave). The long-term identity
   *  keypair is intentionally NOT cleared here — it persists across calls to
   *  the same host (cleared only on host change / cleanupAll). */
  clearState(): void {
    this._sessionGeneration++;
    this._channelId = null;
    this._offerChain = Promise.resolve();
    this._announceChain = Promise.resolve();
    this._ecdhKeyPair = null;
    this._roomKey = null;
    this._peerPublicKeys.clear();
    this._retiredPeerKeys.clear();
    this._peerOfferEpochs.clear();
    clearPeerVerifications();
    setLocalSessionFingerprint(null);
    this._isKeyHolder = false;
    this._rotatingKey = false;
    this._rotationPending = false;
    this._e2eeEpoch = 0;
    this._pendingAnnounces.length = 0;
    this._blockedAnnounces.clear();
    // The server's offer rate limit is scoped per (sender, channel) — a
    // fresh channel gets a fresh bucket server-side, so stale timestamps
    // from the old channel must not throttle the new one.
    this._offerSendTimes.length = 0;
    this.clearKeyRotationTimer();
    this.clearReconnectConfirmTimer();
    // Reject (not resolve) so waiting setupKeyExchange sees a failure, not a
    // silent success with no room key.
    if (this._roomKeyRejector) {
      this._roomKeyRejector(new Error("Voice session ended"));
    }
    this._roomKeyResolver = null;
    this._roomKeyRejector = null;
  }
}

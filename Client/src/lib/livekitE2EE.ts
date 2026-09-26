// LiveKit E2EE manager — client-side ECDH key exchange extracted from livekitSession.ts.
// E2EEManager is the public class: it owns the session generation, the
// key-holder role and the join, reconnect, announce, re-pin and leave protocol,
// and composes the ownership modules under src/features/voice/ for the rest —
// e2eeIdentity (identity signing, F3, and the ephemeral keypair), e2eeEpoch
// (room key, epoch, rotation), e2eePeerState (peer keys and TOFU pin
// verification), e2eeWorker (the key provider and its write queue) and
// e2eeOffer (receiving and sending room-key offers).
import { ExternalE2EEKeyProvider } from "livekit-client";
import type { WsClient } from "@lib/ws";
import {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  generateRoomKey,
  wrapRoomKey,
  computeRawKeyFingerprint,
} from "@lib/e2eeCrypto";
import { storeIdentityPin } from "@lib/identity";
import { authStore } from "@stores/auth.store";
import {
  voiceStore,
  clearPeerVerification,
  clearPeerVerifications,
  setLocalSessionFingerprint,
} from "@stores/voice.store";
import { createLogger } from "@lib/logger";
import { E2EEIdentity, rawFromBase64 } from "../features/voice/e2eeIdentity";
import { E2EEEpoch } from "../features/voice/e2eeEpoch";
import { E2EEPeerState, type PendingAnnounce } from "../features/voice/e2eePeerState";
import { E2EEWorker } from "../features/voice/e2eeWorker";
import { E2EEOffer } from "../features/voice/e2eeOffer";

const log = createLogger("livekitE2EE");

// --- Dependencies passed from LiveKitSession ---

export interface E2EEDeps {
  getWs: () => WsClient | null;
  getServerHost: () => string | null;
  getCurrentChannelId: () => number | null;
}

// --- E2EEManager class ---

export class E2EEManager {
  // ── Ownership modules (src/features/voice/e2ee*.ts) ──────────────────────
  /** Identity signing (F3 TOFU) and the ephemeral ECDH keypair. See e2eeIdentity.ts. */
  private _identity = new E2EEIdentity({ getServerHost: () => this.deps.getServerHost() });
  /** Ephemeral ECDH P-256 keypair for the current voice session. */
  private get _ecdhKeyPair(): CryptoKeyPair | null {
    return this._identity.ecdhKeyPair;
  }
  private set _ecdhKeyPair(value: CryptoKeyPair | null) {
    this._identity.ecdhKeyPair = value;
  }
  /** Room key, epoch, offer high-water marks and rotation. See e2eeEpoch.ts. */
  private _epoch = new E2EEEpoch({
    isKeyHolder: () => this._isKeyHolder,
    getChannelId: () => this._channelId,
    getCurrentChannelId: () => this.deps.getCurrentChannelId(),
    getSessionGeneration: () => this._sessionGeneration,
    getEcdhKeyPair: () => this._ecdhKeyPair,
    getPeerPublicKeys: () => this._peerPublicKeys,
    applyRoomKey: (roomKey) => this._worker.applyRoomKey(roomKey),
    distributeRoomKey: (keypair, roomKey, peers) =>
      this._offers.distributeRoomKey(keypair, roomKey, peers),
  });
  /** The 256-bit symmetric room key (plaintext). */
  private get _roomKey(): Uint8Array | null {
    return this._epoch.roomKey;
  }
  private set _roomKey(value: Uint8Array | null) {
    this._epoch.roomKey = value;
  }
  /** Highest offer epoch applied per sender (OC-0001). */
  private get _peerOfferEpochs(): Map<number, number> {
    return this._epoch.peerOfferEpochs;
  }
  /** True while a key rotation is in progress. */
  private get _rotatingKey(): boolean {
    return this._epoch.rotatingKey;
  }
  private set _rotatingKey(value: boolean) {
    this._epoch.rotatingKey = value;
  }
  /** A keyed-peer leave deferred a rekey behind an in-flight rotation. */
  private get _rotationPending(): boolean {
    return this._epoch.rotationPending;
  }
  private set _rotationPending(value: boolean) {
    this._epoch.rotationPending = value;
  }
  /** Monotonic rotation counter. */
  private get _e2eeEpoch(): number {
    return this._epoch.epoch;
  }
  private set _e2eeEpoch(value: number) {
    this._epoch.epoch = value;
  }
  /** Peer keys, generations, retired keys, queued/blocked announces and TOFU
   *  verification. See e2eePeerState.ts. */
  private _peers = new E2EEPeerState({
    getServerHost: () => this.deps.getServerHost(),
    getSessionGeneration: () => this._sessionGeneration,
  });
  /** Peer ECDH public keys indexed by userId. */
  private get _peerPublicKeys(): Map<number, CryptoKey> {
    return this._peers.peerPublicKeys;
  }
  /** Invalidates work for a departed membership while allowing a fresh rejoin. */
  private get _peerGenerations(): Map<number, number> {
    return this._peers.peerGenerations;
  }
  /** Keys a peer has been moved off this session (replay guard, OC-0011). */
  private get _retiredPeerKeys(): Map<number, Set<string>> {
    return this._peers.retiredPeerKeys;
  }
  /** Announces that arrived before our ECDH keypair was ready. */
  private get _pendingAnnounces(): PendingAnnounce[] {
    return this._peers.pendingAnnounces;
  }
  private set _pendingAnnounces(value: PendingAnnounce[]) {
    this._peers.pendingAnnounces = value;
  }
  /** Announces blocked on a TOFU pin mismatch, replayed by a re-pin (OC-0212). */
  private get _blockedAnnounces(): Map<
    number,
    { publicKeyBase64: string; signatureBase64?: string }
  > {
    return this._peers.blockedAnnounces;
  }
  /** The key provider the Room E2EE workers read from, and its write queue.
   *  See e2eeWorker.ts. */
  private _worker = new E2EEWorker({
    getSessionGeneration: () => this._sessionGeneration,
    getRoomKey: () => this._roomKey,
  });
  /** E2EE key provider — shared across Room instances. */
  get keyProvider(): ExternalE2EEKeyProvider {
    return this._worker.keyProvider;
  }
  /** Receiving, applying, wrapping and pacing voice_e2ee_offer. See e2eeOffer.ts. */
  private _offers = new E2EEOffer({
    getWs: () => this.deps.getWs(),
    getAnnounceChain: () => this._announceChain,
    peerAttemptIsCurrent: (userId) => this._peers.peerAttemptIsCurrent(userId),
    getPeerPublicKeys: () => this._peerPublicKeys,
    getEcdhKeyPair: () => this._ecdhKeyPair,
    getEpoch: () => this._e2eeEpoch,
    getPeerOfferEpochs: () => this._peerOfferEpochs,
    getRoomKey: () => this._roomKey,
    setRoomKey: (roomKey) => {
      this._roomKey = roomKey;
    },
    applyRoomKey: (roomKey, isCurrent) => this._worker.applyRoomKey(roomKey, isCurrent),
    isKeyHolder: () => this._isKeyHolder,
    setKeyHolder: (value) => {
      this._isKeyHolder = value;
    },
    clearKeyRotationTimer: () => this._epoch.clearKeyRotationTimer(),
    getRoomKeyResolver: () => this._roomKeyResolver,
    setRoomKeyResolver: (resolver) => {
      this._roomKeyResolver = resolver;
    },
    getRoomKeyRejector: () => this._roomKeyRejector,
    setRoomKeyRejector: (rejector) => {
      this._roomKeyRejector = rejector;
    },
  });

  // ── State the manager itself owns ─────────────────────────────────────────
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
  get pendingAnnounces(): PendingAnnounce[] {
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
    const myFingerprint = await computeRawKeyFingerprint(rawFromBase64(myPubKeyBase64));
    // Build the signed announce up front — this loads the identity key from
    // the keyring once, so the added identity round-trip does NOT stack on
    // the non-key-holder's 10s key-exchange stall below (F3).
    const announcePayload = await this._identity.buildAnnouncePayload(myPubKeyBase64);

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
      await this._worker.applyCurrentRoomKey(() => this._sessionGeneration === myGeneration);
      if (this._sessionGeneration !== myGeneration) return false;
      log.info("E2EE: key holder — generated room key", { channelId });
      this._epoch.startKeyRotationTimer();
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
    const queued = this._pendingAnnounces.splice(0).map((announce) => ({
      ...announce,
      peerGeneration: this._peerGenerations.get(announce.userId) ?? 0,
    }));
    for (const {
      userId: qId,
      publicKeyBase64: qKey,
      signatureBase64: qSig,
      peerGeneration,
    } of queued) {
      if (this._sessionGeneration !== myGeneration || this._ecdhKeyPair !== ecdhKeyPair)
        return false;
      if ((this._peerGenerations.get(qId) ?? 0) !== peerGeneration) continue;
      // oxlint-disable-next-line no-await-in-loop -- sequential drain: verify each queued announce
      await this.handleAnnounce(qId, qKey, qSig);
      log.info("E2EE: drained queued announce", { userId: qId });
    }
    if (this._sessionGeneration !== myGeneration || this._ecdhKeyPair !== ecdhKeyPair) return false;

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
          // i18n-exempt: internal E2EE timeout, surfaces only as an unverified-peer badge
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
    // The announce below is a single unacknowledged send with no retry for a
    // key holder (see the non-holder confirm timer further down) — if the WS
    // isn't actually open, the frame is silently dropped (ws.ts's sendRaw)
    // and the freshly generated pair would be adopted locally while nobody
    // else ever learns its public half, permanently splitting the holder from
    // every peer. Keep the pre-reconnect keypair instead; the retained room
    // key still gets re-applied so audio keeps working. Forward secrecy for
    // this one reconnect attempt is lost, but that beats an unrecoverable
    // room-key mismatch.
    const wsState = this.deps.getWs()?.getState?.();
    if (wsState !== undefined && wsState !== "connected") {
      log.warn("E2EE: reconnect re-announce skipped — WS not connected, keeping current keypair");
      await this._worker.applyCurrentRoomKey(() => this._sessionGeneration === myGeneration);
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
    await this._worker.applyCurrentRoomKey(() => this._ecdhKeyPair === pair);
    if (this._ecdhKeyPair !== pair) return;
    const reconnectPubKey = await exportPublicKey(pair.publicKey);
    const reconnectFingerprint = await computeRawKeyFingerprint(rawFromBase64(reconnectPubKey));
    if (this._ecdhKeyPair === pair) {
      setLocalSessionFingerprint(reconnectFingerprint);
    }
    const reconnectAnnounce = await this._identity.buildAnnouncePayload(reconnectPubKey);
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

  /** Identity keys are host-scoped — the session drops the cached keypair when
   *  the host changes (and on cleanupAll). See E2EEIdentity.clearIdentityKeyPair. */
  clearIdentityKeyPair(): void {
    this._identity.clearIdentityKeyPair();
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
    const isCurrent = this._peers.peerAttemptIsCurrent(userId);
    const run = this._announceChain.then(() => {
      if (!isCurrent()) return undefined;
      return this.handleAnnounceInner(userId, publicKeyBase64, signatureBase64, isCurrent);
    });
    this._announceChain = run;
    return run;
  }

  private async handleAnnounceInner(
    userId: number,
    publicKeyBase64: string,
    signatureBase64: string | undefined,
    isCurrent: () => boolean,
  ): Promise<void> {
    // Queue if our keypair isn't ready yet (announce arrived during connectAndSetup).
    if (!this._ecdhKeyPair) {
      this._pendingAnnounces.push({ userId, publicKeyBase64, signatureBase64 });
      log.info("E2EE: queued announce (keypair not ready)", { userId });
      return;
    }
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
    if (this._peers.isRetiredPeerKey(userId, publicKeyBase64)) {
      log.error("E2EE: rejecting replayed peer key announce (previously retired)", { userId });
      return;
    }
    try {
      // ── F3 TOFU verification gate ──────────────────────────────────────
      // Resolve the peer's identity key and verify the announce signature
      // BEFORE storing the ECDH key or wrapping the room key. A malicious
      // server that swaps user_id↔ephemeral-key or forges keys fails here.
      if (
        !(await this._peers.verifyPeerAnnounce(userId, publicKeyBase64, signatureBase64, isCurrent))
      ) {
        return; // rejected/blocked — do not store or wrap
      }

      if (!isCurrent()) {
        log.info("E2EE: discarding stale announce (session torn down during verify)", { userId });
        return;
      }

      // Deduplicate: if the key is identical, skip the import but still
      // re-send the room key offer (the peer may be re-requesting after a
      // missed offer or reconnect).
      const existingKey = this._peerPublicKeys.get(userId);
      let peerKey: CryptoKey;
      let isDuplicate = false;
      let retiredKey: string | undefined;
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
          retiredKey = existingB64;
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
      if (!isCurrent()) {
        log.info("E2EE: discarding stale announce (session torn down during key import)", {
          userId,
        });
        return;
      }
      if (!isDuplicate) {
        if (retiredKey) this._peers.retirePeerKey(userId, retiredKey);
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
        this._epoch.clearKeyRotationTimer();
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
        if (!isCurrent() || this._e2eeEpoch !== epochBefore || this._ecdhKeyPair !== keypair) {
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
        const sent = await this._offers.sendOfferPaced(
          userId,
          encryptedKey,
          iv,
          () => !isCurrent() || this._e2eeEpoch !== epochBefore || this._ecdhKeyPair !== keypair,
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

  /**
   * Handle a voice_e2ee_offer from the server — the key holder has sent us
   * the encrypted room key. Applied strictly in delivery order, behind the
   * announces that preceded it. See E2EEOffer.handleOffer.
   */
  handleOffer(fromUserId: number, encryptedKeyBase64: string, ivBase64: string): Promise<void> {
    return this._offers.handleOffer(fromUserId, encryptedKeyBase64, ivBase64);
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
    this._peerGenerations.set(userId, (this._peerGenerations.get(userId) ?? 0) + 1);
    const isCurrent = this._peers.peerAttemptIsCurrent(userId);
    // peerAttemptIsCurrent() goes false for two unrelated reasons; only one of
    // them is survivable here, so keep the session half separately (OC-0442).
    const entrySessionGeneration = this._sessionGeneration;
    this._pendingAnnounces = this._pendingAnnounces.filter((entry) => entry.userId !== userId);
    this._blockedAnnounces.delete(userId);
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
      const departingKeyBase64 = await exportPublicKey(departingKey);
      // A clearState() during the await ended the session: channelId and
      // channelUsers above describe a room this manager has already torn
      // down, and the election below would set _isKeyHolder / rotate
      // _roomKey off them, corrupting whatever room is joined next. Abandon
      // the whole invocation, as this method did before OC-0416 (OC-0442).
      if (this._sessionGeneration !== entrySessionGeneration) return;
      // A duplicate handleParticipantLeft for the same peer is the other way
      // isCurrent() goes false, and it is survivable: it bumps only this
      // peer's generation, while this invocation's own hadPeerKey and the
      // wasKeyHolder read below stay correct. Scope that bail-out to the
      // now-redundant retirement write — returning would drop the
      // membership-forward-secrecy rekey a few lines down (OC-0416).
      if (isCurrent()) this._peers.retirePeerKey(userId, departingKeyBase64);
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
      const myGeneration = this._sessionGeneration;
      this._rotatingKey = true;
      this._isKeyHolder = true;
      log.info("E2EE: became key holder after participant left", { userId, channelId });

      // Rotate the room key — generate a new one and distribute to all remaining peers.
      try {
        const roomKey = await this._epoch.rotateRoomKey();
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
          await this._offers.distributeRoomKey(keypair, roomKey, peersSnapshot);
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
              await this._offers.distributeRoomKey(keypair, roomKey, lateArrivals);
              log.info("E2EE: sent rotated key to late-arriving peers", {
                peerCount: lateArrivals.length,
              });
            }
          }
        }
      } catch (err) {
        log.error("E2EE: failed to rotate room key", err);
      } finally {
        if (this._sessionGeneration === myGeneration) {
          this._rotatingKey = false;
          // A leave during this rotation may have deferred another rekey.
          await this._epoch.drainPendingRotationOrArmTimer();
        }
      }
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
        await this._epoch.rotateKeyPeriodically();
      }
    }
  }

  /** Rotate the room key on a timer tick. See E2EEEpoch.rotateKeyPeriodically. */
  rotateKeyPeriodically(): Promise<void> {
    return this._epoch.rotateKeyPeriodically();
  }

  /** Clear all E2EE state (called on voice leave). The long-term identity
   *  keypair is intentionally NOT cleared here — it persists across calls to
   *  the same host (cleared only on host change / cleanupAll). */
  clearState(): void {
    this._sessionGeneration++;
    this._channelId = null;
    this._offers.clearState();
    this._announceChain = Promise.resolve();
    this._ecdhKeyPair = null;
    this._roomKey = null;
    this._worker.clearRoomKey();
    this._peerPublicKeys.clear();
    this._peerGenerations.clear();
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
    this._epoch.clearKeyRotationTimer();
    this.clearReconnectConfirmTimer();
    // Reject (not resolve) so waiting setupKeyExchange sees a failure, not a
    // silent success with no room key.
    if (this._roomKeyRejector) {
      // i18n-exempt: internal voice teardown signal, never rendered
      this._roomKeyRejector(new Error("Voice session ended"));
    }
    this._roomKeyResolver = null;
    this._roomKeyRejector = null;
  }
}

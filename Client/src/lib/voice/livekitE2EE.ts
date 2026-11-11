// LiveKit E2EE manager — client-side ECDH key exchange extracted from livekitSession.ts.
// E2EEManager is the public class: it owns the session generation, the
// key-holder role and the join, reconnect, announce, re-pin and leave protocol,
// and composes the ownership modules under src/features/voice/ for the rest —
// e2eeIdentity (identity signing, F3, and the ephemeral keypair), e2eeEpoch
// (room key, epoch, rotation), e2eePeerState (peer keys and TOFU pin
// verification), e2eeWorker (the key provider and its write queue) and
// e2eeOffer (receiving and sending room-key offers).
import type { WsClient } from "@lib/ws";
import { LEGACY_PLACEMENT, type KeyPlacement } from "@lib/net/keyPlacement";
import {
  voiceStore,
  clearPeerVerifications,
  setLocalSessionFingerprint,
  setLocalSafetyNumber,
} from "@stores/voice.store";
import { createLogger } from "@lib/logger";
import { E2EEIdentity } from "../../features/voice/e2eeIdentity";
import { E2EEEpoch } from "../../features/voice/e2eeEpoch";
import { E2EEPeerState, type PendingAnnounce } from "../../features/voice/e2eePeerState";
import { E2EEWorker } from "../../features/voice/e2eeWorker";
import { E2EEOffer } from "../../features/voice/e2eeOffer";
import { createE2EEFlows } from "../../features/voice/e2eeFlows";
import type { E2EEHost } from "../../features/voice/e2eeHost";

const log = createLogger("livekitE2EE");

// --- Dependencies passed from LiveKitSession ---

export interface E2EEDeps {
  getWs: () => WsClient | null;
  getServerHost: () => string | null;
  getCurrentChannelId: () => number | null;
  /** A room key was installed into the worker (every install, browser and native). */
  onRoomKeyInstalled?: () => void;
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
  private _epoch: E2EEEpoch = new E2EEEpoch({
    isKeyHolder: () => this._isKeyHolder,
    getChannelId: () => this._channelId,
    getCurrentChannelId: () => this.deps.getCurrentChannelId(),
    getSessionGeneration: () => this._sessionGeneration,
    getEcdhKeyPair: () => this._ecdhKeyPair,
    getPeerPublicKeys: () => this._peerPublicKeys,
    applyRoomKey: (roomKey, placement) => this._worker.applyRoomKey(roomKey, undefined, placement),
    rotationPlacement: () => this.rotationPlacement(),
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
  /** Highest offer epoch applied per sender. */
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
  /** Keys a peer has been moved off this session (replay guard). */
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
  /** Announces blocked on a TOFU pin mismatch, replayed by a re-pin. */
  private get _blockedAnnounces(): Map<
    number,
    { publicKeyBase64: string; signatureBase64?: string; identityKeyBase64?: string }
  > {
    return this._peers.blockedAnnounces;
  }
  /** The key provider the Room E2EE workers read from, and its write queue.
   *  See e2eeWorker.ts. */
  private _worker: E2EEWorker = new E2EEWorker({
    getSessionGeneration: () => this._sessionGeneration,
    getRoomKey: () => this._roomKey,
    onKeyInstalled: () => this.deps.onRoomKeyInstalled?.(),
    getRoomKeyPlacement: () => this._epoch.roomKeyPlacement,
  });
  /** The current Room's E2EE key provider. */
  get keyProvider(): E2EEWorker["keyProvider"] {
    return this._worker.keyProvider;
  }
  /** A fresh key provider for a new Room. See e2eeWorker.ts. */
  newKeyProvider(): E2EEWorker["keyProvider"] {
    return this._worker.newKeyProvider();
  }
  /** Drop the ended call's key provider. See e2eeWorker.ts. */
  releaseKeyProvider(): void {
    this._worker.releaseKeyProvider();
  }
  /** Receiving, applying, wrapping and pacing voice_e2ee_offer. See e2eeOffer.ts. */
  private _offers: E2EEOffer = new E2EEOffer({
    getWs: () => this.deps.getWs(),
    getAnnounceChain: () => this._flows.announce.chain,
    peerAttemptIsCurrent: (userId) => this._peers.peerAttemptIsCurrent(userId),
    getPeerPublicKeys: () => this._peerPublicKeys,
    getEcdhKeyPair: () => this._ecdhKeyPair,
    getEpoch: () => this._e2eeEpoch,
    getPeerOfferEpochs: () => this._peerOfferEpochs,
    getRoomKey: () => this._roomKey,
    setRoomKey: (roomKey) => {
      this._roomKey = roomKey;
    },
    applyRoomKey: (roomKey, isCurrent, placement) =>
      this._worker.applyRoomKey(roomKey, isCurrent, placement),
    setRoomKeyPlacement: (placement) => {
      this._epoch.roomKeyPlacement = placement;
    },
    offerPlacement: (peerId) =>
      this.peerHasKeySlots(peerId) ? this._epoch.roomKeyPlacement : undefined,
    getMyUserId: () => this._identity.myUserId(),
    offerBinding: (peerId) => this._peers.offerBinding(peerId),
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

  /** What the announce, setup and leave modules reach the manager through. */
  private _host: E2EEHost = {
    identity: this._identity,
    epoch: this._epoch,
    peers: this._peers,
    worker: this._worker,
    offers: this._offers,
    getWs: () => this.deps.getWs(),
    getServerHost: () => this.deps.getServerHost(),
    getCurrentChannelId: () => this.deps.getCurrentChannelId(),
    getSessionGeneration: () => this._sessionGeneration,
    getChannelId: () => this._channelId,
    setChannelId: (channelId) => {
      this._channelId = channelId;
    },
    isKeyHolder: () => this._isKeyHolder,
    setKeyHolder: (value) => {
      this._isKeyHolder = value;
    },
    getRoomKeyResolver: () => this._roomKeyResolver,
    setRoomKeyWaiter: (resolver, rejector) => {
      this._roomKeyResolver = resolver;
      this._roomKeyRejector = rejector;
    },
    peerHasKeySlots: (userId) => this.peerHasKeySlots(userId),
    applyAnnounce: (...args) => this._flows.announce.apply(...args),
  };
  /** The announce, join/reconnect and leave flows. See e2eeFlows.ts. */
  private _flows = createE2EEFlows(this._host);

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

  // --- Key slots ---

  /** Whether `userId`'s announce said it stages keys in their own slot. */
  private peerHasKeySlots(userId: number): boolean {
    return voiceStore.getState().peerKeySlots?.has(userId) ?? false;
  }

  /** Where a rotated room key goes. With every peer on key slots it is staged
   *  in the slot nobody sends with, so no frame is ever encrypted with a key a
   *  peer lacks; any older peer keeps everyone on slot 0, swapped at once. */
  private rotationPlacement(): KeyPlacement {
    const peers = [...this._peerPublicKeys.keys()];
    if (peers.length === 0 || !peers.every((id) => this.peerHasKeySlots(id))) {
      return LEGACY_PLACEMENT;
    }
    return { slot: this._worker.sendSlot === 0 ? 1 : 0, stage: true };
  }

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

  // ── Join-time key exchange (e2eeSetup.ts) ────────────────────────────────

  /** Run the join's key exchange: a fresh ECDH keypair, the key holder's room
   *  key or the wait for its offer. False when it timed out after retry, so
   *  the caller surfaces the securing-timeout error and leaves voice. */
  setupKeyExchange(isKeyHolder: boolean, channelId: number): Promise<boolean> {
    return this._flows.setup.setupKeyExchange(isKeyHolder, channelId);
  }

  /** Auto-reconnect: a fresh keypair and a re-announce, re-applying the room
   *  key we still hold. See E2EESetup.reannounceForReconnect. */
  reannounceForReconnect(): Promise<void> {
    return this._flows.setup.reannounceForReconnect();
  }

  // ── Identity signing (F3 TOFU) ──────────────────────────────────────────

  /** Identity keys are host-scoped — the session drops the cached keypair when
   *  the host changes (and on cleanupAll). See E2EEIdentity.clearIdentityKeyPair. */
  clearIdentityKeyPair(): void {
    this._identity.clearIdentityKeyPair();
  }

  /** F3 TOFU re-pin recovery: pin the exact identity key the user verified
   *  out-of-band and replay the announce blocked on the mismatch. See
   *  E2EEAnnounce.rePinPeerIdentity. */
  rePinPeerIdentity(userId: number, verifiedKey: string): Promise<boolean> {
    return this._flows.announce.rePinPeerIdentity(userId, verifiedKey);
  }

  // ── Client-side E2EE handlers (ECDH key exchange) ───────────────────────

  /**
   * Handle a voice_e2ee_announce from the server — another participant has
   * announced their ECDH public key. Applied strictly in WS delivery order
   * (see E2EEAnnounce) after the F3 TOFU verification; peers with no
   * published identity key (legacy) are accepted but marked unverified.
   */
  handleAnnounce(
    userId: number,
    publicKeyBase64: string,
    signatureBase64?: string,
    identityKeyBase64?: string,
  ): Promise<void> {
    // A join for another attempt is queued behind the one in flight: this
    // announce is the queued channel's peer, not the live session's. Hold it
    // for that session — applying it here would store it (and, for a key
    // holder, wrap this session's room key for it) only for the queued join's
    // clearState()/setupKeyExchange to wipe it before its own exchange runs.
    if (
      this._peers.stageAnnounce({ userId, publicKeyBase64, signatureBase64, identityKeyBase64 })
    ) {
      log.info("E2EE: held announce for the queued join", { userId });
      return Promise.resolve();
    }
    return this._flows.announce.apply(userId, publicKeyBase64, signatureBase64, identityKeyBase64);
  }

  readonly peerKeys: Pick<E2EEPeerState, "trustedKeys" | "forgetKey"> = this._peers;

  /** Identity key from the peer's current announce (see E2EEPeerState). */
  peerAnnouncedIdentityKey(userId: number): string | null {
    return this._peers.announcedIdentityKey(userId);
  }

  /** Hold announces for a join to `channelId` that is queued behind the one in
   *  flight, until its setupKeyExchange(…, channelId) takes them. */
  holdAnnouncesForQueuedJoin(channelId: number): void {
    this._peers.holdAnnouncesFor(channelId);
  }

  /** Stop holding announces: no queued join is going to take them. What was
   *  held for `channelId` belongs to the live session on that channel, so it
   *  goes through the normal announce path instead of being dropped. */
  releaseHeldAnnounces(channelId: number): void {
    const held = this._peers.takeStagedAnnounces(channelId);
    this._peers.discardStagedAnnounces();
    for (const announce of held) {
      void this._flows.announce.apply(
        announce.userId,
        announce.publicKeyBase64,
        announce.signatureBase64,
        announce.identityKeyBase64,
      );
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

  /** A participant left: forget them, elect the key holder and rotate the room
   *  key so their copy stops working. See E2EELeave.handleParticipantLeft. */
  handleParticipantLeft(userId: number): Promise<void> {
    return this._flows.leave.handleParticipantLeft(userId);
  }

  /** Rotate the room key on a timer tick. See E2EEEpoch.rotateKeyPeriodically. */
  rotateKeyPeriodically(): Promise<void> {
    return this._epoch.rotateKeyPeriodically();
  }

  /** Clear all E2EE state (called on voice leave). The long-term identity
   *  keypair is intentionally NOT cleared here — it persists across calls to
   *  the same host (cleared only on host change / cleanupAll). */
  clearState(options?: { keepHeldAnnounces?: boolean }): void {
    // A queued join re-enters here to shed the attempt it replaces; the
    // announces held for it belong to the session it is about to start.
    if (options?.keepHeldAnnounces !== true) this._peers.discardStagedAnnounces();
    this._sessionGeneration++;
    this._channelId = null;
    this._offers.clearState();
    this._flows.announce.clearState();
    this._ecdhKeyPair = null;
    this._roomKey = null;
    this._epoch.roomKeyPlacement = LEGACY_PLACEMENT;
    this._worker.clearRoomKey();
    this._worker.resetSlots();
    this._peerPublicKeys.clear();
    this._peerGenerations.clear();
    this._retiredPeerKeys.clear();
    this._peerOfferEpochs.clear();
    clearPeerVerifications();
    setLocalSessionFingerprint(null);
    setLocalSafetyNumber(null);
    this._isKeyHolder = false;
    this._rotatingKey = false;
    this._rotationPending = false;
    this._e2eeEpoch = 0;
    this._pendingAnnounces.length = 0;
    this._blockedAnnounces.clear();
    this._peers.keyChangedPeers.clear();
    this._peers.announcedIdentityKeys.clear();
    this._epoch.clearKeyRotationTimer();
    this._flows.setup.clearReconnectConfirmTimer();
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

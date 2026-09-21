// Voice E2EE epoch and key rotation — extracted from livekitE2EE.ts.
// Owns the room key, the monotonic epoch that stamps every rotation, the
// per-sender offer high-water marks (OC-0001), and the periodic rotation loop
// with its timer and in-flight/deferred flags. The session generation, the
// key-holder role, the ECDH keypair and the peer set stay owned by
// E2EEManager; this module reads them only through E2EEEpochHost.
import { generateRoomKey } from "../../lib/e2eeCrypto";
import { createLogger } from "../../lib/logger";

// Same logger tag as before the extraction, so the E2EE log lines are unchanged.
const log = createLogger("livekitE2EE");

/** Everything the rotation loop needs from E2EEManager. Read on every use,
 *  never captured, so the manager stays the single owner of each value. */
export interface E2EEEpochHost {
  isKeyHolder(): boolean;
  /** The channel the running exchange was set up for, or null. */
  getChannelId(): number | null;
  /** The session facade's current channel, the fallback for getChannelId. */
  getCurrentChannelId(): number | null;
  getSessionGeneration(): number;
  getEcdhKeyPair(): CryptoKeyPair | null;
  getPeerPublicKeys(): Map<number, CryptoKey>;
  applyRoomKey(roomKey: Uint8Array): Promise<boolean>;
  distributeRoomKey(
    keypair: CryptoKeyPair,
    roomKey: Uint8Array,
    peers: Iterable<[number, CryptoKey]>,
  ): Promise<void>;
}

export class E2EEEpoch {
  /** The 256-bit symmetric room key (plaintext). Only held by the key holder
   *  initially; other participants receive it via ECDH-wrapped offers. */
  private _roomKey: Uint8Array | null = null;
  /** Highest offer epoch applied per sender (OC-0001). The holder binds its
   *  epoch into every wrapped room key; an offer below this mark is a
   *  superseded key and is discarded. Per sender because each client's epoch
   *  counter is local; reset when that sender's ephemeral key is replaced. */
  private _peerOfferEpochs: Map<number, number> = new Map();
  /** Guard: true while a key rotation is in progress (prevents concurrent rotations). */
  private _rotatingKey = false;
  /** Set when a keyed-peer leave coincides with an in-flight rotation: the rekey
   *  is deferred (not dropped) and re-run when the current rotation finishes, so
   *  a member that left mid-rotation is excluded from the fresh room key. */
  private _rotationPending = false;
  /** Monotonic counter incremented on every key rotation. handleOffer captures the
   *  epoch before async work and discards the result if epoch changed (stale offer). */
  private _e2eeEpoch = 0;
  /** Periodic key rotation timer — fires every KEY_ROTATION_INTERVAL_MS when key holder. */
  private _keyRotationTimer: ReturnType<typeof setTimeout> | null = null;
  /** Interval between periodic key rotations (5 minutes). */
  private static readonly KEY_ROTATION_INTERVAL_MS = 5 * 60 * 1000;

  constructor(private readonly host: E2EEEpochHost) {}

  // --- State owned here, read and written by E2EEManager ---

  get roomKey(): Uint8Array | null {
    return this._roomKey;
  }
  set roomKey(value: Uint8Array | null) {
    this._roomKey = value;
  }
  get epoch(): number {
    return this._e2eeEpoch;
  }
  set epoch(value: number) {
    this._e2eeEpoch = value;
  }
  get peerOfferEpochs(): Map<number, number> {
    return this._peerOfferEpochs;
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

  // --- Host views, named as the pre-extraction fields so the bodies read the same ---

  private get _isKeyHolder(): boolean {
    return this.host.isKeyHolder();
  }
  private get _channelId(): number | null {
    return this.host.getChannelId();
  }
  private get _sessionGeneration(): number {
    return this.host.getSessionGeneration();
  }
  private get _ecdhKeyPair(): CryptoKeyPair | null {
    return this.host.getEcdhKeyPair();
  }
  private get _peerPublicKeys(): Map<number, CryptoKey> {
    return this.host.getPeerPublicKeys();
  }
  private applyRoomKey(roomKey: Uint8Array): Promise<boolean> {
    return this.host.applyRoomKey(roomKey);
  }
  private distributeRoomKey(
    keypair: CryptoKeyPair,
    roomKey: Uint8Array,
    peers: Iterable<[number, CryptoKey]>,
  ): Promise<void> {
    return this.host.distributeRoomKey(keypair, roomKey, peers);
  }

  /** Install a fresh key before distribution; return null when superseded. */
  async rotateRoomKey(): Promise<Uint8Array | null> {
    this._e2eeEpoch++;
    const roomKey = generateRoomKey();
    this._roomKey = roomKey;
    return (await this.applyRoomKey(roomKey)) ? roomKey : null;
  }

  // ── Periodic key rotation ──────────────────────────────────────────────────

  /** Start the periodic key rotation timer (only meaningful for key holders). */
  startKeyRotationTimer(): void {
    this.clearKeyRotationTimer();
    if (!this._isKeyHolder) return;
    this._keyRotationTimer = setTimeout(() => {
      this._keyRotationTimer = null;
      void this.rotateKeyPeriodically();
    }, E2EEEpoch.KEY_ROTATION_INTERVAL_MS);
    log.debug("E2EE: key rotation timer started", {
      intervalMs: E2EEEpoch.KEY_ROTATION_INTERVAL_MS,
    });
  }

  clearKeyRotationTimer(): void {
    if (this._keyRotationTimer !== null) {
      clearTimeout(this._keyRotationTimer);
      this._keyRotationTimer = null;
    }
  }

  /** Rotate the room key on a timer tick (forward secrecy improvement). */
  async rotateKeyPeriodically(): Promise<void> {
    if (!this._isKeyHolder || this._rotatingKey) return;
    const channelId = this._channelId ?? this.host.getCurrentChannelId();
    if (!channelId) return;

    const myGeneration = this._sessionGeneration;
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
      if (this._sessionGeneration === myGeneration) {
        this._rotatingKey = false;
        // Also drain when another current-session key superseded this one.
        await this.drainPendingRotationOrArmTimer();
      }
    }
  }

  /** After a rotation completes: if a keyed-peer leave coincided with it (its
   *  rekey was deferred, not dropped), run one more rotation to exclude the
   *  departed member; otherwise re-arm the periodic rotation timer. */
  async drainPendingRotationOrArmTimer(): Promise<void> {
    if (this._rotationPending) {
      this._rotationPending = false;
      await this.rotateKeyPeriodically();
      return;
    }
    this.startKeyRotationTimer();
  }
}

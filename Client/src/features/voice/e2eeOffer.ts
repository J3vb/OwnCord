// Voice E2EE offer protocol — extracted from livekitE2EE.ts.
// Owns the voice_e2ee_offer side of the key exchange: receiving an offer
// (strictly in WS delivery order, behind the announces that preceded it) and
// applying its room key under the epoch/keypair staleness guards, and sending
// offers — wrapping the room key per peer and pacing every send through one
// shared budget under the server's rate limit. The session, key-holder role,
// peer set and room key stay owned by E2EEManager and its other modules; this
// module reaches them only through E2EEOfferHost.
import type { WsClient } from "../../lib/ws";
import { wrapRoomKey, unwrapRoomKey } from "../../lib/e2eeCrypto";
import { createLogger } from "../../lib/logger";

// Same logger tag as before the extraction, so the E2EE log lines are unchanged.
const log = createLogger("livekitE2EE");

/** Everything the offer protocol needs from E2EEManager. Read on every use,
 *  never captured, so each value keeps its single owner. */
export interface E2EEOfferHost {
  getWs(): WsClient | null;
  /** The announce chain an arriving offer must wait behind (OC-0002). */
  getAnnounceChain(): Promise<void>;
  peerAttemptIsCurrent(userId: number): () => boolean;
  getPeerPublicKeys(): Map<number, CryptoKey>;
  getEcdhKeyPair(): CryptoKeyPair | null;
  getEpoch(): number;
  getPeerOfferEpochs(): Map<number, number>;
  getRoomKey(): Uint8Array | null;
  setRoomKey(roomKey: Uint8Array | null): void;
  applyRoomKey(roomKey: Uint8Array, isCurrent: () => boolean): Promise<boolean>;
  isKeyHolder(): boolean;
  setKeyHolder(value: boolean): void;
  clearKeyRotationTimer(): void;
  getRoomKeyResolver(): (() => void) | null;
  setRoomKeyResolver(resolver: (() => void) | null): void;
  getRoomKeyRejector(): ((err: Error) => void) | null;
  setRoomKeyRejector(rejector: ((err: Error) => void) | null): void;
}

export class E2EEOffer {
  constructor(private readonly host: E2EEOfferHost) {}

  // --- Host views, named as the pre-extraction fields so the bodies read the same ---

  private get _announceChain(): Promise<void> {
    return this.host.getAnnounceChain();
  }
  private get _peerPublicKeys(): Map<number, CryptoKey> {
    return this.host.getPeerPublicKeys();
  }
  private get _ecdhKeyPair(): CryptoKeyPair | null {
    return this.host.getEcdhKeyPair();
  }
  private get _e2eeEpoch(): number {
    return this.host.getEpoch();
  }
  private get _peerOfferEpochs(): Map<number, number> {
    return this.host.getPeerOfferEpochs();
  }
  private get _roomKey(): Uint8Array | null {
    return this.host.getRoomKey();
  }
  private set _roomKey(value: Uint8Array | null) {
    this.host.setRoomKey(value);
  }
  private get _isKeyHolder(): boolean {
    return this.host.isKeyHolder();
  }
  private set _isKeyHolder(value: boolean) {
    this.host.setKeyHolder(value);
  }
  private get _roomKeyResolver(): (() => void) | null {
    return this.host.getRoomKeyResolver();
  }
  private set _roomKeyResolver(resolver: (() => void) | null) {
    this.host.setRoomKeyResolver(resolver);
  }
  private get _roomKeyRejector(): ((err: Error) => void) | null {
    return this.host.getRoomKeyRejector();
  }
  private set _roomKeyRejector(rejector: ((err: Error) => void) | null) {
    this.host.setRoomKeyRejector(rejector);
  }
  private peerAttemptIsCurrent(userId: number): () => boolean {
    return this.host.peerAttemptIsCurrent(userId);
  }
  private applyRoomKey(roomKey: Uint8Array, isCurrent: () => boolean): Promise<boolean> {
    return this.host.applyRoomKey(roomKey, isCurrent);
  }
  private clearKeyRotationTimer(): void {
    this.host.clearKeyRotationTimer();
  }

  /** Reset for a new session (called from E2EEManager.clearState). */
  clearState(): void {
    this._offerChain = Promise.resolve();
    // The server's offer rate limit is scoped per (sender, channel) — a
    // fresh channel gets a fresh bucket server-side, so stale timestamps
    // from the old channel must not throttle the new one.
    this._offerSendTimes.length = 0;
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
    const isCurrent = this.peerAttemptIsCurrent(fromUserId);
    const announcesBeforeOffer = this._announceChain;
    const run = this._offerChain
      .then(() => announcesBeforeOffer)
      .then(() => {
        if (!isCurrent()) return undefined;
        return this.handleOfferInner(fromUserId, encryptedKeyBase64, ivBase64, isCurrent);
      });
    this._offerChain = run;
    return run;
  }

  private async handleOfferInner(
    fromUserId: number,
    encryptedKeyBase64: string,
    ivBase64: string,
    isCurrent: () => boolean,
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
      if (!isCurrent() || this._e2eeEpoch !== epochBefore || this._ecdhKeyPair !== keypair) {
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
      if (!(await this.applyRoomKey(unwrapped, isCurrent))) return;
      log.info("E2EE: room key received and applied", { fromUserId, epoch });

      // Re-check after the setKey await too: the guard above only covers the
      // window up to unwrap, not this call. A teardown-and-rejoin-as-holder
      // landing here would otherwise have this stale continuation read the
      // NEW session's live _isKeyHolder/_roomKeyResolver below and stand it
      // down / resolve it — corrupting a session this attempt no longer owns
      // (OC-0010).
      if (!isCurrent() || this._e2eeEpoch !== epochBefore || this._ecdhKeyPair !== keypair) {
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
      if (isCurrent() && this._roomKeyRejector) {
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
    const cutoff = Date.now() - E2EEOffer.OFFER_RATE_WINDOW_MS;
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
  async sendOfferPaced(
    targetUserId: number,
    encryptedKey: string,
    iv: string,
    isStale?: () => boolean,
  ): Promise<boolean> {
    this.pruneOfferSendTimes();
    if (this._offerSendTimes.length >= E2EEOffer.OFFER_RATE_LIMIT_PER_SEC) {
      // Guarded by the length check above — the array is non-empty here.
      const oldest = this._offerSendTimes[0] as number;
      const waitMs = oldest + E2EEOffer.OFFER_RATE_WINDOW_MS - Date.now();
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
      this.pruneOfferSendTimes();
      if (isStale?.()) {
        return false;
      }
    }
    this._offerSendTimes.push(Date.now());
    this.host.getWs()?.send({
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
  async distributeRoomKey(
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
      // oxlint-disable-next-line no-await-in-loop -- sequential by design: each peer's staleness guard must observe the key state between wraps
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
      // oxlint-disable-next-line no-await-in-loop -- sequential by design: offers are rate-paced per peer, not fired in parallel
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
}

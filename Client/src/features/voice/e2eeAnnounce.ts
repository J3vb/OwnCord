// Voice E2EE announce protocol — extracted from livekitE2EE.ts.
// Owns the receiving side of voice_e2ee_announce: applying a peer's announce
// strictly in WS delivery order, verifying it (F3 TOFU) before trusting it,
// storing the peer's ECDH key and, as key holder, wrapping the room key for
// them; and the re-pin recovery that replays an announce blocked on a pin
// mismatch. The session, key-holder role and peer set stay owned by E2EEManager
// and its other modules; this module reaches them only through E2EEHost.
import { exportPublicKey, importPublicKey, wrapRoomKey } from "../../lib/net/e2eeCrypto";
import { storeIdentityPin } from "../../lib/net/identity";
import { authStore } from "../../stores/auth.store";
import { clearPeerVerification } from "../../stores/voice.store";
import { createLogger } from "../../lib/logger";
import type { E2EEHost } from "./e2eeHost";

// Same logger tag as before the extraction, so the E2EE log lines are unchanged.
const log = createLogger("livekitE2EE");

/** A peer's ECDH key resolved for an announce: the imported (or already held)
 *  key, whether it is the one on file, and the key it replaces when it changed. */
interface ResolvedPeerKey {
  peerKey: CryptoKey;
  isDuplicate: boolean;
  retiredKey: string | undefined;
}

export class E2EEAnnounce {
  constructor(private readonly host: E2EEHost) {}

  /** Serializes announce handling. Nothing chains concurrent invocations —
   *  dispatcher fires them unawaited and the queued-announce drain in
   *  setupKeyExchange is a separate, later pass — so two in-flight announces
   *  for the same peer could complete out of WS-delivery order, letting a
   *  stale announce's map write land after a fresher one and strand the peer
   *  on a dead key until the next rotation (finding v015). Mirrors
   *  E2EEOffer's offer chain, whose identical ordering guarantee this module
   *  relies on and tests; handleInner swallows its own errors (see its
   *  try/catch below), so the chain cannot wedge on a failed announce. */
  private _announceChain: Promise<void> = Promise.resolve();

  /** The chain an arriving offer must wait behind. */
  get chain(): Promise<void> {
    return this._announceChain;
  }

  /** Reset for a new session (called from E2EEManager.clearState). */
  clearState(): void {
    this._announceChain = Promise.resolve();
  }

  /** The announce body, past the queued-join hold: the live path and the
   *  replays of queued, held and re-pinned announces. */
  apply(
    userId: number,
    publicKeyBase64: string,
    signatureBase64?: string,
    identityKeyBase64?: string,
  ): Promise<void> {
    const isCurrent = this.host.peers.peerAttemptIsCurrent(userId);
    const run = this._announceChain.then(() => {
      if (!isCurrent()) return undefined;
      return this.handleInner(
        userId,
        publicKeyBase64,
        signatureBase64,
        isCurrent,
        identityKeyBase64,
      );
    });
    this._announceChain = run;
    return run;
  }

  private async handleInner(
    userId: number,
    publicKeyBase64: string,
    signatureBase64: string | undefined,
    isCurrent: () => boolean,
    identityKeyBase64?: string,
  ): Promise<void> {
    const peers = this.host.peers;
    // Queue if our keypair isn't ready yet (announce arrived during connectAndSetup).
    if (!this.host.identity.ecdhKeyPair) {
      peers.pendingAnnounces.push({ userId, publicKeyBase64, signatureBase64, identityKeyBase64 });
      log.info("E2EE: queued announce (keypair not ready)", { userId });
      return;
    }
    // Reject a replay of a key we've already retired for this peer BEFORE
    // verifyPeerAnnounce runs. verifyPeerAnnounce writes the peer's
    // displayed verification (status + sessionFingerprint, computed from
    // THIS announce's key) on every branch it can take, including its
    // success branches — so if the replay guard ran only after verification
    // (as it used to, further below), a replayed announce would overwrite
    // the peer's badge with the retired key's fingerprint/status before
    // being rejected, even though the peer key map itself was never touched.
    // This check is synchronous (no await), so it introduces no new window
    // for a session to be superseded before it runs.
    if (peers.isRetiredPeerKey(userId, publicKeyBase64)) {
      log.error("E2EE: rejecting replayed peer key announce (previously retired)", { userId });
      return;
    }
    try {
      // ── F3 TOFU verification gate ──────────────────────────────────────
      // Resolve the peer's identity key and verify the announce signature
      // BEFORE storing the ECDH key or wrapping the room key. A malicious
      // server that swaps user_id↔ephemeral-key or forges keys fails here.
      if (
        !(await peers.verifyPeerAnnounce(
          userId,
          publicKeyBase64,
          signatureBase64,
          isCurrent,
          identityKeyBase64,
        ))
      ) {
        return; // rejected/blocked — do not store or wrap
      }

      if (!isCurrent()) {
        log.info("E2EE: discarding stale announce (session torn down during verify)", { userId });
        return;
      }

      const resolved = await this.resolvePeerKey(userId, publicKeyBase64);
      // Re-check after the export/import awaits above: a clearState()+rejoin
      // landing during either one must not have this stale continuation write
      // a torn-down session's peer key into the map a NEW session now owns —
      // the generation guard above only covers the window up to verification,
      // not this later await.
      if (!isCurrent()) {
        log.info("E2EE: discarding stale announce (session torn down during key import)", {
          userId,
        });
        return;
      }
      this.storePeerKey(userId, resolved);
      await this.offerRoomKey(userId, resolved.peerKey, isCurrent);
    } catch (err) {
      log.error("E2EE: failed to handle announce", err);
    }
  }

  /** Deduplicate: if the key is identical, skip the import but still re-send
   *  the room key offer (the peer may be re-requesting after a missed offer or
   *  reconnect). */
  private async resolvePeerKey(userId: number, publicKeyBase64: string): Promise<ResolvedPeerKey> {
    const existingKey = this.host.peers.peerPublicKeys.get(userId);
    if (!existingKey) {
      return {
        peerKey: await importPublicKey(publicKeyBase64),
        isDuplicate: false,
        retiredKey: undefined,
      };
    }
    const existingB64 = await exportPublicKey(existingKey);
    if (existingB64 === publicKeyBase64) {
      log.debug("E2EE: duplicate announce — will re-send offer if key holder", { userId });
      return { peerKey: existingKey, isDuplicate: true, retiredKey: undefined };
    }
    // The replay-of-a-retired-key check runs up front, before
    // verifyPeerAnnounce — see handleInner.
    const peerKey = await importPublicKey(publicKeyBase64);
    log.warn("E2EE: peer public key changed (reconnect?)", { userId });
    return { peerKey, isDuplicate: false, retiredKey: existingB64 };
  }

  private storePeerKey(
    userId: number,
    { peerKey, isDuplicate, retiredKey }: ResolvedPeerKey,
  ): void {
    if (isDuplicate) return;
    const peers = this.host.peers;
    if (retiredKey) peers.retirePeerKey(userId, retiredKey);
    peers.peerPublicKeys.set(userId, peerKey);
    this.host.epoch.peerOfferEpochs.delete(userId);
    log.info("E2EE: received peer public key", { userId });
  }

  /** If we're the key holder and have a room key, wrap it for the new peer. */
  private async offerRoomKey(
    userId: number,
    peerKey: CryptoKey,
    isCurrent: () => boolean,
  ): Promise<void> {
    const { epoch } = this.host;
    // Capture keypair + roomKey before async work to avoid null dereference if
    // clearState() runs concurrently.
    const keypair = this.host.identity.ecdhKeyPair;
    const currentRoomKey = epoch.roomKey;
    if (!this.host.isKeyHolder()) return;
    // Key-holder election is server-authoritative — lowest
    // connected user id (Server/ws/voice_e2ee.go) — and is re-run on every
    // join, but the server has no demotion message and
    // handleVoiceTokenRefresh discards the corrected is_key_holder it gets
    // on every token refresh. So a stale holder's key-holder flag can outlive
    // its actual election. A peer announcing with a LOWER user id than
    // ours proves exactly that: the server would never have elected us
    // while they're connected, so an offer would only earn a NOT_KEY_HOLDER
    // refusal and an error toast. Stand down instead, as handleOfferInner does.
    const myUserId = authStore.getState().user?.id ?? 0;
    if (myUserId !== 0 && userId < myUserId) {
      this.host.setKeyHolder(false);
      epoch.clearKeyRotationTimer();
      log.info("E2EE: stood down as key holder — announcing peer has a lower user id", {
        userId,
        myUserId,
      });
    } else if (
      currentRoomKey &&
      keypair &&
      !this.host.peerHasKeySlots(userId) &&
      epoch.roomKeyPlacement.slot !== 0
    ) {
      // An older client only knows slot 0, and the call is sending on slot
      // 1: offering it this key would have it send on slot 0 with a key the
      // others hold in slot 1. A rotation moves everyone to a new key in
      // slot 0 at once (rotationPlacement sees the older peer) and offers
      // it to this peer with the rest.
      log.info("E2EE: an older client joined while on key slot 1 — rotating to slot 0", {
        userId,
      });
      epoch.requestRotation();
    } else if (currentRoomKey && keypair) {
      await this.wrapAndSendOffer(userId, peerKey, keypair, currentRoomKey, isCurrent);
    }
  }

  private async wrapAndSendOffer(
    userId: number,
    peerKey: CryptoKey,
    keypair: CryptoKeyPair,
    currentRoomKey: Uint8Array,
    isCurrent: () => boolean,
  ): Promise<void> {
    const { epoch, identity, peers } = this.host;
    // Capture epoch before the wrap await — a rotation racing this
    // announce already added the peer to the peer key map before we got
    // here, so it offers them the fresh key on its own; if that
    // happened, ship this pre-rotation wrap and the receiver's
    // strictly-ordered offer chain ends up on the dead key.
    const epochBefore = epoch.epoch;
    // A peer joining or coming back mid-call uses the key at once, in the
    // slot the call has it in.
    const { encryptedKey, iv } = await wrapRoomKey(
      keypair.privateKey,
      peerKey,
      currentRoomKey,
      epochBefore,
      this.host.peerHasKeySlots(userId)
        ? { slot: epoch.roomKeyPlacement.slot, stage: false }
        : undefined,
      peers.offerBinding(userId),
    );
    // The epoch advanced (a rotation landed during the wrap) OR the keypair no
    // longer matches (a concurrent reannounceForReconnect() swapped it without
    // bumping the epoch) — mirrors handleOfferInner's dual guard. An offer
    // wrapped under an abandoned keypair is undecryptable by the peer
    // (finding v101).
    const isStale = (): boolean =>
      !isCurrent() || epoch.epoch !== epochBefore || identity.ecdhKeyPair !== keypair;
    if (isStale()) {
      log.info("E2EE: discarding stale announce-offer (epoch or keypair changed during wrap)", {
        userId,
        epochBefore,
        epochNow: epoch.epoch,
      });
      return;
    }
    // Routed through the shared sendOfferPaced budget rather
    // than sent directly — setupKeyExchange's queued-announce drain can
    // call this once per existing participant in an uninterrupted loop
    // (a key holder joining a large ongoing call), and those sends must
    // draw from the same per-second budget as rotation offers instead of
    // bypassing pacing entirely.
    const sent = await this.host.offers.sendOfferPaced(userId, encryptedKey, iv, isStale);
    if (!sent) {
      log.info(
        "E2EE: discarding stale announce-offer (epoch or keypair changed during pacing pause)",
        { userId, epochBefore, epochNow: epoch.epoch },
      );
      return;
    }
    log.info("E2EE: sent room key offer to peer", { userId });
  }

  /**
   * F3 TOFU re-pin recovery (finding #4). Pin the EXACT identity key
   * `verifiedKey` — the bytes whose fingerprint the caller displayed and the
   * user confirmed out-of-band — overwriting the stored pin for {host,userId}
   * and clearing the mismatch block (the identity-key analogue of accepting a
   * changed TLS cert). A changed key that verifies is re-pinned automatically
   * in verifyPeerAnnounce; this path recovers a peer blocked for a key the
   * server stopped delivering. The next announce re-verifies against the new
   * pin.
   *
   * The verified key MUST be passed in, never re-read from membersStore here:
   * the store is server-writable (a `user_update` mutates it), so re-reading it
   * would let a malicious server swap in an attacker key during the human
   * out-of-band verification window and have us pin THAT — a TOCTOU that
   * silently defeats the mismatch prompt. Returns false when there is no host
   * or no key to pin.
   */
  async rePinPeerIdentity(userId: number, verifiedKey: string): Promise<boolean> {
    const host = this.host.getServerHost();
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
    // peer as a mismatch. Without this, the pin write above is a
    // no-op for the live call: nothing else re-runs the peer's announce, so
    // they never (re-)enter the peer key map — staying out of every offer and
    // rotation for the rest of the call — and clearPeerVerification below
    // would erase the badge entirely rather than showing the real (now
    // hopefully "verified") outcome. The announce re-verifies against the
    // pin just stored above and writes the real status itself, so it stands
    // in for clearPeerVerification when a replay is available.
    const blocked = this.host.peers.blockedAnnounces;
    const pending = blocked.get(userId);
    if (pending) {
      blocked.delete(userId);
      log.info("E2EE: replaying blocked announce after re-pin (TOFU recovery)", { userId });
      await this.host.applyAnnounce(
        userId,
        pending.publicKeyBase64,
        pending.signatureBase64,
        pending.identityKeyBase64,
      );
    } else {
      clearPeerVerification(userId);
    }
    log.info("E2EE: re-pinned peer identity key (TOFU recovery)", { userId });
    return true;
  }
}

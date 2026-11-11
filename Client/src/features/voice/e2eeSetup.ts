// Voice E2EE join-time key exchange — extracted from livekitE2EE.ts.
// Owns the two ways a client (re)enters an exchange: setupKeyExchange, run at
// join (fresh ECDH keypair, key-holder room key, announce, drain of queued
// announces, wait for the holder's offer), and reannounceForReconnect (fresh
// keypair and re-announce after an auto-reconnect, with the bounded
// room-key confirmation check). Every await in them is followed by the
// generation or keypair-ownership check that tells a torn-down or superseded
// attempt to stop. The session, key-holder role and peer set stay owned by
// E2EEManager and its other modules; this module reaches them only through
// E2EEHost, read on every use.
import {
  generateECDHKeyPair,
  exportPublicKey,
  generateRoomKey,
  computeRawKeyFingerprint,
} from "../../lib/net/e2eeCrypto";
import { LEGACY_PLACEMENT } from "../../lib/net/keyPlacement";
import {
  clearPeerVerifications,
  setLocalSessionFingerprint,
  setLocalSafetyNumber,
} from "../../stores/voice.store";
import { createLogger } from "../../lib/logger";
import { markJoinMilestone } from "../../lib/voice/voiceJoinTrace";
import { rawFromBase64, type E2EEIdentity } from "./e2eeIdentity";
import type { E2EEHost } from "./e2eeHost";

// Same logger tag as before the extraction, so the E2EE log lines are unchanged.
const log = createLogger("livekitE2EE");

type AnnouncePayload = Awaited<ReturnType<E2EEIdentity["buildAnnouncePayload"]>>;

/** What this client announces for its fresh ephemeral key. */
interface LocalAnnounce {
  payload: AnnouncePayload;
  fingerprint: string;
  safetyNumber: string | null;
}

export class E2EESetup {
  constructor(private readonly host: E2EEHost) {}

  /** How long to wait after a reconnect re-announce before treating a
   *  non-holder's re-applied room key as unconfirmed (see reannounceForReconnect). */
  private static readonly RECONNECT_CONFIRM_MS = 5_000;
  private _reconnectConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  clearReconnectConfirmTimer(): void {
    if (this._reconnectConfirmTimer !== null) {
      clearTimeout(this._reconnectConfirmTimer);
      this._reconnectConfirmTimer = null;
    }
  }

  private isSuperseded(myGeneration: number): boolean {
    return this.host.getSessionGeneration() !== myGeneration;
  }

  private sendAnnounce(payload: AnnouncePayload): void {
    this.host.getWs()?.send({ type: "voice_e2ee_announce", payload });
  }

  /**
   * Run the client-side E2EE key exchange for a join (called from
   * connectAndSetup before room.connect). Generates a fresh ECDH keypair,
   * drains queued announces, then either generates the room key (key holder)
   * or announces and waits for the key holder's offer.
   *
   * Returns false when the key exchange timed out after retry — the caller
   * surfaces the securing-timeout error and leaves voice.
   */
  async setupKeyExchange(isKeyHolder: boolean, channelId: number): Promise<boolean> {
    const { host } = this;
    // Captured before any await so a clearState() that lands anywhere below
    // (before we publish the ECDH keypair) can be detected even though
    // nothing about our local state is null yet — see E2EEManager's
    // session generation.
    const myGeneration = host.getSessionGeneration();
    host.setChannelId(channelId);
    this.adoptStagedAnnounces(channelId);
    // Generate a fresh ECDH keypair for this session, but keep it local and
    // do NOT publish it to the identity until right before the drain
    // below (after the key-holder role/room key are ready). Until then,
    // the announce handler's `!ecdhKeyPair` guard queues any announce that
    // arrives concurrently instead of running it through the live path —
    // where it would be stored in the peer key map but sent no offer (role/
    // roomKey not set up yet) and then never seen by the drain either (it was
    // never queued), stranding that peer until the next 5-minute rotation.
    const ecdhKeyPair = await generateECDHKeyPair();
    // Superseded already? Everything below this point mutates state a newer
    // session owns, so bail before the first write — clearing the live
    // session's peer keys/verifications would drop every subsequent rotation
    // for those peers (handleOffer's unknown-peer guard).
    if (this.isSuperseded(myGeneration)) {
      log.warn("E2EE: setup superseded during keypair generation — aborting", { channelId });
      return false;
    }
    host.peers.peerPublicKeys.clear();
    host.peers.retiredPeerKeys.clear();
    host.epoch.peerOfferEpochs.clear();
    clearPeerVerifications();
    const local = await this.buildLocalAnnounce(ecdhKeyPair);

    // Same check again after the keyring round trip — the widest window of
    // the three, and the next statements install OUR role and room key over
    // whatever session is live now: a superseded non-holder attempt would
    // clear the live holder's role (silently stopping its rotations
    // and its offers to new peers), and a superseded holder attempt would
    // push a room key nobody else has onto the shared key provider.
    if (this.isSuperseded(myGeneration)) {
      log.warn("E2EE: setup superseded before key-holder setup — aborting", { channelId });
      return false;
    }

    // Use server-authoritative is_key_holder from voice_token payload — OR'd
    // with whatever the role already is. The server value was
    // captured when we started joining and cannot see a handleParticipantLeft
    // promotion that landed during the awaits above: the generation check
    // just above proves no clearState() ran since myGeneration was captured,
    // so the only other writer of this field for THIS generation is that
    // promotion — unconditionally overwriting it with the stale server value
    // strands the newly-elected holder waiting for an offer nobody (least of
    // all itself) will ever send, timing out and ejecting it from voice.
    host.setKeyHolder(isKeyHolder || host.isKeyHolder());

    if (host.isKeyHolder() && !(await this.generateHolderRoomKey(myGeneration, channelId))) {
      return false;
    }

    // And once more after keyProvider.setKey's await: a torn-down attempt
    // that resurrects the ECDH keypair here would defeat the queue guard in
    // the announce handler and go on to announce a dead ephemeral key over a
    // live call (finding v043).
    if (this.isSuperseded(myGeneration)) {
      log.warn("E2EE: setup superseded before keypair publish — aborting", { channelId });
      return false;
    }

    // Publish the keypair now — right before the drain, so every announce
    // that arrived during the awaits above was queued (not silently
    // processed with no offer sent) and gets its offer sent below.
    host.identity.ecdhKeyPair = ecdhKeyPair;
    setLocalSessionFingerprint(local.fingerprint);
    setLocalSafetyNumber(local.safetyNumber);

    if (host.isKeyHolder()) {
      // Announce our (signed) key BEFORE draining queued announces. The
      // drain below sends each drained peer a voice_e2ee_offer, and the
      // receiver can only unwrap it once it has OUR ephemeral public key on
      // file — which only our own announce provides. The relayed announce
      // and our offer land in the SAME inbound WS queue on the peer's side
      // (voice_join relay and the offer send both go through the peer's
      // c.send queue), so the send order here is the delivery order there.
      // Announcing AFTER the drain (the old order) meant every existing
      // participant's handleOfferInner discarded our offer as "unknown
      // peer" and never recovered short of the 5-minute rotation.
      this.sendAnnounce(local.payload);
      markJoinMilestone("e2ee announce sent");
    }

    if (!(await this.drainQueuedAnnounces(myGeneration, ecdhKeyPair))) return false;
    // Re-check attempt ownership after the announce drain, before the role is
    // read or the room-key waiter installed.
    if (this.isSuperseded(myGeneration) || host.identity.ecdhKeyPair !== ecdhKeyPair) {
      return false;
    }

    if (host.isKeyHolder()) return true;
    return this.awaitHolderOffer(ecdhKeyPair, local.payload, channelId);
  }

  /** Announces held while this join waited behind another attempt join the
   *  queue the drain replays. Taken synchronously, before any await:
   *  the held ones are the newest word on their peer, so they replace an
   *  older queued entry for the same user. */
  private adoptStagedAnnounces(channelId: number): void {
    const { peers } = this.host;
    const staged = peers.takeStagedAnnounces(channelId);
    if (staged.length > 0) {
      peers.pendingAnnounces = [
        ...peers.pendingAnnounces.filter((p) => !staged.some((s) => s.userId === p.userId)),
        ...staged,
      ];
    }
  }

  /** Our ephemeral key's fingerprint and the signed announce for it. The
   *  announce is built up front — this loads the identity key from the keyring
   *  once, so the added identity round-trip does NOT stack on the
   *  non-key-holder's 10s key-exchange stall (F3). */
  private async buildLocalAnnounce(ecdhKeyPair: CryptoKeyPair): Promise<LocalAnnounce> {
    const { identity } = this.host;
    const myPubKeyBase64 = await exportPublicKey(ecdhKeyPair.publicKey);
    const fingerprint = await computeRawKeyFingerprint(rawFromBase64(myPubKeyBase64));
    const payload = await identity.buildAnnouncePayload(myPubKeyBase64);
    // Only a signed announce gives peers a safety number to compare ours with.
    const safetyNumber = payload.signature === undefined ? null : await identity.safetyNumber();
    return { payload, fingerprint, safetyNumber };
  }

  /** Generate the room key BEFORE draining queued announces, so the
   *  drain's announce handling hits the wrap-and-offer branch and every
   *  drained peer receives the fresh key immediately. Mid-call peers never
   *  re-announce (the announce handler replies with an offer, not a
   *  counter-announce), so the only later delivery would be the 5-minute
   *  rotation timer — stranding them on a dead key whenever a new key
   *  holder joins an ongoing call. False when superseded. */
  private async generateHolderRoomKey(myGeneration: number, channelId: number): Promise<boolean> {
    const { epoch, worker } = this.host;
    epoch.epoch++;
    epoch.roomKey = generateRoomKey();
    epoch.roomKeyPlacement = LEGACY_PLACEMENT;
    await worker.applyCurrentRoomKey(() => !this.isSuperseded(myGeneration));
    if (this.isSuperseded(myGeneration)) return false;
    log.info("E2EE: key holder — generated room key", { channelId });
    markJoinMilestone("e2ee room key generated");
    epoch.startKeyRotationTimer();
    return true;
  }

  /** Drain any announces that arrived before our keypair was ready. These
   *  are existing participants whose keys the server relayed during
   *  voice_join sync — run them through the normal verifying receive path
   *  so a server-substituted peer key is caught here too. False when the
   *  attempt was superseded. */
  private async drainQueuedAnnounces(
    myGeneration: number,
    ecdhKeyPair: CryptoKeyPair,
  ): Promise<boolean> {
    const { host } = this;
    const { peers } = host;
    const owns = (): boolean =>
      !this.isSuperseded(myGeneration) && host.identity.ecdhKeyPair === ecdhKeyPair;
    const queued = peers.pendingAnnounces.splice(0).map((announce) => ({
      ...announce,
      peerGeneration: peers.peerGenerations.get(announce.userId) ?? 0,
    }));
    for (const {
      userId: qId,
      publicKeyBase64: qKey,
      signatureBase64: qSig,
      identityKeyBase64: qIdentity,
      peerGeneration,
    } of queued) {
      if (!owns()) return false;
      if ((peers.peerGenerations.get(qId) ?? 0) !== peerGeneration) continue;
      // oxlint-disable-next-line no-await-in-loop -- sequential drain: verify each queued announce
      await host.applyAnnounce(qId, qKey, qSig, qIdentity);
      log.info("E2EE: drained queued announce", { userId: qId });
    }
    return owns();
  }

  /** The resolver/rejector pair a non-holder's join waits on. */
  private armRoomKeyWait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.host.setRoomKeyWaiter(resolve, reject);
    });
  }

  private async awaitHolderOffer(
    ecdhKeyPair: CryptoKeyPair,
    announcePayload: AnnouncePayload,
    channelId: number,
  ): Promise<boolean> {
    const { host } = this;
    // Wait for the key holder to send us the room key via voice_e2ee_offer.
    // This promise resolves when handleOffer() sets the room key.
    log.info("E2EE: waiting for room key from key holder", { channelId });
    const roomKeyPromise = this.armRoomKeyWait();
    // Announce BEFORE waiting (moved earlier per F3) so the key holder can
    // offer immediately. The resolver is set above, so an immediate offer
    // won't be missed.
    this.sendAnnounce(announcePayload);
    markJoinMilestone("e2ee announce sent");
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
      // and, unlike a decrypt failure, nulls the ECDH keypair — there is nobody
      // left to retry with. Stop here instead of re-announcing into a torn-
      // down session and reinstalling a resolver nothing will ever call.
      // Compare by identity, not just null: a torn-down-then-restarted
      // session can leave the keypair non-null but owned by a
      // completely different (superseded) attempt — retrying would
      // re-announce our dead ephemeral key over that live session and
      // steal its single room-key resolver slot (finding v043).
      if (host.identity.ecdhKeyPair !== ecdhKeyPair) {
        log.warn("E2EE: key exchange aborted (session cleared or superseded)", { channelId });
        return false;
      }
      log.warn("E2EE: first key exchange attempt timed out, re-announcing", { channelId });
      this.sendAnnounce(announcePayload);
      // roomKeyPromise may already be SETTLED (rejected) at this point — a
      // decrypt failure rejects it permanently, so racing the SAME promise
      // again would resolve rejected on the very next microtask instead of
      // giving the retry its intended 5s window. Create a fresh promise and
      // reinstall the resolver/rejector before racing again.
      const retryPromise = this.armRoomKeyWait();
      try {
        await Promise.race([retryPromise, makeTimeout(5_000)]);
      } catch {
        log.error("E2EE: key exchange timed out after retry — disconnecting", { channelId });
        host.setRoomKeyWaiter(null, null);
        if (timeoutId !== null) clearTimeout(timeoutId);
        return false;
      }
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }
    host.setRoomKeyWaiter(null, null);
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
    const { host } = this;
    const { identity, worker } = host;
    // Captured before any await so a clearState() (e.g. the user hits
    // Disconnect during auto-reconnect) that lands during this method's
    // awaits can be detected instead of silently resurrecting
    // the ECDH keypair / re-announcing for a channel we already left
    // (finding v093).
    const myGeneration = host.getSessionGeneration();
    const pair = await generateECDHKeyPair();
    if (this.isSuperseded(myGeneration)) {
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
    const wsState = host.getWs()?.getState?.();
    if (wsState !== undefined && wsState !== "connected") {
      log.warn("E2EE: reconnect re-announce skipped — WS not connected, keeping current keypair");
      await worker.applyCurrentRoomKey(() => !this.isSuperseded(myGeneration));
      return;
    }
    identity.ecdhKeyPair = pair;
    // Peers' ECDH public keys and their TOFU verifications survive: they are
    // unaffected by regenerating OUR pair, and ECDH still works (our new
    // private key against their existing public key). Clearing them here would
    // be permanent — the announce handler replies with an offer rather than a
    // counter-announce, and the server relays stored peer keys only on
    // voice_join — so handleOffer's unknown-peer guard would drop every
    // subsequent rotation, stranding us on the pre-reconnect key.
    await worker.applyCurrentRoomKey(() => identity.ecdhKeyPair === pair);
    if (identity.ecdhKeyPair !== pair) return;
    const reconnectPubKey = await exportPublicKey(pair.publicKey);
    const reconnectFingerprint = await computeRawKeyFingerprint(rawFromBase64(reconnectPubKey));
    if (identity.ecdhKeyPair === pair) {
      setLocalSessionFingerprint(reconnectFingerprint);
    }
    const reconnectAnnounce = await identity.buildAnnouncePayload(reconnectPubKey);
    // Re-check ownership right before the send too: buildAnnouncePayload can
    // itself await a keyring round trip, another window for clearState() (or
    // a fresh setupKeyExchange) to have superseded this attempt.
    if (identity.ecdhKeyPair !== pair) {
      log.warn("E2EE: reconnect re-announce superseded before send — discarding stray announce");
      return;
    }
    this.sendAnnounce(reconnectAnnounce);
    this.armReconnectConfirm(pair, reconnectAnnounce);
  }

  /** Non-key-holders: nothing here waits for, times out, or retries the
   *  holder's confirming offer — the caller (connectAndSetup's reconnect
   *  path) marks the call "Secured" the moment room.connect() resolves,
   *  regardless of whether the re-applied (possibly stale, rotated-during-
   *  the-outage) room key was ever confirmed current. Arm a bounded,
   *  non-blocking check: if nothing has replaced this room key by the time
   *  it fires, log it (there was previously no observable signal at all)
   *  and retry the announce once — a real bound short of the 5-minute
   *  periodic rotation. Holders don't need this: their own key
   *  IS the current one. */
  private armReconnectConfirm(pair: CryptoKeyPair, reconnectAnnounce: AnnouncePayload): void {
    const { host } = this;
    this.clearReconnectConfirmTimer();
    const roomKeyAtReconnect = host.epoch.roomKey;
    // Only meaningful when we actually re-applied a pre-existing key — with
    // none yet, there is nothing that could have gone "stale" and this is
    // just the ordinary first-offer wait (setupKeyExchange's own concern).
    if (host.isKeyHolder() || roomKeyAtReconnect === null) return;
    this._reconnectConfirmTimer = setTimeout(() => {
      this._reconnectConfirmTimer = null;
      if (
        host.identity.ecdhKeyPair !== pair ||
        host.epoch.roomKey !== roomKeyAtReconnect ||
        host.isKeyHolder()
      ) {
        return; // superseded, already reconfirmed by a fresh offer, or re-elected holder
      }
      log.error("E2EE: room key not reconfirmed after reconnect — may be stale, re-announcing", {
        channelId: host.getChannelId(),
      });
      this.sendAnnounce(reconnectAnnounce);
    }, E2EESetup.RECONNECT_CONFIRM_MS);
  }
}

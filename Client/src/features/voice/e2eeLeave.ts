// Voice E2EE participant departure — extracted from livekitE2EE.ts.
// Owns what happens when a peer leaves the voice channel: forgetting
// everything held for them, retiring their key against announce replay,
// electing the key holder (lowest user id among the remaining participants),
// and rotating the room key so the leaver's copy stops working (membership
// forward secrecy). The session, key-holder role and peer set stay owned by
// E2EEManager and its other modules; this module reaches them only through
// E2EEHost, read on every use.
import { exportPublicKey } from "../../lib/net/e2eeCrypto";
import { authStore } from "../../stores/auth.store";
import { clearPeerVerification, voiceStore } from "../../stores/voice.store";
import { createLogger } from "../../lib/logger";
import type { E2EEHost } from "./e2eeHost";

// Same logger tag as before the extraction, so the E2EE log lines are unchanged.
const log = createLogger("livekitE2EE");

export class E2EELeave {
  constructor(private readonly host: E2EEHost) {}

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
    const { peers } = this.host;
    peers.peerGenerations.set(userId, (peers.peerGenerations.get(userId) ?? 0) + 1);
    const isCurrent = peers.peerAttemptIsCurrent(userId);
    // peerAttemptIsCurrent() goes false for two unrelated reasons; only one of
    // them is survivable here, so keep the session half separately.
    const entrySessionGeneration = this.host.getSessionGeneration();
    const departingKey = this.forgetPeer(userId);

    const channelId = this.host.getChannelId() ?? this.host.getCurrentChannelId();
    const state = voiceStore.getState();
    const channelUsers = channelId ? state.voiceUsers.get(channelId) : undefined;

    // Retire the departing peer's key: the retired-key map is the only
    // defense against replay of a validly-signed announce (the signed
    // message carries no channel/epoch/nonce, F3) and the announce handler
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
    // the stale voice_leave for the join instance it superseded.
    // If the local roster (voice_state, kept current by the server) still
    // lists this peer as present in the channel, this IS that stale case:
    // retiring their (in that case, still-live) key would have every later,
    // genuine re-announce of it rejected as a replay, permanently stranding
    // a peer who never actually left. Skip retirement in that case — the key
    // is still removed from the peer key map above (and, below, this event
    // still correctly excludes them from any resulting rotation) so nothing
    // regresses for a genuine departure.
    //
    // `channelUsers` is a POST-mutation read: the only real VOICE_LEAVE
    // caller (dispatcher.ts) deletes the user from the voice-user roster
    // BEFORE calling this method, so `channelUsers?.has(userId)` is always
    // false by the time we get here in production — this guard only ever
    // protects the stale-leave case for a caller that reads the roster itself
    // without that prior mutation (as tests do). An earlier attempt to plug that
    // production gap by having the caller pass a PRE-mutation roster
    // snapshot (`stillInRoster`) instead, but that snapshot cannot tell the
    // two cases apart either: the roster still lists a departing
    // peer as present right up until this very event is what removes them,
    // so the snapshot reads "still present" on every genuine departure too,
    // not just the stale-leave case it was meant to isolate. Gating on it
    // made retirement never run in production, silently killing this replay
    // defense — worse than the gap it was meant to close. A real fix for the
    // stale-leave race needs a discriminator the roster does not carry (e.g. the
    // server stamping a join/epoch id on voice_leave so a stale leave for a
    // superseded join can be dropped outright), not a roster read taken at
    // any point during this call.
    if (departingKey && !channelUsers?.has(userId)) {
      const departingKeyBase64 = await exportPublicKey(departingKey);
      // A clearState() during the await ended the session: channelId and
      // channelUsers above describe a room this manager has already torn
      // down, and the election below would set the key-holder role / rotate
      // the room key off them, corrupting whatever room is joined next. Abandon
      // the whole invocation, as this method did before the rekey below.
      if (this.host.getSessionGeneration() !== entrySessionGeneration) return;
      // A duplicate handleParticipantLeft for the same peer is the other way
      // isCurrent() goes false, and it is survivable: it bumps only this
      // peer's generation, while this invocation's own hadPeerKey and the
      // wasKeyHolder read below stay correct. Scope that bail-out to the
      // now-redundant retirement write — returning would drop the
      // membership-forward-secrecy rekey a few lines down.
      if (isCurrent()) peers.retirePeerKey(userId, departingKeyBase64);
    }

    if (!channelId) return;
    await this.electAndRotate(userId, channelId, channelUsers, departingKey !== undefined);
  }

  /** Drop everything held for the departed peer and return the ECDH key they
   *  had on file, if any. */
  private forgetPeer(userId: number): CryptoKey | undefined {
    const { peers, epoch } = this.host;
    peers.pendingAnnounces = peers.pendingAnnounces.filter((entry) => entry.userId !== userId);
    peers.dropStagedAnnounce(userId);
    peers.blockedAnnounces.delete(userId);
    peers.announcedIdentityKeys.delete(userId);
    const departingKey = peers.peerPublicKeys.get(userId);
    peers.peerPublicKeys.delete(userId);
    epoch.peerOfferEpochs.delete(userId);
    clearPeerVerification(userId);
    return departingKey;
  }

  /** Elect key holder: lowest user_id among remaining participants. The
   *  local roster comes from voice_state broadcasts, including our own —
   *  which can arrive AFTER a peer's voice_leave when we joined the channel
   *  concurrently with their departure (the server already elected us; our
   *  own broadcast is still queued behind theirs on the hub). Seed the
   *  roster with our own id unconditionally so that race can't leave the
   *  channel's roster entry empty/missing and silently skip election
   *  — the join that provoked it would otherwise time out 15s
   *  later with no recovery. */
  private lowestRemainingUserId(
    myUserId: number,
    channelUsers: ReadonlyMap<number, unknown> | undefined,
  ): number {
    let lowestUserId = myUserId !== 0 ? myUserId : Infinity;
    if (channelUsers) {
      for (const uid of channelUsers.keys()) {
        if (uid < lowestUserId) lowestUserId = uid;
      }
    }
    return lowestUserId;
  }

  private async electAndRotate(
    userId: number,
    channelId: number,
    channelUsers: ReadonlyMap<number, unknown> | undefined,
    hadPeerKey: boolean,
  ): Promise<void> {
    const myUserId = authStore.getState().user?.id ?? 0;
    const lowestUserId = this.lowestRemainingUserId(myUserId, channelUsers);
    if (lowestUserId === Infinity) return; // nobody known yet, including ourselves

    const wasKeyHolder = this.host.isKeyHolder();

    if (myUserId !== 0 && lowestUserId === myUserId && !wasKeyHolder) {
      await this.becomeKeyHolder(userId, channelId);
    } else if (wasKeyHolder && hadPeerKey) {
      await this.rekeyForLeaver();
    }
  }

  private async becomeKeyHolder(userId: number, channelId: number): Promise<void> {
    const { epoch } = this.host;
    // A rotation is already in flight (e.g. we stood down mid-rotation
    // after accepting another holder's offer, and are now re-elected
    // because THEY left). Don't drop the re-election — that would strand
    // the room with no key holder until the next voice_leave self-heals
    // it. Mirror the sibling branch below: defer, don't drop. The
    // in-flight rotation's finally -> drainPendingRotationOrArmTimer will
    // run rotateKeyPeriodically as holder once it completes.
    if (epoch.rotatingKey) {
      this.host.setKeyHolder(true);
      epoch.rotationPending = true;
      log.warn("E2EE: key rotation already in progress — deferring re-election as holder", {
        userId,
        channelId,
      });
      return;
    }
    const myGeneration = this.host.getSessionGeneration();
    epoch.rotatingKey = true;
    this.host.setKeyHolder(true);
    log.info("E2EE: became key holder after participant left", { userId, channelId });

    // Rotate the room key — generate a new one and distribute to all remaining peers.
    try {
      const roomKey = await epoch.rotateRoomKey();
      if (roomKey === null) {
        // Superseded while setKey was in flight — the now-current session
        // owns its own key-holder role and rotation; nothing left to do.
        return;
      }
      log.info("E2EE: rotated room key", { channelId, epoch: epoch.epoch });
      this.releaseJoinWaiter();
      await this.offerRotatedKey(roomKey);
    } catch (err) {
      log.error("E2EE: failed to rotate room key", err);
    } finally {
      if (this.host.getSessionGeneration() === myGeneration) {
        epoch.rotatingKey = false;
        // A leave during this rotation may have deferred another rekey.
        await epoch.drainPendingRotationOrArmTimer();
      }
    }
  }

  /** A client elected while still waiting inside setupKeyExchange has a
   *  pending resolver — the offer it is waiting for will never arrive
   *  (we are the holder now), so unblock it with the key just generated. */
  private releaseJoinWaiter(): void {
    const resolver = this.host.getRoomKeyResolver();
    if (resolver) {
      resolver();
      this.host.setRoomKeyWaiter(null, null);
    }
  }

  private async offerRotatedKey(roomKey: Uint8Array): Promise<void> {
    const { identity, epoch, peers, offers } = this.host;
    // Snapshot peers (and the keypair) before the async loop — new peers
    // that arrive during wrapping are handled by the post-rotation check
    // below.
    const keypair = identity.ecdhKeyPair;
    const peersSnapshot = new Map(peers.peerPublicKeys);

    if (!keypair) return;
    await offers.distributeRoomKey(keypair, roomKey, peersSnapshot);
    log.info("E2EE: distributed rotated key to peers", {
      peerCount: peersSnapshot.size,
    });

    // H3: Check for peers that arrived during the rotation loop and
    // send them the new key too.
    if (keypair !== identity.ecdhKeyPair || epoch.roomKey !== roomKey) return;
    const lateArrivals = [...peers.peerPublicKeys].filter(([peerId]) => !peersSnapshot.has(peerId));
    if (lateArrivals.length > 0) {
      await offers.distributeRoomKey(keypair, roomKey, lateArrivals);
      log.info("E2EE: sent rotated key to late-arriving peers", {
        peerCount: lateArrivals.length,
      });
    }
  }

  /** Membership forward secrecy: I remain the key holder and a peer that held
   *  the room key left, so rotate + redistribute to the CURRENT peer set
   *  (which already excludes the leaver) — otherwise the departed member keeps
   *  a valid room key against the untrusted SFU until the next periodic
   *  rotation. */
  private async rekeyForLeaver(): Promise<void> {
    const { epoch } = this.host;
    if (epoch.rotatingKey) {
      // A rotation is already in flight and may already have sent the current
      // key to this leaver before they left. Don't DROP the rekey (that would
      // leave the departed member holding a live key) — defer it so it re-runs
      // when the in-flight rotation completes, excluding them.
      epoch.rotationPending = true;
    } else {
      await epoch.rotateKeyPeriodically();
    }
  }
}

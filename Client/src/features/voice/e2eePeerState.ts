// Voice E2EE peer state and verification — extracted from livekitE2EE.ts.
// Owns what this client knows about each peer: the ECDH public keys, the
// per-peer membership generations that invalidate work for a departed peer,
// the retired keys that block announce replay, the announces queued
// before our keypair was ready and the ones blocked on a TOFU mismatch,
// and the TOFU verification that decides whether an announce is
// accepted and which status the voice panel shows. The session generation
// stays owned by E2EEManager; this module reads it through E2EEPeerStateDeps.
import {
  importIdentityPublicKey,
  verifyEphemeralKeySignature,
  computeKeyFingerprint,
  computeRawKeyFingerprint,
} from "../../lib/net/e2eeCrypto";
import { getIdentityPin, storeIdentityPin } from "../../lib/net/identity";
import { trustedPins } from "../../lib/net/identityPins";
import { memberDisplayName, membersStore } from "../../stores/members.store";
import { setPeerVerification } from "../../stores/voice.store";
import { createLogger } from "../../lib/logger";
import { showToast } from "../../lib/toast";
import { voiceText } from "../../i18n/voice";
import { rawFromBase64 } from "./e2eeIdentity";

// Same logger tag as before the extraction, so the E2EE log lines are unchanged.
const log = createLogger("livekitE2EE");

/** An announce received before our ECDH keypair was ready. */
export interface PendingAnnounce {
  userId: number;
  publicKeyBase64: string;
  signatureBase64?: string;
  /** Identity key of the announcing device, when the server sent one. */
  identityKeyBase64?: string;
}

export interface E2EEPeerStateDeps {
  getServerHost: () => string | null;
  /** E2EEManager's session generation, bumped by every clearState(). */
  getSessionGeneration: () => number;
}

export class E2EEPeerState {
  /** Peer ECDH public keys indexed by userId. */
  private _peerPublicKeys: Map<number, CryptoKey> = new Map();
  /** Invalidates work for a departed membership while allowing a fresh rejoin. */
  private _peerGenerations: Map<number, number> = new Map();
  /** Ephemeral keys we've seen superseded for a given peer this session
   *  (base64), indexed by userId. A signed announce carries no channel/epoch/
   *  nonce (F3), so a validly-signed announce replays cleanly — this blocks a
   *  replay of a key we already moved a peer off of from overwriting their
   *  current live key. */
  private _retiredPeerKeys: Map<number, Set<string>> = new Map();
  /** Announces that arrived before our ECDH keypair was ready. Drained after keypair init. */
  private _pendingAnnounces: PendingAnnounce[] = [];
  /** Announces received while a join for `_stagedChannelId` waits behind the
   *  join in flight. They belong to that channel's future session, not the one
   *  still live, so they are held here (one entry per peer, latest wins) and
   *  handed to setupKeyExchange for exactly that channel. Survives the
   *  queued-join clearState() calls; dropped by every other clearState(). */
  private _stagedAnnounces: PendingAnnounce[] = [];
  private _stagedChannelId: number | null = null;
  /** Announce that verifyPeerAnnounce rejected as a TOFU pin mismatch, keyed
   *  by userId — buffered so a subsequent successful rePinPeerIdentity can
   *  replay it instead of leaving the recovery a no-op for the live call:
   *  a mid-call peer never re-announces on its own, so nothing
   *  else would re-run verification against the freshly-stored pin. At most
   *  one entry per peer; a later mismatch (or a later legitimate announce)
   *  simply overwrites the previous one. Cleared in clearState(). */
  private _blockedAnnounces: Map<
    number,
    { publicKeyBase64: string; signatureBase64?: string; identityKeyBase64?: string }
  > = new Map();
  /** The identity key each peer's CURRENT announce was verified (or blocked)
   *  against: the announce's own key when the server sent one, else the
   *  member's published key. Read by the verify panel so the safety number
   *  shown is the one of the device actually in the call. Cleared in
   *  clearState() and when the peer leaves. */
  private _announcedIdentityKeys: Map<number, string> = new Map();
  /** Peers whose identity key changed and was accepted automatically this
   *  session, mapped to the latest key a notice was shown for, so their badge
   *  keeps showing the change after later announces verify cleanly against the
   *  new pin and every further change raises its own notice. Cleared in
   *  clearState(). */
  private _keyChangedPeers: Map<number, string> = new Map();

  constructor(private readonly deps: E2EEPeerStateDeps) {}

  // --- State owned here, read and written by E2EEManager ---

  get peerPublicKeys(): Map<number, CryptoKey> {
    return this._peerPublicKeys;
  }
  get peerGenerations(): Map<number, number> {
    return this._peerGenerations;
  }
  get retiredPeerKeys(): Map<number, Set<string>> {
    return this._retiredPeerKeys;
  }
  get pendingAnnounces(): PendingAnnounce[] {
    return this._pendingAnnounces;
  }
  set pendingAnnounces(value: PendingAnnounce[]) {
    this._pendingAnnounces = value;
  }
  /** Start (or retarget) holding announces for a queued join. Retargeting to a
   *  different channel drops what was held for the previous one: a rapid
   *  A -> B -> C switch keeps only C's. */
  holdAnnouncesFor(channelId: number): void {
    if (this._stagedChannelId !== channelId) this._stagedAnnounces = [];
    this._stagedChannelId = channelId;
  }
  /** Hold `announce` for the queued join. False when nothing is queued, so the
   *  caller processes it in the live session as usual. */
  stageAnnounce(announce: PendingAnnounce): boolean {
    if (this._stagedChannelId === null) return false;
    this._stagedAnnounces = this._stagedAnnounces.filter(
      (entry) => entry.userId !== announce.userId,
    );
    this._stagedAnnounces.push(announce);
    return true;
  }
  dropStagedAnnounce(userId: number): void {
    this._stagedAnnounces = this._stagedAnnounces.filter((entry) => entry.userId !== userId);
  }
  /** Hand over what was held for `channelId` and stop holding. Anything held
   *  for another channel is never applied to this one, and is left in place. */
  takeStagedAnnounces(channelId: number): PendingAnnounce[] {
    // A hold for another channel is never applied here, and can only be a
    // NEWER queued join's (this exchange is the one that was queued earlier),
    // so it is left alone for that join to take.
    if (this._stagedChannelId !== channelId) return [];
    const mine = this._stagedAnnounces;
    this.discardStagedAnnounces();
    return mine;
  }
  discardStagedAnnounces(): void {
    this._stagedAnnounces = [];
    this._stagedChannelId = null;
  }
  get blockedAnnounces(): Map<
    number,
    { publicKeyBase64: string; signatureBase64?: string; identityKeyBase64?: string }
  > {
    return this._blockedAnnounces;
  }
  get announcedIdentityKeys(): Map<number, string> {
    return this._announcedIdentityKeys;
  }
  /** The identity key from the peer's current announce, or null when none has
   *  been seen this call. */
  announcedIdentityKey(userId: number): string | null {
    return this._announcedIdentityKeys.get(userId) ?? null;
  }
  get keyChangedPeers(): Map<number, string> {
    return this._keyChangedPeers;
  }

  // --- Host view, named as the pre-extraction field so the bodies read the same ---

  private get _sessionGeneration(): number {
    return this.deps.getSessionGeneration();
  }

  /** Capture ownership when a frame arrives, before it waits on a work queue. */
  peerAttemptIsCurrent(userId: number): () => boolean {
    const generation = this._sessionGeneration;
    const peerGeneration = this._peerGenerations.get(userId) ?? 0;
    return () =>
      this._sessionGeneration === generation &&
      (this._peerGenerations.get(userId) ?? 0) === peerGeneration;
  }

  /** True if `publicKeyBase64` is a key we've already moved this peer off of
   *  in the current session (see `_retiredPeerKeys`). */
  isRetiredPeerKey(userId: number, publicKeyBase64: string): boolean {
    return this._retiredPeerKeys.get(userId)?.has(publicKeyBase64) ?? false;
  }

  /** Record that `publicKeyBase64` is no longer this peer's live key —
   *  a later announce carrying it again is a replay, not a legitimate change. */
  retirePeerKey(userId: number, publicKeyBase64: string): void {
    const retired = this._retiredPeerKeys.get(userId);
    if (retired) {
      retired.add(publicKeyBase64);
    } else {
      this._retiredPeerKeys.set(userId, new Set([publicKeyBase64]));
    }
  }

  /**
   * F3 TOFU: resolve a peer's identity key and verify their ephemeral-announce
   * signature. The key is the announce's own `identity_public_key` (the
   * announcing device's key) when the server sent one, else the member's
   * published key (older server or older peer). A peer can have several
   * devices, each with its own key, so the pin store keeps every key seen for
   * them and any pinned key is trusted. A key not seen before for a peer who
   * already has pins is accepted once the announce verifies against it: it is
   * added to the pins (nothing is overwritten, so switching back is silent),
   * the peer shows as "changed" while that key is in the call, and the user
   * gets one "new device" notice naming them. A pinned peer whose key the
   * server stopped delivering is still blocked ("mismatch") until the user
   * re-pins.
   * Returns true when the announce may be accepted (verified, or a legacy peer
   * with no identity key), false to reject/block. The store write is the
   * surfaced verification state the voice panel reads.
   *
   * Compatibility posture (transition):
   *   - peer HAS a published identity key, signature missing/invalid → reject
   *     (fail closed);
   *   - peer has NO identity key (legacy client) → accept, mark unverified
   *     (pin-pending).
   */
  async verifyPeerAnnounce(
    userId: number,
    publicKeyBase64: string,
    signatureBase64: string | undefined,
    isCurrent: () => boolean,
    announcedIdentityKey?: string,
  ): Promise<boolean> {
    const publishedIdentity =
      announcedIdentityKey ??
      membersStore.getState().members.get(userId)?.identityPublicKey ??
      null;
    if (isCurrent()) {
      // The entry always mirrors the LATEST announce: one that carries no key
      // (and no published fallback) must not leave a previous announce's key
      // behind for the verify panel to show.
      if (publishedIdentity) this._announcedIdentityKeys.set(userId, publishedIdentity);
      else this._announcedIdentityKeys.delete(userId);
    }
    const host = this.deps.getServerHost();
    const sessionGeneration = this._sessionGeneration;

    // Resolve the persisted pin FIRST — before any legacy shortcut. A server
    // must not be able to strip a pinned peer's published key (or swap it) to
    // force it back onto the legacy accept path (finding #2: TOFU pin bypass).
    const lookup = host
      ? await getIdentityPin(host, String(userId))
      : ({ status: "unpinned" } as const);
    if (!isCurrent()) return false;

    // Fail closed when the pin store could not be read: with the pin
    // unknown, this peer might be pinned to a different key — proceeding down
    // the first-sight path would verify against, and then RE-PIN, whatever key
    // the server delivered. Reject the announce and surface the distinct
    // "unknown" state; the peer stays blocked for E2EE until the store recovers.
    if (lookup.status === "unavailable") {
      this.setPeerVerificationIfCurrent(isCurrent, {
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

    const trusted = lookup.status === "pinned" ? trustedPins(lookup) : [];
    const pin = lookup.status === "pinned" ? lookup.pin : null;

    // Pinned peer whose delivered key the server stopped sending. There is no
    // key to verify against or re-pin, so block until the user re-pins.
    if (pin !== null && !publishedIdentity) {
      // Buffer this announce so a successful rePinPeerIdentity can
      // replay it: a mid-call peer never re-announces on its own, so without
      // this, re-pinning writes a new pin that nothing ever verifies the
      // peer's key against, leaving them un-keyed for the rest of the call.
      this._blockedAnnounces.set(userId, {
        publicKeyBase64,
        signatureBase64,
        identityKeyBase64: announcedIdentityKey,
      });
      this.setPeerVerificationIfCurrent(isCurrent, {
        userId,
        status: "mismatch",
        safetyNumber: null,
        sessionFingerprint: null,
      });
      log.error("E2EE: pinned peer identity key missing — blocking (identity-tofu)", {
        userId,
      });
      return false;
    }
    // Pinned peer announcing a key none of the pins match (a new device, a
    // reinstall, or a swapped key). Accepted below only if the announce
    // verifies against the NEW key; the key is then added to the pins and the
    // user notified once.
    const keyChanged = pin !== null && !!publishedIdentity && !trusted.includes(publishedIdentity);

    // Fingerprint of the ephemeral key this announce carries. Every
    // accepted peer gets one — for an unverified peer it is the only value
    // that can be compared out of band, since there is no identity key.
    const sessionFingerprint = await computeRawKeyFingerprint(rawFromBase64(publicKeyBase64));

    // Genuine legacy peer: never pinned AND no published identity key — accept
    // but mark unverified (pin-pending). This is the only case the compatibility
    // posture keeps open.
    if (!publishedIdentity) {
      this.setPeerVerificationIfCurrent(isCurrent, {
        userId,
        status: "unverified",
        safetyNumber: null,
        sessionFingerprint,
      });
      log.warn("E2EE: peer has no identity key — accepting as unverified (legacy)", { userId });
      return true;
    }

    // Verify the ephemeral-key signature against the delivered identity key:
    // it equals the pin when one matched, and is the key about to be pinned on
    // first sight or after a change.
    const identityKey = await importIdentityPublicKey(publishedIdentity);
    const ephemeralRaw = rawFromBase64(publicKeyBase64);
    const ok = signatureBase64
      ? await verifyEphemeralKeySignature(identityKey, userId, ephemeralRaw, signatureBase64)
      : false;
    if (!ok) {
      // Fail closed: peer has an identity key but no valid signature (MITM).
      // Buffered like the missing-key block so a re-pin replays and
      // re-verifies it rather than clearing the badge.
      if (isCurrent())
        this._blockedAnnounces.set(userId, {
          publicKeyBase64,
          signatureBase64,
          identityKeyBase64: announcedIdentityKey,
        });
      this.setPeerVerificationIfCurrent(isCurrent, {
        userId,
        status: "mismatch",
        safetyNumber: null,
        sessionFingerprint: null,
      });
      log.error("E2EE: peer announce signature invalid — rejecting (MITM?)", { userId });
      return false;
    }

    // First sight (or a new device's key) with a valid signature — pin the
    // identity key now. A failed write (disk full, unwritable pins file) must
    // not display "verified" with no pin ever persisted: the pin is what arms
    // mismatch detection on a LATER announce, so a peer we call verified but
    // never pinned can never have that check fire — the exact MITM window the
    // pin exists to close. "no-store" (non-Tauri: no pin store by design) is
    // not a failure and keeps the normal verified outcome below.
    if (!isCurrent()) return false;
    let pinWriteFailed = false;
    if ((pin === null || keyChanged) && host) {
      const pinResult = await storeIdentityPin(host, String(userId), publishedIdentity);
      if (pinResult === "failed") {
        pinWriteFailed = true;
        log.error("E2EE: failed to persist identity pin — marking unverified, not verified", {
          userId,
        });
      } else if (keyChanged) {
        log.warn("E2EE: peer is using a new device key — accepted and pinned (identity-tofu)", {
          userId,
        });
      } else {
        log.info("E2EE: pinned peer identity key on first sight", { userId });
      }
    }
    if (
      keyChanged &&
      (!pinWriteFailed || isCurrent()) &&
      this._keyChangedPeers.get(userId) !== publishedIdentity
    ) {
      if (this._sessionGeneration === sessionGeneration) {
        this._keyChangedPeers.set(userId, publishedIdentity);
      }
      const member = membersStore.getState().members.get(userId);
      showToast(
        voiceText("identity.newDevice", {
          name: member ? memberDisplayName(member) : String(userId),
        }),
        "warning",
        Infinity,
      );
    }
    if (pinWriteFailed) {
      this.setPeerVerificationIfCurrent(isCurrent, {
        userId,
        status: "unverified",
        safetyNumber: null,
        sessionFingerprint,
      });
      return true; // still accept the announce — the write failure alone shouldn't block the call
    }
    const safetyNumber = await computeKeyFingerprint(identityKey);
    // "changed" only while the newly seen key is the one in the call: the
    // peer switching back to a device whose key was already trusted is plain
    // "verified", with no notice.
    if (this._keyChangedPeers.get(userId) === publishedIdentity) {
      this.setPeerVerificationIfCurrent(isCurrent, {
        userId,
        status: "changed",
        safetyNumber,
        sessionFingerprint,
      });
      return true;
    }
    this.setPeerVerificationIfCurrent(isCurrent, {
      userId,
      status: "verified",
      safetyNumber,
      sessionFingerprint,
    });
    return true;
  }

  /** Verification belongs to both the call and the peer's current membership.
   *  Re-check that ownership after async verification before updating the UI. */
  private setPeerVerificationIfCurrent(
    isCurrent: () => boolean,
    verification: Parameters<typeof setPeerVerification>[0],
  ): void {
    if (!isCurrent()) return;
    setPeerVerification(verification);
  }
}

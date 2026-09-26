// Voice E2EE peer state and verification — extracted from livekitE2EE.ts.
// Owns what this client knows about each peer: the ECDH public keys, the
// per-peer membership generations that invalidate work for a departed peer,
// the retired keys that block announce replay (OC-0011), the announces queued
// before our keypair was ready and the ones blocked on a TOFU mismatch
// (OC-0212), and the F3 TOFU verification that decides whether an announce is
// accepted and which status the voice panel shows. The session generation
// stays owned by E2EEManager; this module reads it through E2EEPeerStateDeps.
import {
  importIdentityPublicKey,
  verifyEphemeralKeySignature,
  computeKeyFingerprint,
  computeRawKeyFingerprint,
} from "../../lib/e2eeCrypto";
import { getIdentityPin, storeIdentityPin } from "../../lib/identity";
import { membersStore } from "../../stores/members.store";
import { setPeerVerification } from "../../stores/voice.store";
import { createLogger } from "../../lib/logger";
import { rawFromBase64 } from "./e2eeIdentity";

// Same logger tag as before the extraction, so the E2EE log lines are unchanged.
const log = createLogger("livekitE2EE");

/** An announce received before our ECDH keypair was ready. */
export interface PendingAnnounce {
  userId: number;
  publicKeyBase64: string;
  signatureBase64?: string;
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
   *  current live key (OC-0011). */
  private _retiredPeerKeys: Map<number, Set<string>> = new Map();
  /** Announces that arrived before our ECDH keypair was ready. Drained after keypair init. */
  private _pendingAnnounces: PendingAnnounce[] = [];
  /** Announce that verifyPeerAnnounce rejected as a TOFU pin mismatch, keyed
   *  by userId — buffered so a subsequent successful rePinPeerIdentity can
   *  replay it instead of leaving the recovery a no-op for the live call
   *  (OC-0212): a mid-call peer never re-announces on its own, so nothing
   *  else would re-run verification against the freshly-stored pin. At most
   *  one entry per peer; a later mismatch (or a later legitimate announce)
   *  simply overwrites the previous one. Cleared in clearState(). */
  private _blockedAnnounces: Map<number, { publicKeyBase64: string; signatureBase64?: string }> =
    new Map();

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
  get blockedAnnounces(): Map<number, { publicKeyBase64: string; signatureBase64?: string }> {
    return this._blockedAnnounces;
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
  async verifyPeerAnnounce(
    userId: number,
    publicKeyBase64: string,
    signatureBase64: string | undefined,
    isCurrent: () => boolean,
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
    if (!isCurrent()) return false;

    // Fail closed when the pin store could not be read (DC-08): with the pin
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

    const pin = lookup.status === "pinned" ? lookup.pin : null;

    // Pinned peer whose delivered key is absent or differs from the pin —
    // possible server MITM. Block until the user re-pins.
    if (pin !== null && publishedIdentity !== pin) {
      // Buffer this announce (OC-0212) so a successful rePinPeerIdentity can
      // replay it: a mid-call peer never re-announces on its own, so without
      // this, re-pinning writes a new pin that nothing ever verifies the
      // peer's key against, leaving them un-keyed for the rest of the call.
      this._blockedAnnounces.set(userId, { publicKeyBase64, signatureBase64 });
      this.setPeerVerificationIfCurrent(isCurrent, {
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

    // Verify the ephemeral-key signature against the trusted identity key
    // (the pin when we have one, else the first-sight published key).
    const anchorBase64 = pin ?? publishedIdentity;
    const identityKey = await importIdentityPublicKey(anchorBase64);
    const ephemeralRaw = rawFromBase64(publicKeyBase64);
    const ok = signatureBase64
      ? await verifyEphemeralKeySignature(identityKey, userId, ephemeralRaw, signatureBase64)
      : false;
    if (!ok) {
      // Fail closed: peer has an identity key but no valid signature (MITM).
      this.setPeerVerificationIfCurrent(isCurrent, {
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
    if (!isCurrent()) return false;
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
      this.setPeerVerificationIfCurrent(isCurrent, {
        userId,
        status: "unverified",
        safetyNumber: null,
        sessionFingerprint,
      });
      return true; // still accept the announce — the write failure alone shouldn't block the call
    }
    const safetyNumber = await computeKeyFingerprint(identityKey);
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

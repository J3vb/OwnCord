// The session's end-to-end encryption surface: delegates to E2EEManager (which
// owns the keypair, room key and TOFU identity pinning) and the test-visible
// proxies for its state.
import type { E2EEManager } from "@lib/voice/livekitE2EE";
import type { ForgetIdentityPinResult } from "@lib/net/identity";
import { SessionMedia } from "./sessionMedia";

export abstract class SessionE2ee extends SessionMedia {
  protected abstract readonly _e2ee: E2EEManager;

  // --- Test-visibility proxies (E2EE state lives in E2EEManager; unit tests
  //     reach these via `(session as any)` — keep the field names stable) ---
  protected get _peerPublicKeys(): Map<number, CryptoKey> {
    return this._e2ee.peerPublicKeys;
  }
  protected get _e2eeEpoch(): number {
    return this._e2ee.epoch;
  }
  protected get _rotatingKey(): boolean {
    return this._e2ee.rotatingKey;
  }
  protected set _rotatingKey(value: boolean) {
    this._e2ee.rotatingKey = value;
  }
  protected get _rotationPending(): boolean {
    return this._e2ee.rotationPending;
  }
  protected set _rotationPending(value: boolean) {
    this._e2ee.rotationPending = value;
  }
  protected get _pendingAnnounces(): Array<{
    userId: number;
    publicKeyBase64: string;
    signatureBase64?: string;
    identityKeyBase64?: string;
  }> {
    return this._e2ee.pendingAnnounces;
  }
  /** Test-visibility delegate: periodic rotation lives on the E2EEManager. */
  protected rotateKeyPeriodically(): Promise<void> {
    return this._e2ee.rotateKeyPeriodically();
  }

  // ── Client-side E2EE delegates (state + protocol live in E2EEManager) ───

  /**
   * F3 TOFU re-pin recovery: pin the exact identity key the user verified
   * out-of-band, clearing a mismatch block. See E2EEManager.rePinPeerIdentity.
   */
  async rePinPeerIdentity(userId: number, verifiedKey: string): Promise<boolean> {
    return this._e2ee.rePinPeerIdentity(userId, verifiedKey);
  }

  /**
   * Handle a voice_e2ee_announce from the server — another participant has
   * announced their ECDH public key. See E2EEManager.handleAnnounce.
   */
  async handleE2EEAnnounce(
    userId: number,
    publicKeyBase64: string,
    signatureBase64?: string,
    identityKeyBase64?: string,
  ): Promise<void> {
    return this._e2ee.handleAnnounce(userId, publicKeyBase64, signatureBase64, identityKeyBase64);
  }

  /** Every identity key trusted for a peer. See E2EEPeerState.trustedKeys. */
  trustedPeerKeys(userId: number): Promise<readonly string[] | null> {
    return this._e2ee.peerKeys.trustedKeys(userId);
  }

  /** Stop trusting one of a peer's keys. See E2EEPeerState.forgetKey. */
  forgetPeerKey(userId: number, key: string): Promise<ForgetIdentityPinResult> {
    return this._e2ee.peerKeys.forgetKey(userId, key);
  }

  /** The identity key from the peer's current announce, or null when they have
   *  announced none this call (the verify panel then falls back to the
   *  published key). See E2EEPeerState.announcedIdentityKey. */
  peerAnnouncedIdentityKey(userId: number): string | null {
    return this._e2ee.peerAnnouncedIdentityKey(userId);
  }

  /**
   * Handle a voice_e2ee_offer from the server — the key holder has sent us
   * the encrypted room key. See E2EEManager.handleOffer.
   */
  async handleE2EEOffer(
    fromUserId: number,
    encryptedKeyBase64: string,
    ivBase64: string,
  ): Promise<void> {
    return this._e2ee.handleOffer(fromUserId, encryptedKeyBase64, ivBase64);
  }

  /**
   * Handle a participant leaving the voice channel (key-holder election and
   * membership-forward-secrecy rekey). See E2EEManager.handleParticipantLeft.
   */
  async handleParticipantLeft(userId: number): Promise<void> {
    return this._e2ee.handleParticipantLeft(userId);
  }
}

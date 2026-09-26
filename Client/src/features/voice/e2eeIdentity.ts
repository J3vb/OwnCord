// Voice E2EE identity and key ownership — extracted from livekitE2EE.ts.
// Owns this client's long-term identity keypair (F3 TOFU: loaded from the OS
// keyring, cached per host+user scope, used to sign ephemeral announces) and
// holds the session's ephemeral ECDH keypair. E2EEManager decides when the
// ephemeral keypair is published or cleared; this module is where it lives.
import { signEphemeralKey } from "../../lib/e2eeCrypto";
import { getOrCreateIdentityKeyPair } from "../../lib/identity";
import { authStore } from "../../stores/auth.store";
import { createLogger } from "../../lib/logger";

// Same logger tag as before the extraction, so the E2EE log lines are unchanged.
const log = createLogger("livekitE2EE");

/** Decode a base64 raw-key string to bytes for sign/verify. Throws on bad
 *  input (callers verifying a peer key already run inside try/catch). */
export function rawFromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export interface E2EEIdentityDeps {
  getServerHost: () => string | null;
}

export class E2EEIdentity {
  /** Ephemeral ECDH P-256 keypair for the current voice session. */
  ecdhKeyPair: CryptoKeyPair | null = null;
  /** This client's long-term ECDSA identity keypair (F3 TOFU), used to sign our
   *  ephemeral announces. Loaded lazily from the OS keyring, cached per session. */
  private _identityKeyPair: CryptoKeyPair | null = null;
  private _identityScope: string | null = null;
  private _identityGeneration = 0;

  constructor(private readonly deps: E2EEIdentityDeps) {}

  /** Load (once per session) this client's long-term identity keypair from the
   *  OS keyring so we can sign ephemeral announces. Returns null when there is
   *  no server host (identity is host-scoped) OR no authenticated user id yet
   *  (identity is host+user scoped, B3-3) — the announce then goes out
   *  unsigned and peers treat us as a legacy/unverified client. A missing user
   *  id must never fall back to a placeholder scope like `?? 0`:
   *  `getOrCreateIdentityKeyPair` would mint (or migrate-and-DELETE the real
   *  legacy key into) a bogus `host:0` keyring account, and a later
   *  authenticated call would then mint a second, different keypair under
   *  `host:<realId>` — so the published key and the announce signing key
   *  permanently disagree and every peer's verifyPeerAnnounce reports a false
   *  MITM "mismatch" (see identity.ts's `identityKeyPairCache` doc). */
  private async ensureIdentityKeyPair(): Promise<CryptoKeyPair | null> {
    const host = this.deps.getServerHost();
    if (host === null) return null;
    const myUserId = authStore.getState().user?.id;
    if (myUserId === undefined) {
      log.warn(
        "E2EE: no authenticated user id yet — announcing unsigned instead of scoping under a placeholder id",
      );
      return null;
    }
    const scope = `${myUserId}@${host}`;
    if (this._identityKeyPair && this._identityScope === scope) return this._identityKeyPair;
    const generation = this._identityGeneration;
    const pair = await getOrCreateIdentityKeyPair(host, myUserId);
    if (
      generation !== this._identityGeneration ||
      host !== this.deps.getServerHost() ||
      myUserId !== authStore.getState().user?.id
    ) {
      return null;
    }
    this._identityKeyPair = pair;
    this._identityScope = scope;
    return pair;
  }

  /** Identity keys are host-scoped — the session drops the cached keypair when
   *  the host changes (and on cleanupAll) so we never sign an announce with
   *  another host's identity key. */
  clearIdentityKeyPair(): void {
    this._identityGeneration++;
    this._identityKeyPair = null;
    this._identityScope = null;
  }

  /** Build the voice_e2ee_announce payload, signing the ephemeral public key
   *  with our identity key (F3). Signing failures degrade to an unsigned
   *  announce rather than blocking the join. */
  async buildAnnouncePayload(
    ephemeralPubBase64: string,
  ): Promise<{ public_key: string; signature?: string }> {
    try {
      const idKeyPair = await this.ensureIdentityKeyPair();
      if (idKeyPair) {
        const myUserId = authStore.getState().user?.id ?? 0;
        const ephemeralRaw = rawFromBase64(ephemeralPubBase64);
        const signature = await signEphemeralKey(idKeyPair.privateKey, myUserId, ephemeralRaw);
        return { public_key: ephemeralPubBase64, signature };
      }
    } catch (err) {
      log.error("E2EE: failed to sign announce — sending unsigned", err);
    }
    return { public_key: ephemeralPubBase64 };
  }
}

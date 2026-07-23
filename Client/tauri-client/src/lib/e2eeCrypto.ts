/**
 * e2eeCrypto — Client-side ECDH key exchange and room key wrapping for true
 * end-to-end encrypted voice/video.
 *
 * The server NEVER sees the room key. It only relays:
 *   1. ECDH P-256 public keys (useless without the private key)
 *   2. AES-GCM encrypted room key blobs (can't decrypt without ECDH shared secret)
 *
 * Flow:
 *   - Each participant generates an ephemeral ECDH P-256 keypair on voice join.
 *   - The key holder (longest-present participant) generates a random 256-bit
 *     room key and wraps it for each peer using ECDH + HKDF + AES-GCM.
 *   - Peers unwrap the room key and feed it to LiveKit's ExternalE2EEKeyProvider.
 *   - When a participant leaves, the key holder rotates the room key.
 */

import { createLogger } from "@lib/logger";

const log = createLogger("e2eeCrypto");

// ── WebCrypto availability check ───────────────────────────────────────────
if (typeof crypto === "undefined" || !crypto.subtle) {
  throw new Error(
    "E2EE requires WebCrypto (crypto.subtle). Ensure the app is served over HTTPS or a secure context.",
  );
}

const ECDH_CURVE = "P-256";
// UTF-8 bytes of "owncord-voice-e2ee-v1"
const HKDF_SALT = new Uint8Array([
  111, 119, 110, 99, 111, 114, 100, 45, 118, 111, 105, 99, 101, 45, 101, 50, 101, 101, 45, 118, 49,
]);
// UTF-8 bytes of "room-key-wrap"
const HKDF_INFO = new Uint8Array([114, 111, 111, 109, 45, 107, 101, 121, 45, 119, 114, 97, 112]);
const ROOM_KEY_BYTES = 32; // 256-bit AES key for LiveKit SFrame

// ── Long-term identity keys (F3: voice E2EE TOFU) ──────────────────────────
// ECDSA P-256 (same curve family as the ECDH exchange; works in all three
// webviews — Ed25519 is unreliable on WKWebView/WebKitGTK; zero new deps).
const ECDSA_CURVE = "P-256";
// Domain-separation prefix signed with the identity key when announcing an
// ephemeral key: UTF-8 bytes of "owncord-voice-e2ee-announce-v1". Binding the
// prefix + userId stops the server re-attributing a valid announce to a
// different user or reusing the signature in another context.
const ANNOUNCE_DOMAIN = new TextEncoder().encode("owncord-voice-e2ee-announce-v1");

// ── Key pair generation ─────────────────────────────────────────────────────

/** Generate an ephemeral ECDH P-256 keypair. */
export async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: ECDH_CURVE }, true, ["deriveBits"]);
}

/** Export a CryptoKey (public) to base64 for transmission. */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return uint8ToBase64(new Uint8Array(raw));
}

/** Import a base64-encoded P-256 public key. */
export async function importPublicKey(base64: string): Promise<CryptoKey> {
  const raw = base64ToUint8(base64);
  return crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: ECDH_CURVE }, true, []);
}

// ── Key fingerprint (for out-of-band verification) ─────────────────────────

/**
 * Compute a human-readable fingerprint of a public key for out-of-band
 * verification (safety numbers). Returns a hex string of the SHA-256 hash
 * of the raw key bytes, formatted as "AB12 CD34 …" groups.
 *
 * For the F3 safety number, feed the *stable* identity public key (the ECDSA
 * key that persists across calls), NOT the per-call ephemeral ECDH key — the
 * fingerprint only makes sense out-of-band if it stays constant for a peer.
 * The raw-byte hash is algorithm-agnostic, so it works on either key type.
 */
export async function computeKeyFingerprint(publicKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", publicKey);
  const hash = await crypto.subtle.digest("SHA-256", raw);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join("");
  // Format as 8 groups of 4 hex chars: "AB12 CD34 EF56 ..."
  const groups = hex.match(/.{1,4}/g) ?? [];
  return groups.slice(0, 8).join(" ");
}

// ── Identity keypair (sign/verify ephemeral announces) ─────────────────────

/** Generate a long-term ECDSA P-256 identity keypair. */
export async function generateIdentityKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: ECDSA_CURVE }, true, [
    "sign",
    "verify",
  ]);
}

/**
 * Sign an ephemeral-key announce with the long-term identity private key.
 * The signed message is ANNOUNCE_DOMAIN ‖ myUserId ‖ ephemeralPubRaw, so a
 * receiver knows this exact ephemeral key was announced by this exact user.
 * Returns the base64 signature to carry in the `voice_e2ee_announce` payload.
 */
export async function signEphemeralKey(
  identityPrivateKey: CryptoKey,
  myUserId: string | number,
  ephemeralPubRaw: Uint8Array,
): Promise<string> {
  const message = buildAnnounceMessage(myUserId, ephemeralPubRaw);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identityPrivateKey,
    message,
  );
  return uint8ToBase64(new Uint8Array(sig));
}

/**
 * Verify an ephemeral-key announce against a peer's pinned identity public key.
 * Returns false (never throws) on any tamper — bad base64, wrong userId, wrong
 * ephemeral key, or wrong/forged signature — so callers can reject a MITM.
 */
export async function verifyEphemeralKeySignature(
  identityPublicKey: CryptoKey,
  userId: string | number,
  ephemeralPubRaw: Uint8Array,
  signatureBase64: string,
): Promise<boolean> {
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64ToUint8(signatureBase64);
  } catch {
    return false;
  }
  const message = buildAnnounceMessage(userId, ephemeralPubRaw);
  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      identityPublicKey,
      signature,
      message,
    );
  } catch {
    return false;
  }
}

/** Import a base64 raw P-256 identity public key for signature verification. */
export async function importIdentityPublicKey(base64: string): Promise<CryptoKey> {
  const raw = base64ToUint8(base64);
  return crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: ECDSA_CURVE }, true, [
    "verify",
  ]);
}

/**
 * Serialize an identity keypair for OS-keyring storage. Exports the private
 * key as JWK (base64-encoded JSON) — the JWK carries both the private scalar
 * `d` and the public point `x`/`y`, so both keys are recoverable on load.
 */
export async function exportIdentityKeyPair(privateKey: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  return btoa(JSON.stringify(jwk));
}

/** Inverse of exportIdentityKeyPair: recover both keys from the keyring blob. */
export async function importIdentityKeyPair(blobBase64: string): Promise<CryptoKeyPair> {
  const jwk = JSON.parse(atob(blobBase64)) as JsonWebKey;
  const alg = { name: "ECDSA", namedCurve: ECDSA_CURVE };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, alg, true, ["sign"]);
  // Strip the private scalar to import the matching public key.
  const pubJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const publicKey = await crypto.subtle.importKey("jwk", pubJwk, alg, true, ["verify"]);
  return { privateKey, publicKey };
}

/** Build the byte string signed/verified for an ephemeral-key announce. */
function buildAnnounceMessage(
  userId: string | number,
  ephemeralPubRaw: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const userIdBytes = new TextEncoder().encode(String(userId));
  const message = new Uint8Array(
    ANNOUNCE_DOMAIN.length + userIdBytes.length + ephemeralPubRaw.length,
  );
  message.set(ANNOUNCE_DOMAIN, 0);
  message.set(userIdBytes, ANNOUNCE_DOMAIN.length);
  message.set(ephemeralPubRaw, ANNOUNCE_DOMAIN.length + userIdBytes.length);
  return message;
}

// ── Room key generation ─────────────────────────────────────────────────────

/** Generate a random 256-bit room key. */
export function generateRoomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(ROOM_KEY_BYTES));
}

/** Encode a room key as base64 for ExternalE2EEKeyProvider.setKey(). */
export function roomKeyToBase64(key: Uint8Array): string {
  return uint8ToBase64(key);
}

// ── Room key wrapping (ECDH + HKDF + AES-GCM) ──────────────────────────────

/**
 * Wrap (encrypt) a room key for a specific peer.
 *
 * 1. ECDH(myPrivate, peerPublic) → raw shared secret
 * 2. HKDF-SHA256(shared, salt, info) → 256-bit AES wrapping key
 * 3. AES-GCM(wrappingKey, randomIV, roomKey) → ciphertext
 */
export async function wrapRoomKey(
  myPrivateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  roomKey: Uint8Array,
): Promise<{ encryptedKey: string; iv: string }> {
  const wrapKey = await deriveWrappingKey(myPrivateKey, peerPublicKey);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit GCM nonce

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrapKey,
    roomKey as Uint8Array<ArrayBuffer>,
  );

  return {
    encryptedKey: uint8ToBase64(new Uint8Array(ciphertext)),
    iv: uint8ToBase64(iv),
  };
}

/**
 * Unwrap (decrypt) a room key received from a peer.
 *
 * Same ECDH + HKDF derivation as wrapRoomKey, but on the receiver's side.
 */
export async function unwrapRoomKey(
  myPrivateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  encryptedKeyBase64: string,
  ivBase64: string,
): Promise<Uint8Array> {
  const wrapKey = await deriveWrappingKey(myPrivateKey, peerPublicKey);
  const iv = base64ToUint8(ivBase64);
  const ciphertext = base64ToUint8(encryptedKeyBase64);

  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, wrapKey, ciphertext);

  return new Uint8Array(plaintext);
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Derive a 256-bit AES-GCM wrapping key from an ECDH shared secret via HKDF.
 */
async function deriveWrappingKey(
  myPrivateKey: CryptoKey,
  peerPublicKey: CryptoKey,
): Promise<CryptoKey> {
  // Step 1: ECDH → raw shared secret bits
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    myPrivateKey,
    256,
  );

  // Step 2: Import shared secret as HKDF key material
  const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);

  // Step 3: HKDF → AES-GCM key
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: HKDF_INFO,
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ── Base64 utilities ────────────────────────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}

function base64ToUint8(base64: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error("E2EE: invalid base64 input");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

log.debug("e2eeCrypto module loaded");

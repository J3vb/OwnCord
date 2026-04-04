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

import { log } from "@lib/logger";

const ECDH_CURVE = "P-256";
const HKDF_SALT = new TextEncoder().encode("owncord-voice-e2ee-v1");
const HKDF_INFO = new TextEncoder().encode("room-key-wrap");
const ROOM_KEY_BYTES = 32; // 256-bit AES key for LiveKit SFrame

// ── Key pair generation ─────────────────────────────────────────────────────

/** Generate an ephemeral ECDH P-256 keypair. */
export async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: ECDH_CURVE }, true, [
    "deriveBits",
  ]) as Promise<CryptoKeyPair>;
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
    roomKey,
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

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    wrapKey,
    ciphertext,
  );

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
  const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, [
    "deriveKey",
  ]);

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
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

log.debug("e2eeCrypto module loaded");

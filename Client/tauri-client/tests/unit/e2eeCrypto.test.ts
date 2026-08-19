import { describe, it, expect, vi } from "vitest";
import {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  generateRoomKey,
  wrapRoomKey,
  unwrapRoomKey,
  computeKeyFingerprint,
  computeRawKeyFingerprint,
  roomKeyToBase64,
  generateIdentityKeyPair,
  signEphemeralKey,
  verifyEphemeralKeySignature,
  importIdentityPublicKey,
  exportIdentityKeyPair,
  importIdentityKeyPair,
} from "@lib/e2eeCrypto";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe("e2eeCrypto", () => {
  // ── wrap / unwrap round-trip ───────────────────────────────────────────────

  describe("wrapRoomKey / unwrapRoomKey", () => {
    it("round-trips a room key between two keypairs", async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();
      const roomKey = generateRoomKey();

      const { encryptedKey, iv } = await wrapRoomKey(alice.privateKey, bob.publicKey, roomKey, 1);
      const { roomKey: unwrapped, epoch } = await unwrapRoomKey(
        bob.privateKey,
        alice.publicKey,
        encryptedKey,
        iv,
      );

      expect(unwrapped).toEqual(roomKey);
      expect(epoch).toBe(1);
    });

    it("produces a different ciphertext each call (fresh IV)", async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();
      const roomKey = generateRoomKey();

      const first = await wrapRoomKey(alice.privateKey, bob.publicKey, roomKey, 1);
      const second = await wrapRoomKey(alice.privateKey, bob.publicKey, roomKey, 1);

      // The IVs should differ, making ciphertexts distinct
      expect(first.iv).not.toBe(second.iv);
    });
  });

  // ── tampered ciphertext rejected ──────────────────────────────────────────

  describe("unwrapRoomKey", () => {
    it("throws when the ciphertext has been tampered", async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();
      const roomKey = generateRoomKey();

      const { encryptedKey, iv } = await wrapRoomKey(alice.privateKey, bob.publicKey, roomKey, 1);

      // Decode, flip the first ciphertext byte (after the 9-byte header), re-encode
      const bytes = Uint8Array.from(atob(encryptedKey), (c) => c.charCodeAt(0));
      bytes[9] = bytes[9]! ^ 0xff;
      const tampered = btoa(String.fromCharCode(...bytes));

      await expect(unwrapRoomKey(bob.privateKey, alice.publicKey, tampered, iv)).rejects.toThrow();
    });
  });

  // ── epoch binding (OC-0001) ───────────────────────────────────────────────

  describe("offer epoch binding", () => {
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

    it("carries the epoch as a 0x01 version byte + u64 big-endian header", async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();
      const { encryptedKey } = await wrapRoomKey(
        alice.privateKey,
        bob.publicKey,
        generateRoomKey(),
        0x0102030405,
      );
      const bytes = fromB64(encryptedKey);
      expect(Array.from(bytes.subarray(0, 9))).toEqual([1, 0, 0, 0, 1, 2, 3, 4, 5]);
      // 32-byte key + 16-byte GCM tag after the header
      expect(bytes.byteLength).toBe(9 + 48);
    });

    it("rejects a blob whose epoch header was edited", async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();
      const { encryptedKey, iv } = await wrapRoomKey(
        alice.privateKey,
        bob.publicKey,
        generateRoomKey(),
        3,
      );
      const bytes = fromB64(encryptedKey);
      bytes[8] = 9; // epoch 3 -> 9, ciphertext untouched
      await expect(
        unwrapRoomKey(bob.privateKey, alice.publicKey, b64(bytes), iv),
      ).rejects.toThrow();
    });

    it("rejects an unknown format version byte", async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();
      const { encryptedKey, iv } = await wrapRoomKey(
        alice.privateKey,
        bob.publicKey,
        generateRoomKey(),
        3,
      );
      const bytes = fromB64(encryptedKey);
      bytes[0] = 2;
      await expect(
        unwrapRoomKey(bob.privateKey, alice.publicKey, b64(bytes), iv),
      ).rejects.toThrow();
    });

    it("rejects a decoded header epoch above Number.MAX_SAFE_INTEGER", async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();
      const { encryptedKey, iv } = await wrapRoomKey(
        alice.privateKey,
        bob.publicKey,
        generateRoomKey(),
        3,
      );
      const bytes = fromB64(encryptedKey);
      // Overwrite the u64 epoch (bytes 1-8) with 0xFFFFFFFFFFFFFFFF, well
      // above 2^53-1. The range check runs before decrypt, so the AAD
      // mismatch this also creates never gets a chance to fire.
      bytes.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 1);
      await expect(unwrapRoomKey(bob.privateKey, alice.publicKey, b64(bytes), iv)).rejects.toThrow(
        "E2EE: offer epoch out of range",
      );
    });

    it("rejects an epoch that is negative or not a safe integer", async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();
      await expect(
        wrapRoomKey(alice.privateKey, bob.publicKey, generateRoomKey(), -1),
      ).rejects.toThrow();
      await expect(
        wrapRoomKey(alice.privateKey, bob.publicKey, generateRoomKey(), 2 ** 53),
      ).rejects.toThrow();
    });

    it("still unwraps a legacy blob (no header, no additional data) and reports epoch null", async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();
      const roomKey = generateRoomKey();

      // Build the pre-epoch wire format by hand: ECDH -> HKDF(salt, info) ->
      // AES-GCM with no additional data, raw ciphertext in encrypted_key.
      const shared = await crypto.subtle.deriveBits(
        { name: "ECDH", public: bob.publicKey },
        alice.privateKey,
        256,
      );
      const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
      const wrapKey = await crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new TextEncoder().encode("owncord-voice-e2ee-v1"),
          info: new TextEncoder().encode("room-key-wrap"),
        },
        hkdf,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"],
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        wrapKey,
        roomKey as Uint8Array<ArrayBuffer>,
      );

      const result = await unwrapRoomKey(
        bob.privateKey,
        alice.publicKey,
        b64(new Uint8Array(ct)),
        b64(iv),
      );
      expect(result.roomKey).toEqual(roomKey);
      expect(result.epoch).toBeNull();
    });
  });

  // ── fingerprint stability ─────────────────────────────────────────────────

  describe("computeKeyFingerprint", () => {
    it("returns the same fingerprint for the same public key", async () => {
      const { publicKey } = await generateECDHKeyPair();

      const fp1 = await computeKeyFingerprint(publicKey);
      const fp2 = await computeKeyFingerprint(publicKey);

      expect(fp1).toBe(fp2);
    });

    it("returns different fingerprints for different keys", async () => {
      const { publicKey: keyA } = await generateECDHKeyPair();
      const { publicKey: keyB } = await generateECDHKeyPair();

      const fpA = await computeKeyFingerprint(keyA);
      const fpB = await computeKeyFingerprint(keyB);

      expect(fpA).not.toBe(fpB);
    });

    it("computeRawKeyFingerprint over the exported raw bytes matches computeKeyFingerprint", async () => {
      const { publicKey } = await generateECDHKeyPair();
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));

      expect(await computeRawKeyFingerprint(raw)).toBe(await computeKeyFingerprint(publicKey));
    });

    it("formats the fingerprint as 8 space-separated 4-char hex groups", async () => {
      const { publicKey } = await generateECDHKeyPair();
      const fp = await computeKeyFingerprint(publicKey);

      expect(fp).toMatch(/^([0-9A-F]{4} ){7}[0-9A-F]{4}$/);
    });
  });

  // ── exportPublicKey / importPublicKey round-trip ──────────────────────────

  describe("exportPublicKey / importPublicKey", () => {
    it("round-trips a public key through base64", async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();

      // Export Bob's public key and re-import it
      const exported = await exportPublicKey(bob.publicKey);
      expect(() => atob(exported)).not.toThrow();

      const reimported = await importPublicKey(exported);

      // The reimported key must produce the same fingerprint as the original
      const fpOriginal = await computeKeyFingerprint(bob.publicKey);
      const fpReimported = await computeKeyFingerprint(reimported);
      expect(fpOriginal).toBe(fpReimported);

      // The reimported key must be usable in a wrap/unwrap cycle
      const roomKey = generateRoomKey();
      const { encryptedKey, iv } = await wrapRoomKey(alice.privateKey, reimported, roomKey, 1);
      const { roomKey: unwrapped } = await unwrapRoomKey(
        bob.privateKey,
        alice.publicKey,
        encryptedKey,
        iv,
      );
      expect(unwrapped).toEqual(roomKey);
    });
  });

  // ── generateRoomKey entropy ───────────────────────────────────────────────

  describe("generateRoomKey", () => {
    it("returns a 32-byte Uint8Array", () => {
      const key = generateRoomKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.byteLength).toBe(32);
    });

    it("two calls return different keys", () => {
      const a = generateRoomKey();
      const b = generateRoomKey();
      // Compare as base64 strings for a simple deep-inequality check
      expect(roomKeyToBase64(a)).not.toBe(roomKeyToBase64(b));
    });
  });

  // ── roomKeyToBase64 ───────────────────────────────────────────────────────

  describe("roomKeyToBase64", () => {
    it("encodes a room key to a non-empty base64 string", () => {
      const key = generateRoomKey();
      const encoded = roomKeyToBase64(key);
      expect(typeof encoded).toBe("string");
      expect(encoded.length).toBeGreaterThan(0);
      expect(() => atob(encoded)).not.toThrow();
    });
  });

  // ── Identity sign / verify (F3 TOFU) ───────────────────────────────────────

  describe("signEphemeralKey / verifyEphemeralKeySignature", () => {
    const userId = 42;

    async function fixture() {
      const identity = await generateIdentityKeyPair();
      const ephemeral = await generateECDHKeyPair();
      const ephemeralRaw = new Uint8Array(
        await crypto.subtle.exportKey("raw", ephemeral.publicKey),
      );
      const signature = await signEphemeralKey(identity.privateKey, userId, ephemeralRaw);
      return { identity, ephemeralRaw, signature };
    }

    it("round-trips: a valid signature verifies against the identity public key", async () => {
      const { identity, ephemeralRaw, signature } = await fixture();
      const ok = await verifyEphemeralKeySignature(
        identity.publicKey,
        userId,
        ephemeralRaw,
        signature,
      );
      expect(ok).toBe(true);
    });

    it("verifies against a public key re-imported from its base64 raw form", async () => {
      const { identity, ephemeralRaw, signature } = await fixture();
      const pubBase64 = await exportPublicKey(identity.publicKey);
      const reimported = await importIdentityPublicKey(pubBase64);
      const ok = await verifyEphemeralKeySignature(reimported, userId, ephemeralRaw, signature);
      expect(ok).toBe(true);
    });

    it("fails when the userId is tampered (server re-attribution)", async () => {
      const { identity, ephemeralRaw, signature } = await fixture();
      const ok = await verifyEphemeralKeySignature(
        identity.publicKey,
        userId + 1,
        ephemeralRaw,
        signature,
      );
      expect(ok).toBe(false);
    });

    it("fails when the ephemeral key is substituted (server MITM)", async () => {
      const { identity, signature } = await fixture();
      const other = await generateECDHKeyPair();
      const otherRaw = new Uint8Array(await crypto.subtle.exportKey("raw", other.publicKey));
      const ok = await verifyEphemeralKeySignature(identity.publicKey, userId, otherRaw, signature);
      expect(ok).toBe(false);
    });

    it("fails when the signature bytes are tampered", async () => {
      const { identity, ephemeralRaw, signature } = await fixture();
      const bytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
      bytes[0] = bytes[0]! ^ 0xff;
      const tampered = btoa(String.fromCharCode(...bytes));
      const ok = await verifyEphemeralKeySignature(
        identity.publicKey,
        userId,
        ephemeralRaw,
        tampered,
      );
      expect(ok).toBe(false);
    });

    it("returns false (not throw) on malformed base64 signature", async () => {
      const { identity, ephemeralRaw } = await fixture();
      const ok = await verifyEphemeralKeySignature(
        identity.publicKey,
        userId,
        ephemeralRaw,
        "not valid base64 !!!",
      );
      expect(ok).toBe(false);
    });

    it("fails against a different identity key (wrong signer)", async () => {
      const { ephemeralRaw, signature } = await fixture();
      const attacker = await generateIdentityKeyPair();
      const ok = await verifyEphemeralKeySignature(
        attacker.publicKey,
        userId,
        ephemeralRaw,
        signature,
      );
      expect(ok).toBe(false);
    });
  });

  // ── Identity keypair persistence (keyring blob round-trip) ──────────────────

  describe("exportIdentityKeyPair / importIdentityKeyPair", () => {
    it("round-trips a keypair through the JWK blob and can still sign+verify", async () => {
      const original = await generateIdentityKeyPair();
      const blob = await exportIdentityKeyPair(original.privateKey);
      const restored = await importIdentityKeyPair(blob);

      const ephemeral = await generateECDHKeyPair();
      const ephemeralRaw = new Uint8Array(
        await crypto.subtle.exportKey("raw", ephemeral.publicKey),
      );

      // Sign with the restored private key, verify with the restored public key.
      const sig = await signEphemeralKey(restored.privateKey, 7, ephemeralRaw);
      expect(await verifyEphemeralKeySignature(restored.publicKey, 7, ephemeralRaw, sig)).toBe(
        true,
      );

      // Public key survives the round-trip identically (safety-number stability).
      const fpOriginal = await computeKeyFingerprint(original.publicKey);
      const fpRestored = await computeKeyFingerprint(restored.publicKey);
      expect(fpRestored).toBe(fpOriginal);
    });
  });

  // ── Identity fingerprint stability (safety number repoint) ──────────────────

  describe("computeKeyFingerprint on identity keys", () => {
    it("is stable across export/import of the identity public key", async () => {
      const identity = await generateIdentityKeyPair();
      const base64 = await exportPublicKey(identity.publicKey);
      const reimported = await importIdentityPublicKey(base64);
      expect(await computeKeyFingerprint(reimported)).toBe(
        await computeKeyFingerprint(identity.publicKey),
      );
    });
  });
});

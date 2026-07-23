import { describe, it, expect, vi } from "vitest";
import {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  generateRoomKey,
  wrapRoomKey,
  unwrapRoomKey,
  computeKeyFingerprint,
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

      const { encryptedKey, iv } = await wrapRoomKey(alice.privateKey, bob.publicKey, roomKey);
      const unwrapped = await unwrapRoomKey(bob.privateKey, alice.publicKey, encryptedKey, iv);

      expect(unwrapped).toEqual(roomKey);
    });

    it("produces a different ciphertext each call (fresh IV)", async () => {
      const alice = await generateECDHKeyPair();
      const bob = await generateECDHKeyPair();
      const roomKey = generateRoomKey();

      const first = await wrapRoomKey(alice.privateKey, bob.publicKey, roomKey);
      const second = await wrapRoomKey(alice.privateKey, bob.publicKey, roomKey);

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

      const { encryptedKey, iv } = await wrapRoomKey(alice.privateKey, bob.publicKey, roomKey);

      // Decode, flip the first byte, re-encode
      const bytes = Uint8Array.from(atob(encryptedKey), (c) => c.charCodeAt(0));
      bytes[0] = bytes[0]! ^ 0xff;
      const tampered = btoa(String.fromCharCode(...bytes));

      await expect(unwrapRoomKey(bob.privateKey, alice.publicKey, tampered, iv)).rejects.toThrow();
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
      const { encryptedKey, iv } = await wrapRoomKey(alice.privateKey, reimported, roomKey);
      const unwrapped = await unwrapRoomKey(bob.privateKey, alice.publicKey, encryptedKey, iv);
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

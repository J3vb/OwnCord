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
} from "@lib/e2eeCrypto";

vi.mock("@lib/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
      bytes[0] ^= 0xff;
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
});

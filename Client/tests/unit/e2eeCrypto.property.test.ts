/**
 * Property tests for room-key wrapping in e2eeCrypto.ts: every offer format
 * round-trips, an offer never unwraps under the wrong keys or the wrong
 * direction, and a damaged offer is rejected (a rejected promise, never a
 * throw and never a key).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import fc from "fast-check";
import * as logMock from "../helpers/loggerMock";

vi.mock("@lib/logger", () => logMock.loggerMock());

import {
  generateECDHKeyPair,
  importPublicKey,
  unwrapRoomKey,
  wrapRoomKey,
  type OfferBinding,
} from "@lib/net/e2eeCrypto";
import type { KeyPlacement } from "@lib/net/keyPlacement";

const PROPERTY_TIMEOUT_MS = 30_000;
const RUNS = 50;

const roomKeyArb = fc.uint8Array({ minLength: 32, maxLength: 32 });
const epochArb = fc.oneof(fc.nat(1_000), fc.maxSafeNat());
const placementArb = fc.option(
  fc.record({ slot: fc.constantFrom<0 | 1>(0, 1), stage: fc.boolean() }),
  { nil: undefined },
);
const userIdArb = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const bindingArb = fc.option(fc.record({ senderId: userIdArb, recipientId: userIdArb }), {
  nil: undefined,
});

function toBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}

/** Settles `run` and reports whether it rejected; a synchronous throw fails the test. */
async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  let pending: Promise<unknown>;
  expect(() => {
    pending = run();
  }).not.toThrow();
  return pending!.then(
    () => false,
    () => true,
  );
}

describe("e2eeCrypto room-key properties", () => {
  let alice: CryptoKeyPair;
  let bob: CryptoKeyPair;
  let eve: CryptoKeyPair;

  beforeAll(async () => {
    [alice, bob, eve] = await Promise.all([
      generateECDHKeyPair(),
      generateECDHKeyPair(),
      generateECDHKeyPair(),
    ]);
  });

  function wrap(
    key: Uint8Array,
    epoch: number,
    placement: KeyPlacement | undefined,
    binding: OfferBinding | undefined,
  ) {
    return wrapRoomKey(alice.privateKey, bob.publicKey, key, epoch, placement, binding);
  }

  it(
    "round-trips the key, epoch and placement of every offer format",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          roomKeyArb,
          epochArb,
          placementArb,
          bindingArb,
          async (key, epoch, placement, binding) => {
            const offer = await wrap(key, epoch, placement, binding);
            const out = await unwrapRoomKey(
              bob.privateKey,
              alice.publicKey,
              offer.encryptedKey,
              offer.iv,
              binding,
            );
            expect(out.roomKey).toEqual(key);
            expect(out.epoch).toBe(epoch);
            expect(out.placement).toEqual(
              binding !== undefined ? (placement ?? { slot: 0, stage: false }) : placement,
            );
          },
        ),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    "never unwraps under another party's key or the other direction",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          roomKeyArb,
          epochArb,
          placementArb,
          fc.record({ senderId: userIdArb, recipientId: userIdArb }),
          async (key, epoch, placement, binding) => {
            const offer = await wrap(key, epoch, placement, binding);
            const { encryptedKey, iv } = offer;
            expect(
              await rejects(() =>
                unwrapRoomKey(eve.privateKey, alice.publicKey, encryptedKey, iv, binding),
              ),
            ).toBe(true);
            expect(
              await rejects(() =>
                unwrapRoomKey(bob.privateKey, eve.publicKey, encryptedKey, iv, binding),
              ),
            ).toBe(true);
            expect(
              await rejects(() => unwrapRoomKey(bob.privateKey, alice.publicKey, encryptedKey, iv)),
            ).toBe(true);
            if (binding.senderId !== binding.recipientId) {
              const reversed = { senderId: binding.recipientId, recipientId: binding.senderId };
              expect(
                await rejects(() =>
                  unwrapRoomKey(bob.privateKey, alice.publicKey, encryptedKey, iv, reversed),
                ),
              ).toBe(true);
            }
          },
        ),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    "rejects a truncated, extended or bit-flipped offer",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          roomKeyArb,
          epochArb,
          placementArb,
          bindingArb,
          fc.nat(),
          fc.integer({ min: 0, max: 7 }),
          fc.constantFrom("truncate", "extend", "flip", "flip-iv"),
          async (key, epoch, placement, binding, at, bit, damage) => {
            const offer = await wrap(key, epoch, placement, binding);
            const blob = toBytes(offer.encryptedKey);
            const iv = toBytes(offer.iv);
            let badBlob = blob;
            let badIv = iv;
            if (damage === "truncate") badBlob = blob.slice(0, at % blob.length);
            if (damage === "extend") badBlob = Uint8Array.of(...blob, at % 256);
            if (damage === "flip") {
              badBlob = blob.slice();
              badBlob[at % blob.length]! ^= 1 << bit;
            }
            if (damage === "flip-iv") {
              badIv = iv.slice();
              badIv[at % iv.length]! ^= 1 << bit;
            }
            expect(
              await rejects(() =>
                unwrapRoomKey(
                  bob.privateKey,
                  alice.publicKey,
                  toBase64(badBlob),
                  toBase64(badIv),
                  binding,
                ),
              ),
            ).toBe(true);
          },
        ),
        { numRuns: RUNS * 2 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    "rejects arbitrary offer and key text without throwing",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(fc.string(), fc.uint8Array({ maxLength: 80, size: "max" }).map(toBase64)),
          fc.oneof(fc.string(), fc.uint8Array({ maxLength: 16, size: "max" }).map(toBase64)),
          fc.option(fc.record({ senderId: fc.integer(), recipientId: fc.integer() }), {
            nil: undefined,
          }),
          async (encryptedKey, iv, binding) => {
            expect(
              await rejects(() =>
                unwrapRoomKey(bob.privateKey, alice.publicKey, encryptedKey, iv, binding),
              ),
            ).toBe(true);
          },
        ),
        { numRuns: RUNS * 4 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    "rejects a public key that is not base64 of a P-256 point, without throwing",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Random bytes can form a valid compressed point, so only the text half is fuzzed.
          fc.string({ maxLength: 120, size: "max" }),
          async (text) => {
            expect(await rejects(() => importPublicKey(text))).toBe(true);
          },
        ),
        { numRuns: RUNS * 4 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});

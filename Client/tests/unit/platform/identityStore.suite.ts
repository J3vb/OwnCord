// Behaviour suite for the `IdentityStore` contract
// (`src/platform/contracts/identityStore.ts`). Run now against the legacy
// binding (`identityStore.legacy.test.ts`, today's `lib/identity.ts`
// exports) and again in B7-4 against `platform/desktop`.
import { beforeEach, describe, expect, test } from "vitest";
import type { IdentityStore } from "../../../src/platform/contracts/identityStore";

export interface NativeControl {
  succeedWith(value: unknown): void;
  failWith(error: unknown): void;
  unavailable(): void;
}

export interface IdentityStoreSubject {
  readonly subject: IdentityStore;
  readonly native: NativeControl;
}

export function describeIdentityStoreSuite(
  makeSubject: () => Promise<IdentityStoreSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("IdentityStore", () => {
    let ctx: IdentityStoreSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    describe("saveKey", () => {
      check("resolves true when the native store accepts the key", async () => {
        ctx.native.succeedWith(undefined);
        await expect(ctx.subject.saveKey("host", "blob")).resolves.toBe(true);
      });

      check("resolves false, not a rejection, when the native store errors", async () => {
        ctx.native.failWith(new Error("keyring locked"));
        await expect(ctx.subject.saveKey("host", "blob")).resolves.toBe(false);
      });

      check("resolves false when the native host is unavailable", async () => {
        ctx.native.unavailable();
        await expect(ctx.subject.saveKey("host", "blob")).resolves.toBe(false);
      });
    });

    describe("loadKey", () => {
      check("resolves the stored key blob", async () => {
        ctx.native.succeedWith("blob");
        await expect(ctx.subject.loadKey("host")).resolves.toBe("blob");
      });

      check("resolves null when nothing is stored", async () => {
        ctx.native.succeedWith(null);
        await expect(ctx.subject.loadKey("host")).resolves.toBeNull();
      });

      // Pinned as-is (B7-3): a store-read error is rethrown, never collapsed
      // into "nothing stored" — callers rely on that distinction.
      check("rejects when the native store errors", async () => {
        ctx.native.failWith(new Error("keyring locked"));
        await expect(ctx.subject.loadKey("host")).rejects.toThrow();
      });

      check("resolves null when the native host is unavailable", async () => {
        ctx.native.unavailable();
        await expect(ctx.subject.loadKey("host")).resolves.toBeNull();
      });
    });

    describe("deleteKey", () => {
      check("resolves true when the native store accepts the deletion", async () => {
        ctx.native.succeedWith(undefined);
        await expect(ctx.subject.deleteKey("host")).resolves.toBe(true);
      });

      check("resolves false, not a rejection, when the native store errors", async () => {
        ctx.native.failWith(new Error("keyring locked"));
        await expect(ctx.subject.deleteKey("host")).resolves.toBe(false);
      });

      check("resolves false when the native host is unavailable", async () => {
        ctx.native.unavailable();
        await expect(ctx.subject.deleteKey("host")).resolves.toBe(false);
      });
    });

    describe("storePin", () => {
      check('resolves "stored" when the native store accepts the pin', async () => {
        ctx.native.succeedWith(undefined);
        await expect(ctx.subject.storePin("host", "1", "pin")).resolves.toBe("stored");
      });

      check('resolves "failed" when the native store errors', async () => {
        ctx.native.failWith(new Error("disk full"));
        await expect(ctx.subject.storePin("host", "1", "pin")).resolves.toBe("failed");
      });

      check('resolves "no-store" when the native host is unavailable', async () => {
        ctx.native.unavailable();
        await expect(ctx.subject.storePin("host", "1", "pin")).resolves.toBe("no-store");
      });
    });

    describe("getPin", () => {
      check('resolves { status: "pinned" } when a pin is stored', async () => {
        ctx.native.succeedWith("pin-value");
        await expect(ctx.subject.getPin("host", "1")).resolves.toEqual({
          status: "pinned",
          pin: "pin-value",
        });
      });

      check('resolves { status: "unpinned" } when nothing is stored', async () => {
        ctx.native.succeedWith(null);
        await expect(ctx.subject.getPin("host", "1")).resolves.toEqual({ status: "unpinned" });
      });

      // Pinned as-is (B7-3): a read error must never present as "unpinned"
      // — that would silently re-trust a peer's rotated key (TOFU).
      check('resolves { status: "unavailable" } when the native store errors', async () => {
        ctx.native.failWith(new Error("keyring locked"));
        await expect(ctx.subject.getPin("host", "1")).resolves.toEqual({ status: "unavailable" });
      });

      check('resolves { status: "unpinned" } when the native host is unavailable', async () => {
        ctx.native.unavailable();
        await expect(ctx.subject.getPin("host", "1")).resolves.toEqual({ status: "unpinned" });
      });
    });
  });
}

// Behaviour suite for the `CredentialStore` contract
// (`src/platform/contracts/credentials.ts`). Run now against the legacy
// binding (`credentials.legacy.test.ts`, today's `lib/credentials.ts`
// exports) and again in B7-4 against `platform/desktop` — a green run
// before and after that move is the evidence the move changed nothing.
//
// Asserts only what the CALLER receives: no command name, no invoke
// argument shape. That wiring already has its own coverage in
// `tests/unit/credentials*.test.ts`.
import { beforeEach, describe, expect, it } from "vitest";
import type { CredentialStore } from "../../../src/platform/contracts/credentials";

/** A small control handle the legacy/desktop binding supplies so the suite
 *  never has to know how "the native call resolves/rejects/is unavailable"
 *  is actually wired for that binding. */
export interface NativeControl {
  succeedWith(value: unknown): void;
  failWith(error: unknown): void;
  unavailable(): void;
}

export interface CredentialStoreSubject {
  readonly subject: CredentialStore;
  readonly native: NativeControl;
}

export function describeCredentialStoreSuite(
  makeSubject: () => Promise<CredentialStoreSubject>,
): void {
  describe("CredentialStore", () => {
    let ctx: CredentialStoreSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    describe("save", () => {
      it("resolves true when the native store accepts the credential", async () => {
        ctx.native.succeedWith(undefined);
        await expect(ctx.subject.save("host", "alice", "tok")).resolves.toBe(true);
      });

      // Pinned as-is (B7-3): a failed native write resolves false rather
      // than rejecting — the caller has no way to see the underlying error.
      it("resolves false, not a rejection, when the native store errors", async () => {
        ctx.native.failWith(new Error("keychain locked"));
        await expect(ctx.subject.save("host", "alice", "tok")).resolves.toBe(false);
      });

      it("resolves false when the native host is unavailable", async () => {
        ctx.native.unavailable();
        await expect(ctx.subject.save("host", "alice", "tok")).resolves.toBe(false);
      });
    });

    describe("load", () => {
      it("resolves the stored credential, mapping has_password to hasPassword", async () => {
        ctx.native.succeedWith({ username: "alice", token: "tok", has_password: true });
        await expect(ctx.subject.load("host")).resolves.toEqual({
          username: "alice",
          token: "tok",
          hasPassword: true,
        });
      });

      it("resolves null when nothing is stored (a malformed/empty result)", async () => {
        ctx.native.succeedWith(null);
        await expect(ctx.subject.load("host")).resolves.toBeNull();
      });

      // Pinned as-is (B7-3): a store-read failure is a real, unreadable
      // store — rethrown, not collapsed into "nothing stored".
      it("rejects when the native store errors", async () => {
        ctx.native.failWith(new Error("keychain locked"));
        await expect(ctx.subject.load("host")).rejects.toThrow();
      });

      it("resolves null when the native host is unavailable", async () => {
        ctx.native.unavailable();
        await expect(ctx.subject.load("host")).resolves.toBeNull();
      });
    });

    describe("delete", () => {
      it("resolves true when the native store accepts the deletion", async () => {
        ctx.native.succeedWith(undefined);
        await expect(ctx.subject.delete("host")).resolves.toBe(true);
      });

      it("resolves false, not a rejection, when the native store errors", async () => {
        ctx.native.failWith(new Error("keychain locked"));
        await expect(ctx.subject.delete("host")).resolves.toBe(false);
      });

      it("resolves false when the native host is unavailable", async () => {
        ctx.native.unavailable();
        await expect(ctx.subject.delete("host")).resolves.toBe(false);
      });
    });

    describe("loginWithSavedPassword", () => {
      it("resolves the relayed status and body on success", async () => {
        ctx.native.succeedWith({ status: 200, body: '{"token":"tok"}' });
        await expect(ctx.subject.loginWithSavedPassword("host", "alice")).resolves.toEqual({
          status: 200,
          body: '{"token":"tok"}',
        });
      });

      it("resolves null when the result has an unexpected shape", async () => {
        ctx.native.succeedWith({ nonsense: true });
        await expect(ctx.subject.loginWithSavedPassword("host", "alice")).resolves.toBeNull();
      });

      it("rejects when the native command errors", async () => {
        ctx.native.failWith(new Error("no saved password"));
        await expect(ctx.subject.loginWithSavedPassword("host", "alice")).rejects.toThrow();
      });

      it("resolves null when the native host is unavailable", async () => {
        ctx.native.unavailable();
        await expect(ctx.subject.loginWithSavedPassword("host", "alice")).resolves.toBeNull();
      });
    });
  });
}

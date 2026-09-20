// Behaviour suite for the `PendingMessageStore` contract
// (`src/platform/contracts/pendingMessages.ts`). Run now against the legacy
// binding (`pendingMessages.legacy.test.ts`, today's `lib/pendingMessages.ts`
// exports) and again in B7-4 against `platform/desktop` — a green run before
// and after that move is the evidence the move changed nothing.
//
// Asserts only what the CALLER receives: no command name, no invoke
// argument shape. The one exception is `save`/`delete`'s success path, whose
// only caller-visible effect at this seam is what the native store received
// (the same reason `logFiles.suite.ts` observes `written()`); the argument
// *shape* is never asserted, only the owner/value round trip.
import { beforeEach, describe, expect, test } from "vitest";
import type { PendingMessageStore } from "../../../src/platform/contracts/pendingMessages";
import type { PendingMessageOwner } from "../../../src/platform/contracts/pendingMessages";

/** A small control handle the legacy/desktop binding supplies so the suite
 *  never has to know how "the native call resolves/rejects/is unavailable"
 *  is actually wired for that binding. */
export interface NativeControl {
  /** The native store answers a read with this value. */
  loadReturns(value: string | null): void;
  /** Every native call rejects with this error. */
  failWith(error: unknown): void;
  /** The native host is not there at all — the environment guard says no. */
  unavailable(): void;
  /** The owner/value pairs the native store has actually been handed to
   *  persist, in call order. */
  saved(): readonly { owner: PendingMessageOwner; value: string }[];
  /** The owners the native store has actually been asked to forget. */
  deleted(): readonly PendingMessageOwner[];
}

export interface PendingMessagesSubject {
  readonly subject: PendingMessageStore;
  readonly native: NativeControl;
}

const owner: PendingMessageOwner = { host: "chat.example:55000", userId: 7 };
const otherOwner: PendingMessageOwner = { host: "chat.example:55000", userId: 8 };
const stored = '[{"clientMessageId":"1758355200000:3f2a1e4c-5b6d-4f80-9a1b-2c3d4e5f6071"}]';

export function describePendingMessagesSuite(
  makeSubject: () => Promise<PendingMessagesSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("PendingMessageStore", () => {
    let ctx: PendingMessagesSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    describe("load", () => {
      check("resolves the stored serialized drafts for the owner", async () => {
        ctx.native.loadReturns(stored);
        await expect(ctx.subject.load(owner)).resolves.toBe(stored);
      });

      check("resolves null when nothing is stored for the owner", async () => {
        ctx.native.loadReturns(null);
        await expect(ctx.subject.load(owner)).resolves.toBeNull();
      });

      // Pinned as-is (B7-4): a store-read failure is a real, unreadable store
      // — rethrown, not collapsed into "nothing stored".
      check("rejects when the native store errors", async () => {
        ctx.native.failWith(new Error("credential store locked"));
        await expect(ctx.subject.load(owner)).rejects.toThrow();
      });

      // The SDK environment guard, which moves into the desktop
      // implementation in B7-4: no native host means "nothing stored" — and
      // the store must not be reached at all. The contrasting read on a
      // present host is what proves the store is reachable in the first
      // place; "nothing was written" alone is what an inert subject does.
      check("resolves null off the native host, without reaching the store", async () => {
        ctx.native.loadReturns(stored);
        await expect(ctx.subject.load(owner)).resolves.toBe(stored);
        ctx.native.unavailable();
        await expect(ctx.subject.load(owner)).resolves.toBeNull();
        expect(ctx.native.saved()).toEqual([]);
      });
    });

    describe("save", () => {
      check("hands the owner and the serialized drafts to the native store", async () => {
        await ctx.subject.save(owner, stored);
        expect(ctx.native.saved()).toEqual([{ owner, value: stored }]);
      });

      check("keys what it stores by the owner it was given", async () => {
        await ctx.subject.save(owner, stored);
        await ctx.subject.save(otherOwner, stored);
        expect(ctx.native.saved().map((entry) => entry.owner)).toEqual([owner, otherOwner]);
      });

      check("rejects when the native store errors", async () => {
        ctx.native.failWith(new Error("credential store locked"));
        await expect(ctx.subject.save(owner, stored)).rejects.toThrow();
      });

      // Off the native host the draft stays in memory: the call resolves and
      // the store is never written to — proven against a write that landed,
      // not against silence.
      check("resolves off the native host, without reaching the store", async () => {
        await ctx.subject.save(owner, stored);
        expect(ctx.native.saved()).toHaveLength(1);
        ctx.native.unavailable();
        await expect(ctx.subject.save(owner, stored)).resolves.toBeUndefined();
        expect(ctx.native.saved()).toHaveLength(1);
      });
    });

    describe("delete", () => {
      check("asks the native store to forget the owner", async () => {
        await ctx.subject.delete(owner);
        expect(ctx.native.deleted()).toEqual([owner]);
      });

      check("rejects when the native store errors", async () => {
        ctx.native.failWith(new Error("credential store locked"));
        await expect(ctx.subject.delete(owner)).rejects.toThrow();
      });

      check("resolves off the native host, without reaching the store", async () => {
        await ctx.subject.delete(owner);
        expect(ctx.native.deleted()).toHaveLength(1);
        ctx.native.unavailable();
        await expect(ctx.subject.delete(owner)).resolves.toBeUndefined();
        expect(ctx.native.deleted()).toHaveLength(1);
      });
    });
  });
}

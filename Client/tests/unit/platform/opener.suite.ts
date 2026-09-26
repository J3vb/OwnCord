// Behaviour suite for the `UrlOpener` contract
// (`src/platform/contracts/opener.ts`). Written in B7-5 against the in-place
// seam in `lib/admin-panel.ts` before the move, so it pins today's behaviour
// rather than the moved code's.
import { beforeEach, describe, expect, test } from "vitest";
import type { UrlOpener } from "../../../src/platform/contracts/opener";

export interface NativeControl {
  failWith(error: unknown): void;
  /** URLs the native shell was asked to open. */
  opened(): readonly string[];
}

export interface UrlOpenerSubject {
  readonly subject: UrlOpener;
  readonly native: NativeControl;
}

export function describeUrlOpenerSuite(
  makeSubject: () => Promise<UrlOpenerSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("UrlOpener", () => {
    let ctx: UrlOpenerSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("hands the URL to the native shell unchanged", async () => {
      await ctx.subject.open("https://chat.example/admin#audit");
      expect(ctx.native.opened()).toEqual(["https://chat.example/admin#audit"]);
    });

    check("rejects when the native shell cannot open it", async () => {
      ctx.native.failWith(new Error("no handler"));
      await expect(ctx.subject.open("https://chat.example")).rejects.toThrow("no handler");
    });
  });
}

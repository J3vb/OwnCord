// Behaviour suite for the `DevTools` contract
// (`src/platform/contracts/devTools.ts`). Written in B7-5 against the
// in-place seam in `settings/AdvancedTab.ts` before the move, so it pins
// today's behaviour rather than the moved code's.
import { beforeEach, describe, expect, test } from "vitest";
import type { DevTools } from "../../../src/platform/contracts/devTools";

export interface NativeControl {
  failWith(error: unknown): void;
  /** How many times the native host was asked to open the dev tools. */
  opened(): number;
}

export interface DevToolsSubject {
  readonly subject: DevTools;
  readonly native: NativeControl;
}

export function describeDevToolsSuite(
  makeSubject: () => Promise<DevToolsSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("DevTools", () => {
    let ctx: DevToolsSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("asks the native host to open the dev tools once per call", async () => {
      await ctx.subject.open();
      expect(ctx.native.opened()).toBe(1);
    });

    // The Advanced tab logs "DevTools not available" on a rejection.
    check("rejects when the native host refuses", async () => {
      ctx.native.failWith(new Error("devtools disabled"));
      await expect(ctx.subject.open()).rejects.toThrow("devtools disabled");
    });
  });
}

// Behaviour suite for the `AppProcess` contract
// (`src/platform/contracts/appProcess.ts`). Written in B7-5 against the
// in-place seam in `settings/AdvancedTab.ts` before the move, so it pins
// today's behaviour rather than the moved code's.
import { beforeEach, describe, expect, test } from "vitest";
import type { AppProcess } from "../../../src/platform/contracts/appProcess";

export interface NativeControl {
  failWith(error: unknown): void;
  /** How many times the native host was asked to relaunch the app. */
  relaunches(): number;
}

export interface AppProcessSubject {
  readonly subject: AppProcess;
  readonly native: NativeControl;
}

export function describeAppProcessSuite(
  makeSubject: () => Promise<AppProcessSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("AppProcess", () => {
    let ctx: AppProcessSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("asks the native host to relaunch the app", async () => {
      await ctx.subject.relaunch();
      expect(ctx.native.relaunches()).toBe(1);
    });

    // "Clear & Restart" shows "Failed" on a rejection.
    check("rejects when the relaunch fails", async () => {
      ctx.native.failWith(new Error("relaunch failed"));
      await expect(ctx.subject.relaunch()).rejects.toThrow("relaunch failed");
    });
  });
}

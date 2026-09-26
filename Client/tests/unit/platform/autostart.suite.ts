// Behaviour suite for the `Autostart` half of the `updater.ts` contract
// (`src/platform/contracts/updater.ts`). Written in B7-5 against the in-place
// seam in `settings/AdvancedTab.ts` before the move, so it pins today's
// behaviour rather than the moved code's. The toggle's read-back race guard
// (OC-0141) is behaviour and stays in the tab, covered by
// `tests/unit/advanced-tab.test.ts`.
import { beforeEach, describe, expect, test } from "vitest";
import type { Autostart } from "../../../src/platform/contracts/updater";

export interface NativeControl {
  /** The OS launch-on-login state the native plugin reports. */
  enabledIs(value: boolean): void;
  failWith(error: unknown): void;
  /** The OS state after the subject's writes. */
  state(): boolean;
}

export interface AutostartSubject {
  readonly subject: Autostart;
  readonly native: NativeControl;
}

export function describeAutostartSuite(
  makeSubject: () => Promise<AutostartSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("Autostart", () => {
    let ctx: AutostartSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("reports the OS launch-on-login state", async () => {
      ctx.native.enabledIs(true);
      await expect(ctx.subject.isEnabled()).resolves.toBe(true);
      ctx.native.enabledIs(false);
      await expect(ctx.subject.isEnabled()).resolves.toBe(false);
    });

    check("enables and disables launch on login", async () => {
      ctx.native.enabledIs(false);
      await ctx.subject.enable();
      expect(ctx.native.state()).toBe(true);
      await ctx.subject.disable();
      expect(ctx.native.state()).toBe(false);
    });

    // The tab reverts its toggle on a rejection, so a failed OS write must
    // reject rather than resolve as if it had taken.
    check("rejects when the OS change does not take", async () => {
      ctx.native.failWith(new Error("permission denied"));
      await expect(ctx.subject.enable()).rejects.toThrow("permission denied");
    });

    // The tab removes the row when the read-back rejects.
    check("rejects the read-back when the native plugin is unavailable", async () => {
      ctx.native.failWith(new Error("not running under the native host"));
      await expect(ctx.subject.isEnabled()).rejects.toThrow();
    });
  });
}

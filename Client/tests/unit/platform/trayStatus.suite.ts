// Behaviour suite for the `TrayStatus` contract
// (`src/platform/contracts/trayStatus.ts`), added in B7-5. There is no legacy
// binding: the subscription was inline in `main.ts`, an entry module with
// side effects that cannot be imported on its own. What `main.ts` does with a
// pick stays pinned by `tests/unit/main.test.ts` (OC-0037, OC-0176), which
// drives the same native event before and after the move.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TrayStatus } from "../../../src/platform/contracts/trayStatus";

export interface NativeControl {
  /** The tray emits a status pick. Resolves once it has been delivered. */
  emits(status: string): Promise<void>;
}

export interface TrayStatusSubject {
  readonly subject: TrayStatus;
  readonly native: NativeControl;
}

export function describeTrayStatusSuite(
  makeSubject: () => Promise<TrayStatusSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("TrayStatus", () => {
    let ctx: TrayStatusSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("hands each pick to the handler exactly as the tray sent it", async () => {
      const handler = vi.fn();
      ctx.subject.onStatusChange(handler);
      await ctx.native.emits("dnd");
      await ctx.native.emits("offline");
      expect(handler.mock.calls).toEqual([["dnd"], ["offline"]]);
    });

    // Paired with a delivery first: "nothing arrives after unsubscribing" is
    // also what a subject that never delivers anything does.
    check("stops delivering once unsubscribed", async () => {
      const handler = vi.fn();
      const unsubscribe = ctx.subject.onStatusChange(handler);
      await ctx.native.emits("idle");
      unsubscribe();
      await ctx.native.emits("online");
      expect(handler.mock.calls).toEqual([["idle"]]);
    });
  });
}

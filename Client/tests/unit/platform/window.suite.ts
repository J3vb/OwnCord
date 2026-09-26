// Behaviour suite for the `WindowControl` contract
// (`src/platform/contracts/window.ts`). Written in B7-5 against the in-place
// seam in `lib/window-state.ts` before the move, so it pins today's behaviour
// rather than the moved code's. The seam is the window operations, not
// `initWindowState` — the off-screen guard is behaviour and stays in
// `lib/window-state.ts`, covered by `tests/unit/window-state-restore.test.ts`.
import { beforeEach, describe, expect, test } from "vitest";
import type { MonitorRect, WindowControl } from "../../../src/platform/contracts/window";

export interface NativeControl {
  maximized(value: boolean): void;
  monitors(value: readonly MonitorRect[]): void;
  monitorsFailWith(error: unknown): void;
  placedAt(position: { x: number; y: number }, size: { width: number; height: number }): void;
  /** How many times the window was centered. */
  centered(): number;
}

export interface WindowControlSubject {
  readonly subject: WindowControl;
  readonly native: NativeControl;
}

const PRIMARY: MonitorRect = { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } };

export function describeWindowControlSuite(
  makeSubject: () => Promise<WindowControlSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("WindowControl", () => {
    let ctx: WindowControlSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("reports whether the window is maximized", async () => {
      ctx.native.maximized(true);
      await expect(ctx.subject.isMaximized()).resolves.toBe(true);
      ctx.native.maximized(false);
      await expect(ctx.subject.isMaximized()).resolves.toBe(false);
    });

    check("resolves the connected monitors", async () => {
      ctx.native.monitors([PRIMARY]);
      await expect(ctx.subject.availableMonitors()).resolves.toEqual([PRIMARY]);
    });

    check("rejects when the monitors cannot be queried", async () => {
      ctx.native.monitorsFailWith(new Error("no display"));
      await expect(ctx.subject.availableMonitors()).rejects.toThrow("no display");
    });

    check("resolves the window's outer position and size", async () => {
      ctx.native.placedAt({ x: -40, y: 120 }, { width: 1280, height: 720 });
      await expect(ctx.subject.outerPosition()).resolves.toEqual({ x: -40, y: 120 });
      await expect(ctx.subject.outerSize()).resolves.toEqual({ width: 1280, height: 720 });
    });

    check("centers the window", async () => {
      await ctx.subject.center();
      expect(ctx.native.centered()).toBe(1);
    });
  });
}

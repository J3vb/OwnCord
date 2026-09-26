// Behaviour suite for the `Notifier` contract
// (`src/platform/contracts/notifications.ts`). Written in B7-5 against the
// in-place seam in `lib/notifications.ts` before the move, so it pins today's
// behaviour rather than the moved code's. Which notification fires, and the
// Web Notification fallback, are the caller's — `tests/unit/notifications.test.ts`
// covers those.
import { beforeEach, describe, expect, test } from "vitest";
import type { Notifier } from "../../../src/platform/contracts/notifications";

export interface NativeControl {
  /** The permission the native plugin reports as already held. */
  permissionIs(granted: boolean): void;
  /** What the user answers when the native plugin asks. */
  userAnswers(answer: "granted" | "denied"): void;
  /** The native plugin cannot be reached at all. */
  unavailable(): void;
  /** Notifications the native plugin was asked to show. */
  shown(): ReadonlyArray<{ title: string; body: string }>;
  /** How many times the window asked for the user's attention. */
  attentionRequests(): number;
}

export interface NotifierSubject {
  readonly subject: Notifier;
  readonly native: NativeControl;
}

export function describeNotifierSuite(
  makeSubject: () => Promise<NotifierSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("Notifier", () => {
    let ctx: NotifierSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("reports whether permission is already held", async () => {
      ctx.native.permissionIs(true);
      await expect(ctx.subject.permissionGranted()).resolves.toBe(true);
      ctx.native.permissionIs(false);
      await expect(ctx.subject.permissionGranted()).resolves.toBe(false);
    });

    check("resolves the user's answer to a permission request", async () => {
      ctx.native.userAnswers("granted");
      await expect(ctx.subject.requestPermission()).resolves.toBe(true);
      ctx.native.userAnswers("denied");
      await expect(ctx.subject.requestPermission()).resolves.toBe(false);
    });

    // The caller falls back to the Web Notification API on a rejection, so
    // an unreachable plugin must reject rather than report "not granted".
    check("rejects the permission check when the native plugin is unavailable", async () => {
      ctx.native.unavailable();
      await expect(ctx.subject.permissionGranted()).rejects.toThrow();
    });

    check("shows the notification with its title and body", async () => {
      await ctx.subject.show("Alice in #general", "hello");
      expect(ctx.native.shown()).toEqual([{ title: "Alice in #general", body: "hello" }]);
    });

    check("asks for the user's attention once per flash", async () => {
      await ctx.subject.flashTaskbar();
      expect(ctx.native.attentionRequests()).toBe(1);
    });
  });
}

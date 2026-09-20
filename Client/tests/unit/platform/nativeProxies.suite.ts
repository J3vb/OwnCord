// Behaviour suite for the `ensureHttpProxy` half of the `NativeProxies`
// contract (`src/platform/contracts/nativeProxies.ts`). The LiveKit half is
// no-seam (`LiveKitUrlResolver` is a class, not an exported function) — its
// suite lands with the seam in B7-5.
import { beforeEach, describe, expect, test } from "vitest";
import type { NativeProxies } from "../../../src/platform/contracts/nativeProxies";

export interface NativeControl {
  succeedWith(port: number): void;
  failWith(error: unknown): void;
}

export type NativeProxiesSeam = Pick<NativeProxies, "ensureHttpProxy">;

export interface NativeProxiesSubject {
  readonly subject: NativeProxiesSeam;
  readonly native: NativeControl;
}

export function describeNativeProxiesSuite(
  makeSubject: () => Promise<NativeProxiesSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("NativeProxies (ensureHttpProxy seam)", () => {
    let ctx: NativeProxiesSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("resolves the loopback origin for the started tunnel", async () => {
      ctx.native.succeedWith(51820);
      await expect(ctx.subject.ensureHttpProxy("chat.example")).resolves.toBe(
        "http://127.0.0.1:51820",
      );
    });

    check("rejects when the native tunnel fails to start", async () => {
      ctx.native.failWith(new Error("bind failed"));
      await expect(ctx.subject.ensureHttpProxy("chat.example")).rejects.toThrow();
    });

    check("resolves the same origin to two concurrent callers for the same host", async () => {
      ctx.native.succeedWith(51820);
      const [first, second] = await Promise.all([
        ctx.subject.ensureHttpProxy("chat.example"),
        ctx.subject.ensureHttpProxy("chat.example"),
      ]);
      expect(first).toBe(second);
    });
  });
}

// Behaviour suite for the `AppMetadata` contract
// (`src/platform/contracts/appMetadata.ts`). Written in B7-5 against the
// in-place seam in `settings/LogsTab.ts` before the move, so it pins today's
// behaviour rather than the moved code's.
import { beforeEach, describe, expect, test } from "vitest";
import type { AppMetadata } from "../../../src/platform/contracts/appMetadata";

export interface NativeControl {
  version(value: string): void;
  failWith(error: unknown): void;
}

export interface AppMetadataSubject {
  readonly subject: AppMetadata;
  readonly native: NativeControl;
}

export function describeAppMetadataSuite(
  makeSubject: () => Promise<AppMetadataSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("AppMetadata", () => {
    let ctx: AppMetadataSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("resolves the version the native host reports", async () => {
      ctx.native.version("1.4.2");
      await expect(ctx.subject.getVersion()).resolves.toBe("1.4.2");
    });

    // The Logs tab shows "unknown" on a rejection; resolving a placeholder
    // instead would print it as a real version.
    check("rejects when the native host cannot report one", async () => {
      ctx.native.failWith(new Error("not running under the native host"));
      await expect(ctx.subject.getVersion()).rejects.toThrow();
    });
  });
}

// Behaviour suite for the `DeepLinks` contract
// (`src/platform/contracts/deepLinks.ts`). Link parsing itself
// (`parseInviteLink`/`parseMessageLink`) is pure and already covered
// elsewhere — this suite only asserts what `onInvite`/`onMessage` receive
// for a cold-start link.
//
// No test for "the native host is unavailable": `init()` resolving without
// calling either callback is exactly what a subject that does nothing at all
// also does — there is no other caller-observable effect at this seam to pin
// instead. See docs/architecture/platform-contracts.md's "Contracts (B7-3)"
// section, "Suite coverage gaps".
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DeepLinks } from "../../../src/platform/contracts/deepLinks";

export interface NativeControl {
  /** Cold-start links the native plugin reports via `getCurrent()`. */
  coldStartLinks(urls: readonly string[]): void;
}

export interface DeepLinksSubject {
  readonly subject: DeepLinks;
  readonly native: NativeControl;
}

export function describeDeepLinksSuite(
  makeSubject: () => Promise<DeepLinksSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("DeepLinks", () => {
    let ctx: DeepLinksSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("delivers a cold-start invite link to onInvite", async () => {
      ctx.native.coldStartLinks(["owncord://invite/ABC123"]);
      const onInvite = vi.fn();
      await ctx.subject.init(onInvite);
      expect(onInvite).toHaveBeenCalledWith("ABC123", undefined);
    });

    check("delivers a cold-start message permalink to onMessage", async () => {
      ctx.native.coldStartLinks(["owncord://message/7/42"]);
      const onInvite = vi.fn();
      const onMessage = vi.fn();
      await ctx.subject.init(onInvite, onMessage);
      expect(onMessage).toHaveBeenCalledWith(7, 42);
      expect(onInvite).not.toHaveBeenCalled();
    });
  });
}

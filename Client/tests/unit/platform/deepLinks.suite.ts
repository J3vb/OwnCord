// Behaviour suite for the `DeepLinks` contract
// (`src/platform/contracts/deepLinks.ts`). Link parsing itself
// (`parseInviteLink`/`parseMessageLink`) is pure and already covered
// elsewhere — this suite only asserts what `onInvite`/`onMessage` receive
// for a cold-start link.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DeepLinks } from "../../../src/platform/contracts/deepLinks";

export interface NativeControl {
  /** Cold-start links the native plugin reports via `getCurrent()`. */
  coldStartLinks(urls: readonly string[]): void;
  /** The native deep-link plugin is unavailable (e.g. not running under the
   *  native host). */
  unavailable(): void;
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

    check(
      "resolves without calling either callback when the native host is unavailable",
      async () => {
        ctx.native.unavailable();
        const onInvite = vi.fn();
        const onMessage = vi.fn();
        await expect(ctx.subject.init(onInvite, onMessage)).resolves.toBeUndefined();
        expect(onInvite).not.toHaveBeenCalled();
        expect(onMessage).not.toHaveBeenCalled();
      },
    );
  });
}

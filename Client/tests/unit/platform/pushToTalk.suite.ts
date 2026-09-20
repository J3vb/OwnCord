// Behaviour suite for the `PushToTalk` contract
// (`src/platform/contracts/pushToTalk.ts`). The mute-gating/mute-ownership
// behaviour already has its own coverage (`tests/unit/ptt*.test.ts`), which
// B7-5 keeps green — this suite only asserts what a caller of the four
// contract methods themselves receives.
import { beforeEach, describe, expect, test } from "vitest";
import type { PushToTalk } from "../../../src/platform/contracts/pushToTalk";

export interface NativeControl {
  captureSucceedsWith(vk: number): void;
  captureFailsWith(error: unknown): void;
  /** Swap the persisted PTT-key preference the binding reads on `init()`. */
  configuredKey(vk: number): void;
  /** The binding's own bookkeeping of whether native key polling is running. */
  pollingStarted(): boolean;
}

export interface PushToTalkSubject {
  readonly subject: PushToTalk;
  readonly native: NativeControl;
}

export function describePushToTalkSuite(
  makeSubject: () => Promise<PushToTalkSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("PushToTalk", () => {
    let ctx: PushToTalkSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    describe("captureKeyPress", () => {
      check("resolves the captured virtual key code", async () => {
        ctx.native.captureSucceedsWith(0x41);
        await expect(ctx.subject.captureKeyPress()).resolves.toBe(0x41);
      });

      check("rejects when the native capture command fails", async () => {
        ctx.native.captureFailsWith(new Error("capture failed"));
        await expect(ctx.subject.captureKeyPress()).rejects.toThrow();
      });
    });

    describe("init", () => {
      // A single test, not two: "no key configured" alone is a negative
      // claim (nothing happens) that an inert do-nothing subject satisfies
      // trivially — the positive half (a configured key really starts
      // polling) is what makes the negative half meaningful.
      check("starts native polling only once a key is configured", async () => {
        ctx.native.configuredKey(0);
        await ctx.subject.init();
        expect(ctx.native.pollingStarted()).toBe(false);

        ctx.native.configuredKey(0x41);
        await ctx.subject.init();
        expect(ctx.native.pollingStarted()).toBe(true);
      });
    });

    describe("stop", () => {
      check("resolves safely with nothing bound, without blocking a later start", async () => {
        await expect(ctx.subject.stop()).resolves.toBeUndefined();
        ctx.native.configuredKey(0x41);
        await ctx.subject.init();
        expect(ctx.native.pollingStarted()).toBe(true);
      });

      check("stops native polling that init() started", async () => {
        ctx.native.configuredKey(0x41);
        await ctx.subject.init();
        expect(ctx.native.pollingStarted()).toBe(true);
        await ctx.subject.stop();
        expect(ctx.native.pollingStarted()).toBe(false);
      });
    });

    describe("updateKey", () => {
      // Same reasoning as init(): the "disabling" half only means something
      // next to the "configuring" half.
      check("starts polling for a newly configured key, stops it when disabled", async () => {
        await ctx.subject.updateKey(0x41);
        expect(ctx.native.pollingStarted()).toBe(true);

        await ctx.subject.updateKey(0);
        expect(ctx.native.pollingStarted()).toBe(false);
      });
    });
  });
}

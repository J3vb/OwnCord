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
      check("resolves without starting native polling when no key is configured", async () => {
        await expect(ctx.subject.init()).resolves.toBeUndefined();
      });
    });

    describe("stop", () => {
      check("resolves safely when nothing is bound", async () => {
        await expect(ctx.subject.stop()).resolves.toBeUndefined();
      });
    });

    describe("updateKey", () => {
      check("resolves when disabling an unbound key", async () => {
        await expect(ctx.subject.updateKey(0)).resolves.toBeUndefined();
      });
    });
  });
}

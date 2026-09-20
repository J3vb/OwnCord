// Behaviour suite for the `logPersistence` half of the `LogFiles` contract
// (`src/platform/contracts/logFiles.ts`): `init`, `flush`, `clearPending`,
// `getDir`. The `clearAll` half (today's private `clearLogFiles` in
// `settings/AdvancedTab.ts`) is no-seam — its suite lands with the seam in
// B7-4, so this suite exercises only the four methods that already have an
// exported seam in `lib/logPersistence.ts`.
import { beforeEach, describe, expect, it } from "vitest";
import type { LogFiles } from "../../../src/platform/contracts/logFiles";

export interface NativeControl {
  succeedWith(): void;
  failWith(error: unknown): void;
  unavailable(): void;
}

export type LogFilesSeam = Pick<LogFiles, "init" | "flush" | "clearPending" | "getDir">;

export interface LogFilesSubject {
  readonly subject: LogFilesSeam;
  readonly native: NativeControl;
}

export function describeLogFilesSuite(makeSubject: () => Promise<LogFilesSubject>): void {
  describe("LogFiles (logPersistence seam)", () => {
    let ctx: LogFilesSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    describe("getDir", () => {
      it("returns null before init() has run", () => {
        expect(ctx.subject.getDir()).toBeNull();
      });

      it("returns the resolved log directory after a successful init()", async () => {
        ctx.native.succeedWith();
        await ctx.subject.init();
        expect(ctx.subject.getDir()).not.toBeNull();
      });
    });

    describe("init", () => {
      it("resolves a cleanup function when the native filesystem is available", async () => {
        ctx.native.succeedWith();
        const cleanup = await ctx.subject.init();
        expect(typeof cleanup).toBe("function");
      });

      // Pinned as-is (B7-3): init() never rejects — any native failure is
      // caught and logged, and the caller gets a harmless no-op cleanup.
      it("resolves a no-op cleanup, not a rejection, when the native host is unavailable", async () => {
        ctx.native.unavailable();
        const cleanup = await ctx.subject.init();
        expect(typeof cleanup).toBe("function");
        expect(ctx.subject.getDir()).toBeNull();
      });
    });

    describe("flush", () => {
      it("resolves after a successful init()", async () => {
        ctx.native.succeedWith();
        await ctx.subject.init();
        await expect(ctx.subject.flush()).resolves.toBeUndefined();
      });
    });

    describe("clearPending", () => {
      it("resolves even with nothing buffered", async () => {
        await expect(ctx.subject.clearPending()).resolves.toBeUndefined();
      });
    });
  });
}

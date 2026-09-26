// Behaviour suite for the `logPersistence` half of the `LogFiles` contract
// (`src/platform/contracts/logFiles.ts`): `init`, `flush`, `clearPending`,
// `getDir`. The `clearAll` half (today's private `clearLogFiles` in
// `settings/AdvancedTab.ts`) is no-seam — its suite lands with the seam in
// B7-4, so this suite exercises only the four methods that already have an
// exported seam in `lib/logPersistence.ts`.
import { beforeEach, describe, expect, test } from "vitest";
import type { LogFiles } from "../../../src/platform/contracts/logFiles";

export interface NativeControl {
  succeedWith(): void;
  unavailable(): void;
  /** Simulate the app logger emitting one entry — persisted only once
   *  `init()` has wired up the listener that feeds the write buffer. */
  logEntry(): void;
  /** The raw line-batches the native filesystem layer has actually received
   *  via a write call so far, in call order. */
  written(): readonly string[];
}

export type LogFilesSeam = Pick<LogFiles, "init" | "flush" | "clearPending" | "getDir">;

export interface LogFilesSubject {
  readonly subject: LogFilesSeam;
  readonly native: NativeControl;
}

export function describeLogFilesSuite(
  makeSubject: () => Promise<LogFilesSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("LogFiles (logPersistence seam)", () => {
    let ctx: LogFilesSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    describe("getDir", () => {
      check("returns null before init() has run", () => {
        expect(ctx.subject.getDir()).toBeNull();
      });

      check("returns the resolved log directory after a successful init()", async () => {
        ctx.native.succeedWith();
        await ctx.subject.init();
        expect(typeof ctx.subject.getDir()).toBe("string");
      });
    });

    describe("init", () => {
      check("resolves a cleanup function when the native filesystem is available", async () => {
        ctx.native.succeedWith();
        const cleanup = await ctx.subject.init();
        expect(typeof cleanup).toBe("function");
      });

      // Pinned as-is (B7-3): init() never rejects — any native failure is
      // caught and logged, and the caller gets a harmless no-op cleanup.
      check(
        "resolves a no-op cleanup, not a rejection, when the native host is unavailable",
        async () => {
          ctx.native.unavailable();
          const cleanup = await ctx.subject.init();
          expect(typeof cleanup).toBe("function");
          expect(ctx.subject.getDir()).toBeNull();
        },
      );
    });

    describe("flush", () => {
      check("writes buffered log entries through to the native filesystem", async () => {
        ctx.native.succeedWith();
        await ctx.subject.init();
        ctx.native.logEntry();
        await ctx.subject.flush();
        expect(ctx.native.written().length).toBeGreaterThan(0);
      });
    });

    describe("clearPending", () => {
      // A bare "writes nothing" alone is a negative claim an inert
      // do-nothing subject satisfies trivially (it never writes anything at
      // all) — the contrasting write in the second half is what proves
      // clearPending() actually discarded the first entry rather than the
      // subject just never persisting anything.
      check("discards buffered entries so a following flush() writes nothing new", async () => {
        ctx.native.succeedWith();
        await ctx.subject.init();

        ctx.native.logEntry();
        await ctx.subject.clearPending();
        await ctx.subject.flush();
        expect(ctx.native.written()).toEqual([]);

        ctx.native.logEntry();
        await ctx.subject.flush();
        expect(ctx.native.written().length).toBe(1);
      });
    });
  });
}

// Behaviour suite for the `FileSaver` contract
// (`src/platform/contracts/fileSave.ts`). Run now against the legacy binding
// (`fileSave.legacy.test.ts`, today's `downloadFile` save/write pair) and
// again in B7-4 against `platform/desktop` — a green run before and after
// that move is the evidence the move changed nothing.
//
// Asserts only what the CALLER receives: no command name, no plugin argument
// shape. The success path of `writeFile` and the resolved value of
// `pickSaveLocation` are the whole of what a caller can observe at this seam.
import { beforeEach, describe, expect, test } from "vitest";
import type { FileSaver } from "../../../src/platform/contracts/fileSave";

/** A small control handle the legacy/desktop binding supplies so the suite
 *  never has to know how "the native dialog/filesystem resolves, rejects or
 *  is unavailable" is actually wired for that binding. */
export interface NativeControl {
  /** The native save dialog answers with this path; null means dismissed. */
  dialogResolves(path: string | null): void;
  dialogFailsWith(error: unknown): void;
  /** The path/bytes pairs the native filesystem has been handed, in order. */
  written(): readonly { path: string; data: Uint8Array }[];
  writeFailsWith(error: unknown): void;
}

export interface FileSaveSubject {
  readonly subject: FileSaver;
  readonly native: NativeControl;
}

const bytes = new Uint8Array([0x4f, 0x77, 0x6e, 0x43, 0x6f, 0x72, 0x64]);

export function describeFileSaverSuite(
  makeSubject: () => Promise<FileSaveSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("FileSaver", () => {
    let ctx: FileSaveSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    describe("pickSaveLocation", () => {
      check("resolves the location the native dialog chose", async () => {
        ctx.native.dialogResolves("/home/alice/report.pdf");
        await expect(ctx.subject.pickSaveLocation("report.pdf")).resolves.toBe(
          "/home/alice/report.pdf",
        );
      });

      check("resolves null when the user dismisses the dialog", async () => {
        ctx.native.dialogResolves(null);
        await expect(ctx.subject.pickSaveLocation("report.pdf")).resolves.toBeNull();
      });

      // Pinned as-is (B7-4): a dialog failure is not a cancellation — it
      // propagates, so the caller can tell "no thanks" from "something broke".
      check("rejects when the native dialog errors", async () => {
        ctx.native.dialogFailsWith(new Error("no display"));
        await expect(ctx.subject.pickSaveLocation("report.pdf")).rejects.toThrow();
      });
    });

    describe("writeFile", () => {
      check("writes the caller's bytes to the chosen path", async () => {
        await ctx.subject.writeFile("/home/alice/report.pdf", bytes);
        expect(ctx.native.written()).toEqual([{ path: "/home/alice/report.pdf", data: bytes }]);
      });

      check("writes each file to its own path, in call order", async () => {
        await ctx.subject.writeFile("/home/alice/a.bin", bytes);
        await ctx.subject.writeFile("/home/alice/b.bin", new Uint8Array([1]));
        expect(ctx.native.written().map((entry) => entry.path)).toEqual([
          "/home/alice/a.bin",
          "/home/alice/b.bin",
        ]);
      });

      check("rejects when the native write fails", async () => {
        ctx.native.writeFailsWith(new Error("disk full"));
        await expect(ctx.subject.writeFile("/home/alice/report.pdf", bytes)).rejects.toThrow();
      });
    });
  });
}

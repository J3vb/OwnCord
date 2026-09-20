// Behaviour suite for the `AppUpdater` half of the `updater.ts` contract
// (`src/platform/contracts/updater.ts`). `Autostart` is no-seam — its suite
// lands with the seam in B7-5.
import { beforeEach, describe, expect, test } from "vitest";
import type { AppUpdater, UpdateInstallState } from "../../../src/platform/contracts/updater";

export interface NativeControl {
  checkSucceedsWith(result: {
    available: boolean;
    version: string | null;
    body: string | null;
    manual_upgrade: boolean;
  }): void;
  checkFailsWith(error: unknown): void;
  installSucceeds(): void;
  installFailsWith(error: unknown): void;
}

export interface AppUpdaterSubject {
  readonly subject: AppUpdater;
  readonly native: NativeControl;
}

export function describeAppUpdaterSuite(
  makeSubject: () => Promise<AppUpdaterSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("AppUpdater", () => {
    let ctx: AppUpdaterSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    describe("checkForUpdate", () => {
      check("resolves the native check result as-is", async () => {
        ctx.native.checkSucceedsWith({
          available: true,
          version: "1.2.1",
          body: "notes",
          manual_upgrade: false,
        });
        await expect(ctx.subject.checkForUpdate("https://chat.example")).resolves.toEqual({
          available: true,
          version: "1.2.1",
          body: "notes",
          manual_upgrade: false,
        });
      });

      // Pinned as-is (B7-3): a failed check resolves the "nothing available"
      // default rather than rejecting — the caller cannot distinguish "no
      // update" from "couldn't check".
      check("resolves the no-update default, not a rejection, when the check fails", async () => {
        ctx.native.checkFailsWith(new Error("network error"));
        await expect(ctx.subject.checkForUpdate("https://chat.example")).resolves.toEqual({
          available: false,
          version: null,
          body: null,
          manual_upgrade: false,
        });
      });
    });

    describe("downloadAndInstallUpdate / subscribeToInstall", () => {
      check("publishes a restarting state and resolves on success", async () => {
        ctx.native.installSucceeds();
        const states: UpdateInstallState[] = [];
        ctx.subject.subscribeToInstall((s) => states.push(s));
        await ctx.subject.downloadAndInstallUpdate("https://chat.example");
        expect(states.at(-1)).toEqual({ status: "restarting" });
      });

      check("publishes a failed state and rejects when the install fails", async () => {
        ctx.native.installFailsWith(new Error("download failed"));
        const states: UpdateInstallState[] = [];
        ctx.subject.subscribeToInstall((s) => states.push(s));
        await expect(
          ctx.subject.downloadAndInstallUpdate("https://chat.example"),
        ).rejects.toThrow();
        expect(states.at(-1)).toEqual({ status: "failed", restartRequired: false });
      });
    });
  });
}

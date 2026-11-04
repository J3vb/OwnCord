// Behaviour suite for the `AppUpdater` half of the `updater.ts` contract
// (`src/platform/contracts/updater.ts`). `Autostart` is no-seam — its suite
// lands with the seam in B7-5.
import { beforeEach, describe, expect, test, vi, type Mock } from "vitest";
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

/** Routes the mocked `invoke` so only the named command answers; every other command rejects. */
export function updaterNativeControl(invoke: Mock): NativeControl {
  const answering = (command: string, reply: () => Promise<unknown>): void => {
    invoke.mockImplementation((cmd: string) =>
      cmd === command ? reply() : Promise.reject(new Error(cmd)),
    );
  };
  return {
    checkSucceedsWith(result) {
      answering("check_client_update", () => Promise.resolve(result));
    },
    checkFailsWith(error) {
      answering("check_client_update", () => Promise.reject(error));
    },
    installSucceeds() {
      answering("download_and_install_update", () => Promise.resolve(undefined));
    },
    installFailsWith(error) {
      answering("download_and_install_update", () => Promise.reject(error));
    },
  };
}

/** Fresh module graph and cleared native mocks, so each test starts from a new updater. */
export function resetUpdaterNatives(natives: {
  invoke: Mock;
  relaunch: Mock;
  listen: Mock;
  unlisten: Mock;
}): void {
  vi.resetModules();
  natives.invoke.mockReset();
  natives.relaunch.mockReset().mockResolvedValue(undefined);
  natives.listen.mockReset().mockResolvedValue(natives.unlisten);
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

      // Pinned (B7-3): a failed check resolves the "nothing available" default
      // rather than rejecting. `failed: true` marks it, so a caller that must
      // not claim "up to date" (Settings → Check for updates) can tell "no
      // update" from "couldn't check"; the banner still reads it as no update.
      check("resolves the no-update default, not a rejection, when the check fails", async () => {
        ctx.native.checkFailsWith(new Error("network error"));
        await expect(ctx.subject.checkForUpdate("https://chat.example")).resolves.toEqual({
          available: false,
          version: null,
          body: null,
          manual_upgrade: false,
          failed: true,
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

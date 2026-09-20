// Behaviour suite for the `SettingsStore` contract
// (`src/platform/contracts/settings.ts`). Run now against the legacy binding
// (`settings.legacy.test.ts`, today's `lib/profiles.ts` `createTauriBackend()`)
// and again in B7-4 against `platform/desktop`.
import { beforeEach, describe, expect, test } from "vitest";
import type { SettingsSnapshot, SettingsStore } from "../../../src/platform/contracts/settings";

export interface NativeControl {
  succeedWith(value: unknown): void;
  failWith(error: unknown): void;
  unavailable(): void;
}

export interface SettingsStoreSubject {
  readonly subject: SettingsStore;
  readonly native: NativeControl;
}

const snapshot: SettingsSnapshot = {
  schemaVersion: 1,
  profiles: [
    {
      id: "a",
      name: "Home",
      host: "example.com",
      username: "alice",
      autoConnect: false,
      rememberPassword: false,
      color: "#000000",
      lastConnected: null,
    },
  ],
};

export function describeSettingsStoreSuite(
  makeSubject: () => Promise<SettingsStoreSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("SettingsStore", () => {
    let ctx: SettingsStoreSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    describe("load", () => {
      check("resolves the stored snapshot when the native store holds one", async () => {
        ctx.native.succeedWith({ "owncord:profiles": snapshot });
        await expect(ctx.subject.load()).resolves.toEqual(snapshot);
      });

      check("resolves null when nothing is stored under the settings key", async () => {
        ctx.native.succeedWith({});
        await expect(ctx.subject.load()).resolves.toBeNull();
      });

      check("rejects when the native store errors", async () => {
        ctx.native.failWith(new Error("read failed"));
        await expect(ctx.subject.load()).rejects.toThrow();
      });

      // Pinned as-is (B7-3): this seam has no not-native guard today —
      // calling it with no native host rejects, it does not fail open.
      check("rejects when the native host is unavailable", async () => {
        ctx.native.unavailable();
        await expect(ctx.subject.load()).rejects.toThrow();
      });
    });

    describe("save", () => {
      check("resolves when the native store accepts the write", async () => {
        ctx.native.succeedWith(undefined);
        await expect(ctx.subject.save(snapshot)).resolves.toBeUndefined();
      });

      check("rejects when the native store errors", async () => {
        ctx.native.failWith(new Error("write failed"));
        await expect(ctx.subject.save(snapshot)).rejects.toThrow();
      });

      check("rejects when the native host is unavailable", async () => {
        ctx.native.unavailable();
        await expect(ctx.subject.save(snapshot)).rejects.toThrow();
      });
    });
  });
}

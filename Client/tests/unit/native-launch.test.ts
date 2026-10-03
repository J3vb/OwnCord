import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { clearNativeProfiles } from "../e2e/support/native-app";

const profiles = ["C:\\Roaming\\com.owncord.e2e", "C:\\Local\\com.owncord.e2e"];

describe("native pre-launch profile clear", () => {
  it("removes every profile and reports how long it took", async () => {
    const removed: string[] = [];
    const elapsed = await clearNativeProfiles(profiles, async (path) => {
      await delay(30);
      removed.push(path);
    });
    expect(removed).toEqual(profiles);
    expect(elapsed).toBeGreaterThanOrEqual(55);
  });

  it("names the locked profile and the time spent instead of a bare EBUSY", async () => {
    // A process that outlived the previous test keeps a profile file open; rm
    // spends its retries and gives up. That time used to vanish into the test
    // timeout with no hint that the launch had not even started.
    const remove = vi.fn(async (path: string) => {
      await delay(20);
      if (path === profiles[1])
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path}'`), {
          code: "EBUSY",
        });
    });
    const failure = await clearNativeProfiles(profiles, remove).then(
      () => undefined,
      (error: unknown) => String(error),
    );
    expect(failure).toMatch(
      /^Error: native profile C:\\Local\\com\.owncord\.e2e still locked after \d+ms: Error: EBUSY/,
    );
  });
});

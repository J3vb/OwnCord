// The Android app's side of `pushRegistration` (`PushPlugin.kt` through
// `src-tauri/src/push.rs`): the plugin's refusals become a reason Settings can
// show, and its events reach only the newest follower until it stops.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushHostEvent } from "../../../../src/platform/contracts/pushRegistration";

const native = vi.hoisted(() => ({
  android: true,
  invoke: vi.fn(),
  listen: vi.fn(),
  unregister: vi.fn(async () => undefined),
}));
vi.mock("@lib/hostPlatform", () => ({ isAndroidHost: () => native.android }));
vi.mock("@tauri-apps/api/core", () => ({
  addPluginListener: native.listen,
  invoke: native.invoke,
}));

import { pushRegistration } from "../../../../src/platform/desktop/pushRegistration";

const REQUEST = { instance: "h#1", vapid: "V", serverName: "Home", title: "T", body: "B" };

async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  await new Promise((r) => setTimeout(r, 0));
}

describe("push registration on the Android host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.android = true;
    native.listen.mockImplementation(async (_plugin: string, event: string, cb: unknown) => ({
      event,
      cb,
      unregister: native.unregister,
    }));
  });

  it("hands back the endpoint and keys the push app gave", async () => {
    native.invoke.mockResolvedValue({ endpoint: "https://up/1", p256dh: "P", auth: "A" });
    await expect(pushRegistration.register(REQUEST)).resolves.toEqual({
      ok: true,
      keys: { endpoint: "https://up/1", p256dh: "P", auth: "A" },
    });
    expect(native.invoke).toHaveBeenCalledWith("push_register", REQUEST);
  });

  it.each([
    ["push register: NO_DISTRIBUTOR", "no-distributor"],
    ["push register: CHOOSE_DISTRIBUTOR", "choose"],
    ["push register: TIMEOUT", "failed"],
  ])("turns the plugin's %s into %s", async (message, reason) => {
    native.invoke.mockRejectedValue(message);
    await expect(pushRegistration.register(REQUEST)).resolves.toEqual({ ok: false, reason });
  });

  it("an answer without keys is a failure, not a subscription", async () => {
    native.invoke.mockResolvedValue({ endpoint: "https://up/1" });
    await expect(pushRegistration.register(REQUEST)).resolves.toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("reports only the newest follower's events, and stops listening when it stops", async () => {
    const older = new AbortController();
    const newer = new AbortController();
    const seenOld: PushHostEvent[] = [];
    const seenNew: PushHostEvent[] = [];
    pushRegistration.follow(older.signal, (e) => seenOld.push(e));
    await settle();
    pushRegistration.follow(newer.signal, (e) => seenNew.push(e));
    await settle();

    const endpointCb = native.listen.mock.calls
      .filter(([, event]) => event === "endpoint")
      .map(([, , cb]) => cb as (p: unknown) => void);
    for (const cb of endpointCb) cb({ instance: "h#1" });
    expect(seenOld).toEqual([]);
    expect(seenNew).toEqual([{ kind: "endpoint", instance: "h#1" }]);

    newer.abort();
    expect(native.unregister).toHaveBeenCalledTimes(3);
  });

  it("does nothing outside the Android app", async () => {
    native.android = false;
    expect(pushRegistration.supported).toBe(false);
    await expect(pushRegistration.register(REQUEST)).resolves.toEqual({
      ok: false,
      reason: "failed",
    });
    await expect(pushRegistration.status()).resolves.toBeNull();
    expect(native.invoke).not.toHaveBeenCalled();
  });
});

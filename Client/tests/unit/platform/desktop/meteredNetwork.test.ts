import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Disposable } from "../../../../src/lib/disposable";
import { createDeferred } from "../../../helpers/deferred";

const native = vi.hoisted(() => ({
  android: true,
  invoke: vi.fn(),
  listen: vi.fn(),
  unregister: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@lib/hostPlatform", () => ({ isAndroidHost: () => native.android }));
vi.mock("@lib/logger", () => ({ createLogger: () => ({ warn: native.warn }) }));
vi.mock("@tauri-apps/api/core", () => ({ addPluginListener: native.listen }));
vi.mock("../../../../src/platform/desktop/nativeInvoke", () => ({ tryInvoke: native.invoke }));
vi.mock("../../../../src/platform/desktop", async () => ({
  desktop: {
    meteredNetwork: (await import("../../../../src/platform/desktop/meteredNetwork"))
      .meteredNetwork,
  },
}));

let owner: Disposable;
let changed: (payload: unknown) => void;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  owner = new Disposable();
  native.android = true;
  native.unregister.mockResolvedValue(undefined);
  native.listen.mockImplementation((_plugin: string, _event: string, handler: typeof changed) => {
    changed = handler;
    return Promise.resolve({ unregister: native.unregister });
  });
  native.invoke.mockResolvedValue({ ok: true, value: { metered: true } });
});
afterEach(() => owner.destroy());

describe("native metered network", () => {
  it("never invokes or listens on non-Android hosts", async () => {
    native.android = false;
    const { meteredNetwork } = await import("../../../../src/platform/desktop/meteredNetwork");
    await meteredNetwork.start(owner.signal);
    expect(meteredNetwork.isMetered()).toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();
    expect(native.listen).not.toHaveBeenCalled();
  });

  it("queries the initial cost and accepts metered-changed updates", async () => {
    const { meteredNetwork } = await import("../../../../src/platform/desktop/meteredNetwork");
    await meteredNetwork.start(owner.signal);
    expect(native.invoke).toHaveBeenCalledWith("is_metered");
    expect(native.listen).toHaveBeenCalledWith(
      "owncord-metered-network",
      "metered-changed",
      expect.any(Function),
    );
    expect(meteredNetwork.isMetered()).toBe(true);
    changed({ metered: false });
    expect(meteredNetwork.isMetered()).toBe(false);
    changed({ metered: true });
    expect(meteredNetwork.isMetered()).toBe(true);
  });

  it("keeps a newer event when the initial query answers late", async () => {
    const query = createDeferred<unknown>();
    native.invoke.mockReturnValue(query.promise);
    const { meteredNetwork } = await import("../../../../src/platform/desktop/meteredNetwork");
    const starting = meteredNetwork.start(owner.signal);
    await Promise.resolve();
    changed({ metered: true });
    query.resolve({ ok: true, value: { metered: false } });
    await starting;
    expect(meteredNetwork.isMetered()).toBe(true);
  });

  it("treats a rejected command as unmetered and warns once", async () => {
    native.invoke.mockResolvedValue({ ok: false, error: new Error("missing plugin") });
    const { meteredNetwork } = await import("../../../../src/platform/desktop/meteredNetwork");
    await meteredNetwork.start(owner.signal);
    expect(meteredNetwork.isMetered()).toBe(false);
    owner.destroy();
    owner = new Disposable();
    await meteredNetwork.start(owner.signal);
    expect(native.warn).toHaveBeenCalledTimes(1);
  });

  it("contains a missing event plugin and unregisters a late listener", async () => {
    native.listen.mockRejectedValueOnce(new Error("plugin missing"));
    const { meteredNetwork } = await import("../../../../src/platform/desktop/meteredNetwork");
    await meteredNetwork.start(owner.signal);
    expect(meteredNetwork.isMetered()).toBe(false);
    const listener = createDeferred<{ unregister: typeof native.unregister }>();
    native.listen.mockReturnValueOnce(listener.promise);
    const starting = meteredNetwork.start(owner.signal);
    owner.destroy();
    listener.resolve({ unregister: native.unregister });
    await starting;
    expect(native.unregister).toHaveBeenCalledTimes(1);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("unsubscribes and ignores late events after teardown", async () => {
    const { meteredNetwork } = await import("../../../../src/platform/desktop/meteredNetwork");
    await meteredNetwork.start(owner.signal);
    owner.destroy();
    changed({ metered: true });
    expect(meteredNetwork.isMetered()).toBe(false);
    expect(native.unregister).toHaveBeenCalledTimes(1);
  });

  it("metered-changed affects new renders without opening an existing placeholder", async () => {
    const { meteredNetwork } = await import("../../../../src/platform/desktop/meteredNetwork");
    const { dataSaverActive } =
      await import("../../../../src/features/messaging/content/dataSaver");
    const { renderDeferredMedia } =
      await import("../../../../src/features/messaging/content/deferredMedia");
    const { savePref, removeStored, STORAGE_PREFIX } =
      await import("../../../../src/lib/prefs/preferences");
    savePref("dataSaver", "mobile");
    await meteredNetwork.start(owner.signal);
    const load = vi.fn(() => document.createElement("div"));
    const old = dataSaverActive() ? renderDeferredMedia("photo.png", load) : null;
    changed({ metered: false });
    expect(dataSaverActive()).toBe(false);
    expect(old?.dataset.dataSaver).toBe("waiting");
    expect(load).not.toHaveBeenCalled();
    old?.querySelector("button")?.click();
    expect(load).toHaveBeenCalledTimes(1);
    removeStored(STORAGE_PREFIX + "dataSaver");
  });
});

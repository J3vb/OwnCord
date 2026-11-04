// Desktop binding for the GpuAdapter contract: a native failure or a payload
// of the wrong shape must come back as null/false, never as a rejection.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as lm from "../../helpers/loggerMock";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@lib/logger", () => lm.loggerMock());

const { gpuAdapter } = await import("../../../src/platform/desktop/gpuAdapter");

const card = { id: "10de:1234:RTX", name: "RTX", vendorId: 0x10de, deviceId: 0x1234 };
const state = {
  cards: [card],
  saved: "auto",
  active: null,
  notFound: false,
  resetAfterCrash: false,
  autoOff: false,
};

describe("gpuAdapter (desktop)", () => {
  const userAgent = vi.spyOn(navigator, "userAgent", "get");
  beforeEach(() => {
    invoke.mockReset();
    userAgent.mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/155.0");
  });

  it("is available on Windows only and asks the host nothing elsewhere", async () => {
    expect(gpuAdapter.available).toBe(true);
    userAgent.mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
    expect(gpuAdapter.available).toBe(false);
    await expect(gpuAdapter.list()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads the cards from get_gpu_adapters", async () => {
    invoke.mockResolvedValue(state);
    await expect(gpuAdapter.list()).resolves.toEqual(state);
    expect(invoke).toHaveBeenCalledWith("get_gpu_adapters");
  });

  it("answers null when the host rejects or sends a bad payload", async () => {
    invoke.mockRejectedValue("no host");
    await expect(gpuAdapter.list()).resolves.toBeNull();
    for (const payload of [undefined, "x", {}, { ...state, cards: [{ id: 1 }] }]) {
      invoke.mockResolvedValue(payload);
      await expect(gpuAdapter.list()).resolves.toBeNull();
    }
  });

  it("saves through set_gpu_adapter and reports a failure as false", async () => {
    invoke.mockResolvedValue(undefined);
    await expect(gpuAdapter.set(card.id)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("set_gpu_adapter", { choice: card.id });
    invoke.mockRejectedValue("disk full");
    await expect(gpuAdapter.set("auto")).resolves.toBe(false);
  });
});

// Desktop binding for the SystemRegion contract (`system_region_locale`). A
// host failure is "unknown", never a rejection at startup.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { systemRegion } = await import("../../../src/platform/desktop/systemRegion");

describe("systemRegion (desktop)", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("returns the tag the host reads", async () => {
    invoke.mockResolvedValue("nl-BE");
    await expect(systemRegion.localeTag()).resolves.toBe("nl-BE");
    expect(invoke).toHaveBeenCalledWith("system_region_locale");
  });

  it("answers null when the host cannot say or fails", async () => {
    invoke.mockResolvedValue(null);
    await expect(systemRegion.localeTag()).resolves.toBeNull();
    invoke.mockRejectedValue(new Error("command system_region_locale not found"));
    await expect(systemRegion.localeTag()).resolves.toBeNull();
  });
});

// The desktop registry's call service talks to the host only in the Android
// app, and a host refusal never reaches the caller.
import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ android: true, invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: host.invoke }));
vi.mock("../../../src/lib/hostPlatform", () => ({ isAndroidHost: () => host.android }));

import { callService } from "../../../src/platform/desktop/callService";
import { expectConsole } from "../../helpers/console";

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("desktop call service", () => {
  beforeEach(() => {
    host.android = true;
    host.invoke.mockReset();
    host.invoke.mockResolvedValue(null);
  });

  it("sends each state to the Android host in order", () => {
    callService.update({ active: true, camera: false });
    callService.update({ active: true, camera: true });
    callService.update({ active: false, camera: false });
    expect(host.invoke.mock.calls).toEqual([
      ["set_call_service", { active: true, camera: false }],
      ["set_call_service", { active: true, camera: true }],
      ["set_call_service", { active: false, camera: false }],
    ]);
  });

  it("does nothing outside the Android app", () => {
    host.android = false;
    callService.update({ active: true, camera: true });
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it("swallows a refused start", async () => {
    host.invoke.mockRejectedValue("call service: not allowed from background");
    expect(() => callService.update({ active: true, camera: false })).not.toThrow();
    await settle();
    expect(host.invoke).toHaveBeenCalledTimes(1);
    expectConsole("warn", "Call service refused");
  });
});

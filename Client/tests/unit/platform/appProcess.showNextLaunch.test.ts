// A restart the app starts itself copies this process's `--minimized`, so the
// relaunch first asks the host to show the window on the next launch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, relaunch } = vi.hoisted(() => ({ invoke: vi.fn(), relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

const { appProcess } = await import("../../../src/platform/desktop/appProcess");

describe("appProcess.relaunch and the show-next-launch marker", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
    relaunch.mockReset().mockResolvedValue(undefined);
  });

  it("sets the marker before it relaunches", async () => {
    const order: string[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      order.push(cmd);
    });
    relaunch.mockImplementation(async () => {
      order.push("relaunch");
    });
    await appProcess.relaunch();
    expect(order).toEqual(["show_next_launch", "relaunch"]);
  });

  it("still relaunches when the marker cannot be set", async () => {
    invoke.mockRejectedValue(new Error("no host"));
    await appProcess.relaunch();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});

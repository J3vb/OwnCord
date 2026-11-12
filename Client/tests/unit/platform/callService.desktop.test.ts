// The desktop registry's call service talks to the host only in the Android
// app, where its host side loads on first use and sends one state at a time;
// a host refusal never reaches the caller.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallService, CallServiceState } from "../../../src/platform/contracts/callService";
import { createDeferred } from "../../helpers/deferred";

const host = vi.hoisted(() => ({ android: true, invoke: vi.fn(), warn: vi.fn() }));

vi.mock("@lib/hostPlatform", () => ({ isAndroidHost: () => host.android }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ warn: host.warn, debug: vi.fn() }),
}));
// The real `tryInvoke` stays in, so a rejected command is the typed error the
// member really gets.
vi.mock("@tauri-apps/api/core", () => ({ invoke: host.invoke }));

/** Let the host side load and every answer land. */
async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  await new Promise((r) => setTimeout(r, 0));
}

async function load(): Promise<CallService> {
  return (await import("../../../src/platform/desktop/callService")).callService;
}

const JOINED: CallServiceState = { active: true, camera: false, videoOnScreen: false };
const CAMERA_ON: CallServiceState = { active: true, camera: true, videoOnScreen: false };
const CAMERA_SHOWN: CallServiceState = { active: true, camera: true, videoOnScreen: true };
const LEFT: CallServiceState = { active: false, camera: false, videoOnScreen: false };

/** What the host was sent so far, in the order it got it. */
function sent(): unknown[] {
  return host.invoke.mock.calls.map(([command, state]) => {
    expect(command).toBe("set_call_service");
    return state;
  });
}

describe("desktop call service", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    host.android = true;
    host.invoke.mockReset();
    host.invoke.mockResolvedValue(null);
  });

  it("sends each state to the Android host in order", async () => {
    const callService = await load();
    const states = [JOINED, CAMERA_SHOWN, CAMERA_ON, LEFT];
    // The first ones are made while the host side is still loading.
    for (const state of states) callService.update(state);
    await settle();
    expect(sent()).toEqual(states);
  });

  it("sends a state only once the one before it was answered", async () => {
    // A camera goes on as its picture appears: sent together, the two could
    // reach the host either way round and leave the older state standing.
    const first = createDeferred<null>();
    host.invoke.mockReturnValueOnce(first.promise);
    const callService = await load();
    callService.update(CAMERA_ON);
    callService.update(CAMERA_SHOWN);
    await settle();
    expect(sent()).toEqual([CAMERA_ON]);

    first.resolve(null);
    await settle();
    expect(sent()).toEqual([CAMERA_ON, CAMERA_SHOWN]);
  });

  it("does nothing outside the Android app", async () => {
    host.android = false;
    const callService = await load();
    callService.update(CAMERA_SHOWN);
    await settle();
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it("swallows a refused start, and still sends what follows", async () => {
    host.invoke.mockRejectedValueOnce("call service: not allowed from background");
    const callService = await load();
    expect(() => callService.update(JOINED)).not.toThrow();
    callService.update(LEFT);
    await settle();
    expect(sent()).toEqual([JOINED, LEFT]);
    expect(host.warn).toHaveBeenCalledWith(
      "Call service refused; the call may stop in the background",
      "call service: not allowed from background",
    );
  });
});

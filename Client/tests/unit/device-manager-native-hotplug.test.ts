// WP LP-6a: the Linux host's device watch feeds the same debounced handler as
// the webview's `devicechange`, so a plug or unplug in a call falls back and
// restores through DeviceManager's existing rules.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loggerMock } from "../helpers/loggerMock";

const { prefs, nativeWatch } = vi.hoisted(() => ({
  prefs: new Map<string, string>(),
  nativeWatch: {
    linux: true,
    handlers: [] as Array<() => void>,
    subscribed: 0,
    released: 0,
  },
}));

vi.mock("@lib/prefs/preferences", () => ({
  loadPref: (key: string, defaultVal: unknown) => (prefs.has(key) ? prefs.get(key) : defaultVal),
  savePref: (key: string, val: unknown) => {
    prefs.set(key, val as string);
  },
}));
vi.mock("@lib/logger", () => loggerMock());
vi.mock("livekit-client", () => ({
  Room: Object.assign(vi.fn(), { getLocalDevices: vi.fn() }),
}));
vi.mock("@stores/voice.store", () => ({
  voiceStore: {
    getState: () => ({
      localMuted: false,
      localDeafened: false,
      localServerMuted: false,
      pttGated: false,
    }),
  },
}));

let outputs: Array<{ deviceId: string }> = [];
vi.mock("../../src/features/voice/native/devices", () => ({
  nativeAudioDevices: async (kind: string) => (kind === "audioinput" ? [] : outputs),
  onNativeDevicesChanged: (handler: () => void) => {
    if (!nativeWatch.linux) return null;
    nativeWatch.handlers.push(handler);
    nativeWatch.subscribed++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      nativeWatch.released++;
      nativeWatch.handlers = nativeWatch.handlers.filter((h) => h !== handler);
    };
  },
}));

import { DeviceManager } from "../../src/lib/voice/deviceManager";

describe("DeviceManager on the native device watch", () => {
  let dm: DeviceManager;
  let room: {
    state: string;
    localParticipant: { setMicrophoneEnabled: ReturnType<typeof vi.fn> };
    switchActiveDevice: ReturnType<typeof vi.fn>;
  };

  const nativeChange = async (): Promise<void> => {
    for (const handler of nativeWatch.handlers) handler();
    await vi.advanceTimersByTimeAsync(600);
  };
  const makeRoom = () => ({
    state: "connected",
    localParticipant: { setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined) },
    switchActiveDevice: vi.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    prefs.clear();
    nativeWatch.linux = true;
    nativeWatch.handlers = [];
    nativeWatch.subscribed = 0;
    nativeWatch.released = 0;
    outputs = [{ deviceId: "speakers" }, { deviceId: "headset" }];
    dm = new DeviceManager();
    room = makeRoom();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
  });

  afterEach(() => {
    dm.setRoom(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a native device change in a call falls back from an unplugged saved output and restores it on replug", async () => {
    prefs.set("audioOutputDevice", "headset");
    dm.setRoom(room as never);
    expect(nativeWatch.subscribed).toBe(1);

    outputs = [{ deviceId: "speakers" }];
    await nativeChange();
    expect(room.switchActiveDevice).toHaveBeenCalledWith("audiooutput", "");
    // The saved choice survives the fallback.
    expect(prefs.get("audioOutputDevice")).toBe("headset");

    room.switchActiveDevice.mockClear();
    outputs = [{ deviceId: "speakers" }, { deviceId: "headset" }];
    await nativeChange();
    expect(room.switchActiveDevice.mock.calls.filter((c) => c[1] === "headset")).toEqual([
      ["audiooutput", "headset"],
    ]);
  });

  it("a native device change after setRoom(null) does nothing and the subscription is released", async () => {
    prefs.set("audioOutputDevice", "headset");
    dm.setRoom(room as never);
    const [handler] = nativeWatch.handlers;
    dm.setRoom(null);
    expect(nativeWatch.released).toBe(1);
    expect(nativeWatch.handlers).toEqual([]);

    // An event that was already in flight lands after the release.
    outputs = [{ deviceId: "speakers" }];
    handler!();
    await vi.advanceTimersByTimeAsync(600);
    expect(room.switchActiveDevice).not.toHaveBeenCalled();

    // A room swap re-subscribes, and only the new room is driven.
    dm.setRoom(room as never);
    const swapped = makeRoom();
    dm.setRoom(swapped as never);
    expect(nativeWatch.subscribed).toBe(3);
    expect(nativeWatch.released).toBe(2);
    await nativeChange();
    expect(room.switchActiveDevice).not.toHaveBeenCalled();
    expect(swapped.switchActiveDevice).toHaveBeenCalledWith("audiooutput", "");
  });

  it("off Linux no native subscription is made", async () => {
    nativeWatch.linux = false;
    prefs.set("audioOutputDevice", "headset");
    dm.setRoom(room as never);
    expect(nativeWatch.subscribed).toBe(0);
    expect(navigator.mediaDevices.addEventListener).toHaveBeenCalledWith(
      "devicechange",
      expect.any(Function),
    );
    dm.setRoom(null);
    expect(nativeWatch.released).toBe(0);
  });
});

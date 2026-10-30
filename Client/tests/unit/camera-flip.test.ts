import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const switchVideoDevice = vi.hoisted(() => vi.fn());
vi.mock("@lib/livekitSession", () => ({ switchVideoDevice }));

import {
  cameraFlipAvailable,
  facingOf,
  flipCamera,
  pickFlipTarget,
} from "../../src/features/voice/cameraFlip";

function device(deviceId: string, label: string, facingMode?: string[]): MediaDeviceInfo {
  const info = { deviceId, label, kind: "videoinput", groupId: "", toJSON: () => ({}) };
  return (facingMode === undefined
    ? info
    : { ...info, getCapabilities: () => ({ facingMode }) }) as unknown as MediaDeviceInfo;
}

describe("facingOf", () => {
  it("reads the capabilities first, then a front/back label", () => {
    expect(facingOf(device("a", "camera2 0, facing back", ["user"]))).toBe("user");
    expect(facingOf(device("b", "", ["environment"]))).toBe("environment");
    expect(facingOf(device("c", "camera2 1, facing front"))).toBe("user");
    expect(facingOf(device("d", "Rear Camera"))).toBe("environment");
    expect(facingOf(device("e", "HD Webcam"))).toBeNull();
  });
});

describe("pickFlipTarget", () => {
  const cams = [
    { deviceId: "back-main", facing: "environment" as const },
    { deviceId: "front", facing: "user" as const },
    { deviceId: "back-wide", facing: "environment" as const },
  ];

  it("goes from the front camera to the first back one, and back again", () => {
    expect(pickFlipTarget(cams, "front")?.deviceId).toBe("back-main");
    expect(pickFlipTarget(cams, "back-wide")?.deviceId).toBe("front");
  });

  it("treats the default or a vanished camera as the front one", () => {
    expect(pickFlipTarget(cams, "")?.deviceId).toBe("back-main");
    expect(pickFlipTarget(cams, "unplugged")?.deviceId).toBe("back-main");
  });

  it("has nothing to flip to with cameras facing one way", () => {
    expect(pickFlipTarget([{ deviceId: "front", facing: "user" }], "front")).toBeNull();
  });
});

describe("on a phone", () => {
  let devices: MediaDeviceInfo[];

  beforeEach(() => {
    localStorage.clear();
    switchVideoDevice.mockReset();
    devices = [
      device("front", "camera2 1, facing front"),
      device("back", "camera2 0, facing back"),
    ];
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q }));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: () => Promise.resolve(devices) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers the flip only with a front and a back camera", async () => {
    expect(await cameraFlipAvailable()).toBe(true);
    devices = [devices[0]!];
    expect(await cameraFlipAvailable()).toBe(false);
  });

  it("does not offer it without a touch screen", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }));
    expect(await cameraFlipAvailable()).toBe(false);
  });

  it("a second tap during a switch does nothing", async () => {
    let finish!: () => void;
    switchVideoDevice.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const first = flipCamera();
    await flipCamera();
    await vi.waitFor(() => expect(switchVideoDevice).toHaveBeenCalledTimes(1));
    expect(switchVideoDevice).toHaveBeenCalledWith("back");
    finish();
    await first;
  });
});

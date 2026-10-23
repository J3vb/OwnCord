import { describe, it, expect, vi, beforeEach } from "vitest";

const linux = vi.hoisted(() => ({ value: true }));
vi.mock("./platform", () => ({ isLinuxDesktop: () => linux.value }));
const listDevices = vi.hoisted(() => vi.fn());
const listCameras = vi.hoisted(() => vi.fn());
const cameraSupport = vi.hoisted(() => vi.fn());
const watchDevices = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/desktop", () => ({
  desktop: { nativeVoice: { listDevices, listCameras, cameraSupport, watchDevices } },
}));

import {
  nativeAudioDevices,
  nativeCameraDevices,
  nativeCameraSupport,
  onNativeDevicesChanged,
} from "./devices";

beforeEach(() => {
  listDevices.mockReset();
  listDevices.mockResolvedValue({
    inputs: [{ id: "guid-mic", name: "USB Mic" }],
    outputs: [{ id: "guid-spk", name: "Speakers" }],
  });
  listCameras.mockReset();
  listCameras.mockResolvedValue([{ id: "/dev/video0", name: "HD Webcam", infrared: false }]);
  cameraSupport.mockReset();
  cameraSupport.mockResolvedValue({ available: true, missing: [] });
  watchDevices.mockReset();
});

describe("nativeAudioDevices", () => {
  it("maps the native list onto the MediaDeviceInfo shape per kind", async () => {
    linux.value = true;
    await expect(nativeAudioDevices("audioinput")).resolves.toEqual([
      { deviceId: "guid-mic", label: "USB Mic", kind: "audioinput" },
    ]);
    await expect(nativeAudioDevices("audiooutput")).resolves.toEqual([
      { deviceId: "guid-spk", label: "Speakers", kind: "audiooutput" },
    ]);
  });

  it("returns null off Linux so callers keep their web enumeration", async () => {
    linux.value = false;
    await expect(nativeAudioDevices("audioinput")).resolves.toBeNull();
    expect(listDevices).not.toHaveBeenCalled();
  });
});

describe("nativeCameraDevices", () => {
  it("maps the GStreamer camera list onto the MediaDeviceInfo shape", async () => {
    linux.value = true;
    await expect(nativeCameraDevices()).resolves.toEqual([
      { deviceId: "/dev/video0", label: "HD Webcam", kind: "videoinput" },
    ]);
  });

  it("marks an infrared sensor that shares the colour camera's name", async () => {
    linux.value = true;
    listCameras.mockResolvedValue([
      { id: "/dev/video0", name: "Integrated_Webcam_FHD: Integrat", infrared: false },
      { id: "/dev/video2", name: "Integrated_Webcam_FHD: Integrat", infrared: true },
    ]);
    await expect(nativeCameraDevices()).resolves.toEqual([
      { deviceId: "/dev/video0", label: "Integrated_Webcam_FHD: Integrat", kind: "videoinput" },
      {
        deviceId: "/dev/video2",
        label: "Integrated_Webcam_FHD: Integrat (infrared)",
        kind: "videoinput",
      },
    ]);
  });

  it("numbers cameras that still share a name, leaving unique and empty ones alone", async () => {
    linux.value = true;
    listCameras.mockResolvedValue([
      { id: "/dev/video0", name: "USB Camera", infrared: false },
      { id: "/dev/video2", name: "HD Webcam", infrared: false },
      { id: "/dev/video4", name: "USB Camera", infrared: false },
      { id: "/dev/video6", name: "", infrared: false },
      { id: "/dev/video8", name: "", infrared: true },
    ]);
    const labels = (await nativeCameraDevices())?.map((d) => d.label);
    expect(labels).toEqual(["USB Camera (1)", "HD Webcam", "USB Camera (2)", "", ""]);
  });

  it("returns null off Linux so callers keep their web enumeration", async () => {
    linux.value = false;
    await expect(nativeCameraDevices()).resolves.toBeNull();
    expect(listCameras).not.toHaveBeenCalled();
  });
});

describe("nativeCameraSupport", () => {
  it("reports the native backend's camera support", async () => {
    linux.value = true;
    cameraSupport.mockResolvedValue({ available: false, missing: ["v4l2src"] });
    await expect(nativeCameraSupport()).resolves.toEqual({
      available: false,
      missing: ["v4l2src"],
    });
  });

  it("returns null off Linux where the web path owns cameras", async () => {
    linux.value = false;
    await expect(nativeCameraSupport()).resolves.toBeNull();
    expect(cameraSupport).not.toHaveBeenCalled();
  });
});

describe("onNativeDevicesChanged", () => {
  it("on Linux subscribes to the host watch and calls the handler without the payload", () => {
    linux.value = true;
    const unsubscribe = vi.fn();
    watchDevices.mockReturnValue(unsubscribe);
    const handler = vi.fn();
    const stop = onNativeDevicesChanged(handler);
    expect(stop).toBe(unsubscribe);
    const deliver = watchDevices.mock.calls[0]![0] as (devices: unknown) => void;
    deliver({ inputs: [], outputs: [] });
    expect(handler.mock.calls).toEqual([[]]);
  });

  it("returns null off Linux and starts no watch", () => {
    linux.value = false;
    expect(onNativeDevicesChanged(vi.fn())).toBeNull();
    expect(watchDevices).not.toHaveBeenCalled();
  });
});

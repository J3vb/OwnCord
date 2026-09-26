import { describe, it, expect, vi, beforeEach } from "vitest";

const linux = vi.hoisted(() => ({ value: true }));
vi.mock("./platform", () => ({ isLinuxDesktop: () => linux.value }));
const listDevices = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/desktop", () => ({ desktop: { nativeVoice: { listDevices } } }));

import { nativeAudioDevices } from "./devices";

beforeEach(() => {
  listDevices.mockReset();
  listDevices.mockResolvedValue({
    inputs: [{ id: "guid-mic", name: "USB Mic" }],
    outputs: [{ id: "guid-spk", name: "Speakers" }],
  });
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

import { describe, expect, it, vi } from "vitest";
import { webviewMicId, type LinuxMicDeps } from "./linuxMic";

function input(deviceId: string, label: string, kind: MediaDeviceKind = "audioinput") {
  return { deviceId, label, kind, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

function deps(
  native: LinuxMicDeps["listNative"] extends () => Promise<infer R> ? R : never,
  webview: readonly MediaDeviceInfo[],
): LinuxMicDeps {
  return { listNative: async () => native, enumerate: async () => webview };
}

const failing = (): Promise<never> => Promise.reject(new Error("host gone"));

const NATIVE = [
  { deviceId: "alsa_input.usb-Blue", label: "Yeti Stereo Microphone", kind: "audioinput" as const },
  {
    deviceId: "alsa_input.pci",
    label: "Built-in Audio Analog Stereo",
    kind: "audioinput" as const,
  },
];

describe("webviewMicId", () => {
  it("finds the saved native microphone in the webview by its name", async () => {
    const id = await webviewMicId(
      "alsa_input.usb-Blue",
      deps(NATIVE, [
        input("w-1", "Built-in Audio Analog Stereo"),
        input("w-2", "Yeti Stereo Microphone "),
        input("w-3", "Yeti Stereo Microphone", "audiooutput"),
      ]),
    );
    expect(id).toBe("w-2");
  });

  it("keeps the saved id off Linux, where it already is the webview's", async () => {
    const enumerate = vi.fn(async () => [] as MediaDeviceInfo[]);
    expect(await webviewMicId("abc", { listNative: async () => null, enumerate })).toBe("abc");
    expect(enumerate).not.toHaveBeenCalled();
  });

  it("uses the default when nothing is saved, the device is gone or the name is unclear", async () => {
    const webview = [input("w-1", "Built-in Audio Analog Stereo")];
    expect(await webviewMicId("", deps(NATIVE, webview))).toBe("");
    expect(await webviewMicId("unplugged", deps(NATIVE, webview))).toBe("");
    expect(await webviewMicId("alsa_input.usb-Blue", deps(NATIVE, webview))).toBe("");
    const twins = [input("w-1", "Yeti Stereo Microphone"), input("w-2", "Yeti Stereo Microphone")];
    expect(await webviewMicId("alsa_input.usb-Blue", deps(NATIVE, twins))).toBe("");
  });

  it("uses the default when either listing fails", async () => {
    expect(
      await webviewMicId("alsa_input.pci", { listNative: failing, enumerate: async () => [] }),
    ).toBe("");
    expect(
      await webviewMicId("alsa_input.pci", { listNative: async () => NATIVE, enumerate: failing }),
    ).toBe("");
  });
});

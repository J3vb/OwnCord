// Scout test (owncord-robot-voice-after-reconnect): a call on the "Default"
// microphone must come back to the default device after an unplug and replug.
//
// Owner's report 2026-10-08: unplugging the USB microphone ends the capture;
// livekit-client's LocalParticipant.handleTrackEnded restarts it on
// `{deviceId: "default"}`, which is the OS default at that moment (the webcam
// mic). Replugging makes the USB mic the OS default again, but the running
// capture never ends, livekit's selectDefaultDevices skips audio input on
// Chromium, and DeviceManager.handleDeviceChange only restores a *named* saved
// device (deviceManager.ts:166-192). Settings keep showing "Default"; the call
// keeps sending the webcam mic until the user switches devices by hand.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockLoadPref, mockSavePref } = vi.hoisted(() => ({
  mockLoadPref: vi.fn((_key: string, defaultVal: unknown) => defaultVal),
  mockSavePref: vi.fn(),
}));
vi.mock("@lib/preferences", () => ({
  loadPref: (key: string, defaultVal: unknown) => mockLoadPref(key, defaultVal),
  savePref: (key: string, val: unknown) => mockSavePref(key, val),
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
const mockGetLocalDevices = vi.fn();
vi.mock("livekit-client", () => ({
  Track: { Source: { Microphone: "microphone" } },
  Room: Object.assign(vi.fn(), {
    getLocalDevices: (...args: unknown[]) => mockGetLocalDevices(...args),
  }),
}));
vi.mock("@stores/voice.store", () => ({
  voiceStore: {
    getState: () => ({ localMuted: false, localDeafened: false, localServerMuted: false }),
  },
}));
vi.mock("../../src/features/voice/native/devices", () => ({
  nativeAudioDevices: async () => null,
}));

import { DeviceManager } from "../../src/lib/deviceManager";

/** Chromium's device list after the USB mic is plugged back in: the OS
 *  default is the USB mic again (the `default` entry shares its groupId). */
const usbBackAsDefault = [
  { kind: "audioinput", deviceId: "default", label: "Default - USB Mic", groupId: "g-usb" },
  { kind: "audioinput", deviceId: "usb-mic", label: "USB Mic", groupId: "g-usb" },
  { kind: "audioinput", deviceId: "webcam-mic", label: "Webcam Mic", groupId: "g-webcam" },
];

describe("DeviceManager: default microphone after unplug and replug", () => {
  let dm: DeviceManager;
  let restartTrack: ReturnType<typeof vi.fn>;
  let switchActiveDevice: ReturnType<typeof vi.fn>;
  let room: any;

  beforeEach(() => {
    vi.useFakeTimers();
    // "Default" selected in Settings: no saved device id.
    mockLoadPref.mockImplementation((_key: string, defaultVal: unknown) => defaultVal);
    mockGetLocalDevices.mockResolvedValue(usbBackAsDefault);
    restartTrack = vi.fn().mockResolvedValue(undefined);
    switchActiveDevice = vi.fn().mockResolvedValue(undefined);
    // The live capture livekit restarted when the USB mic ended: it is the
    // webcam mic, though the room still calls its active device "default".
    // getSourceTrackSettings reads the capture behind the mic processor.
    const micTrack = {
      getSourceTrackSettings: () => ({ deviceId: "default", groupId: "g-webcam" }),
      restartTrack,
    };
    room = {
      state: "connected",
      localParticipant: {
        setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
        getTrackPublication: () => ({ track: micTrack }),
      },
      switchActiveDevice,
      getActiveDevice: () => "default",
    };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        enumerateDevices: vi.fn().mockResolvedValue(usbBackAsDefault),
      },
    });
    dm = new DeviceManager();
    dm.setRoom(room);
  });
  afterEach(() => {
    dm.setRoom(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("moves the live capture back to the OS default input when it no longer is it", async () => {
    const onChange = (navigator.mediaDevices.addEventListener as any).mock.calls.find(
      (c: unknown[]) => c[0] === "devicechange",
    )![1] as () => void;
    onChange();
    await vi.advanceTimersByTimeAsync(600);
    await vi.runAllTimersAsync();

    const movedCapture =
      restartTrack.mock.calls.length > 0 ||
      switchActiveDevice.mock.calls.some((c) => c[0] === "audioinput");
    expect(
      movedCapture,
      "the mic still captures the webcam mic while Settings show Default (USB Mic)",
    ).toBe(true);
  });

  it("leaves a capture that already is the OS default alone", async () => {
    room.localParticipant.getTrackPublication = () => ({
      track: {
        getSourceTrackSettings: () => ({ deviceId: "default", groupId: "g-usb" }),
        restartTrack,
      },
    });
    const onChange = (navigator.mediaDevices.addEventListener as any).mock.calls.find(
      (c: unknown[]) => c[0] === "devicechange",
    )![1] as () => void;
    onChange();
    await vi.advanceTimersByTimeAsync(600);
    await vi.runAllTimersAsync();

    expect(restartTrack).not.toHaveBeenCalled();
    expect(switchActiveDevice).not.toHaveBeenCalled();
  });
});

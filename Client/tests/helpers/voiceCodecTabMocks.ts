import { vi } from "vitest";
import { withOverrides } from "./voiceSessionMock";

/** Factory body for the native platform probe; Linux is read from `isLinuxDesktop` at call time. */
export function nativePlatformMock(isLinuxDesktop: () => boolean) {
  return {
    isLinuxDesktop: () => isLinuxDesktop(),
    isWindowsDesktop: () => false,
    isAndroidApp: () => false,
  };
}

/** The Linux case waits for the codec probe, so keep the device lists and hot-plug watch off the host. */
export function nativeDevicesMock() {
  return {
    nativeAudioDevices: async () => null,
    nativeCameraDevices: async () => null,
    nativeCameraSupport: async () => null,
    onNativeDevicesChanged: () => null,
  };
}

/** The real desktop module with the mic test refused, as when a call holds the capture. */
export async function desktopMicTestBusyMock(importOriginal: <T>() => Promise<T>) {
  const original = await importOriginal<typeof import("../../src/platform/desktop")>();
  return {
    ...original,
    desktop: {
      ...original.desktop,
      nativeVoice: {
        ...original.desktop.nativeVoice,
        onMicTestEvent: () => () => {},
        startMicTest: async () => {
          throw new Error("mic test unavailable during a call");
        },
      },
    },
  };
}

export function inertPushToTalkMock() {
  return {
    pushToTalk: {
      supported: async () => true,
      captureKeyPress: async () => 0,
      stop: async () => {},
      updateKey: async () => {},
    },
  };
}

export function reapplyAudioSessionMock() {
  return withOverrides({ reapplyAudioProcessing: vi.fn() });
}

/** A navigator whose media devices list nothing and hand out an empty stream. */
export function stubEmptyMediaDevices(): void {
  vi.stubGlobal("navigator", {
    mediaDevices: {
      enumerateDevices: vi.fn().mockResolvedValue([]),
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [], getAudioTracks: () => [] }),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
}

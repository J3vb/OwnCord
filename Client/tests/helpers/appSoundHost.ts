/**
 * Stand-ins for the app-sound tests' `vi.mock` factories: the native sound
 * host and the platform check, and a notifier that has granted permission.
 * Import them inside the factory (`async () => (await import(...)).x()`) and
 * statically in the test; both see the same `soundHost`.
 */
import { vi } from "vitest";

/** The native host: whether this is the Linux desktop, and its two calls. */
export const soundHost = {
  linux: false,
  playSound: vi.fn(),
  stopSound: vi.fn(),
};

/** `platform/desktop` with the native sound host and a silent notifier. */
export const soundHostDesktop = () => ({
  desktop: {
    nativeVoice: { playSound: soundHost.playSound, stopSound: soundHost.stopSound },
    notifier: {},
  },
});

/** `features/voice/native/platform`, following `soundHost.linux`. */
export const soundHostPlatform = () => ({
  isLinuxDesktop: () => soundHost.linux,
  isWindowsDesktop: () => false,
});

/** `platform/desktop` for a settings tab: a notifier that reads a granted permission. */
export const grantedNotifierDesktop = () => ({
  desktop: {
    notifier: {
      readsOsPermission: true,
      permissionGranted: vi.fn().mockResolvedValue(true),
      requestPermission: vi.fn(),
    },
  },
});

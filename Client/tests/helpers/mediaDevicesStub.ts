import { vi } from "vitest";

/** Replaces `navigator` with one whose `mediaDevices` lists no devices and takes listeners. */
export function stubEmptyMediaDevices(): void {
  vi.stubGlobal("navigator", {
    mediaDevices: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      enumerateDevices: vi.fn().mockResolvedValue([]),
    },
  });
}

import { vi } from "vitest";

export const createLocalVideoTrack = vi.fn();

export const createLocalScreenTracks = vi.fn();

export const loadPref = vi.fn();

// 120 fps is hidden for now (lib/voice/shareFps); the 120 fps tests turn it back on
// so the dormant 120 handling (one layer, balanced degradation, Auto's
// hardware rule) keeps its coverage.
export const offer120 = { value: false };

export const setH264GpuProfiles = vi.fn();

export const gpuProfiles = { value: false };

export const nativeCameraSupport = vi.fn();

export async function voiceShareFpsMock(importOriginal: <T>() => Promise<T>) {
  const actual = await importOriginal<typeof import("@lib/voice/shareFps")>();
  return {
    ...actual,
    offeredShareFps: (saved: number) =>
      offer120.value && saved === 120 ? 120 : actual.offeredShareFps(saved),
  };
}

export function voiceH264ProfileMock() {
  return { setH264GpuProfiles };
}

export async function voiceVideoCodecMock(importOriginal: <T>() => Promise<T>) {
  const actual = await importOriginal<typeof import("../../src/features/voice/videoCodec")>();
  return {
    ...actual,
    h264GpuPublish: (codec: string) => codec === "h264" && gpuProfiles.value,
  };
}

export async function livekitClientMock(importOriginal: <T>() => Promise<T>) {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return {
    ...actual,
    createLocalVideoTrack: (...args: unknown[]) => createLocalVideoTrack(...args) as unknown,
    createLocalScreenTracks: (...args: unknown[]) => createLocalScreenTracks(...args) as unknown,
  };
}

export function prefsPreferencesMock() {
  return {
    loadPref: (...args: unknown[]) => loadPref(...args) as unknown,
    savePref: vi.fn(),
  };
}

export function nativeDevicesMock() {
  return {
    nativeCameraSupport: (...args: unknown[]) => nativeCameraSupport(...args),
  };
}

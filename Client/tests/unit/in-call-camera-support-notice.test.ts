// Drives the in-call camera toggle against a Linux native room whose backend
// reports missing GStreamer support, asserting the user-visible notice text
// (the toast the callbacks surface) rather than any internal state.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lib/livekitSession", () => ({ updateCameraTrack: vi.fn() }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@lib/preferences", () => ({
  loadPref: vi.fn(() => ""),
  savePref: vi.fn(),
}));
vi.mock("@lib/streamQuality", () => ({
  getStreamQuality: vi.fn(() => "medium"),
}));
vi.mock("@lib/ws", () => ({ getWs: () => null }));

const nativeCameraSupport = vi.hoisted(() => vi.fn());
vi.mock("../../src/features/voice/native/devices", () => ({
  nativeCameraSupport: (...args: unknown[]) => nativeCameraSupport(...args),
}));

import { enableCamera } from "@lib/screenShare";
import { voiceStore } from "@stores/voice.store";

/** A room whose local participant carries the native capture method, which is
 *  how the shared camera code recognises the Linux host-capture path. */
function fakeTrack() {
  return {
    mediaStreamTrack: {
      removeEventListener: vi.fn(),
      addEventListener: vi.fn(),
      stop: vi.fn(),
      readyState: "live",
    },
    stop: vi.fn(),
    attach: vi.fn(),
    sid: "cam-track",
  };
}

function nativeRoom() {
  const createCameraTracks = vi.fn().mockResolvedValue([fakeTrack()]);
  const localParticipant = {
    createCameraTracks,
    publishTrack: vi.fn().mockResolvedValue(undefined),
    unpublishTrack: vi.fn().mockResolvedValue(undefined),
  };
  const room = {
    localParticipant,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as import("livekit-client").Room;
  return { room, createCameraTracks, localParticipant };
}

function deps(room: import("livekit-client").Room) {
  const ws = { send: vi.fn(() => 1), readyState: 1 } as unknown;
  return {
    getRoom: () => room,
    getWs: () => ws,
    onError: vi.fn(),
    publishTrack: vi.fn().mockResolvedValue(undefined),
    unpublishTrack: vi.fn().mockResolvedValue(undefined),
    reapplyAudioPipeline: vi.fn(),
  } as unknown as Parameters<typeof enableCamera>[1];
}

beforeEach(() => {
  nativeCameraSupport.mockReset();
  voiceStore.setState((prev) => ({ ...prev, localCamera: false }));
});

describe("in-call camera toggle on a Linux host missing GStreamer", () => {
  it("shows the install-packages notice and does not start a capture", async () => {
    const rig = nativeRoom();
    nativeCameraSupport.mockResolvedValue({ available: false, missing: ["v4l2src"] });
    const d = deps(rig.room);

    await enableCamera({ manualCameraTrack: null }, d);

    const shown = (d.onError as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(shown.some((m) => m.includes("gstreamer1.0-plugins-good"))).toBe(true);
    expect(shown.some((m) => m.includes("gstreamer1-plugins-good"))).toBe(true);
    expect(shown.some((m) => m.includes("gst-plugins-good"))).toBe(true);
    expect(rig.createCameraTracks).not.toHaveBeenCalled();
    expect(voiceStore.getState().localCamera).toBe(false);
  });

  it("starts the capture when support is available", async () => {
    const rig = nativeRoom();
    nativeCameraSupport.mockResolvedValue({ available: true, missing: [] });
    const d = deps(rig.room);

    await enableCamera({ manualCameraTrack: null }, d);

    expect(rig.createCameraTracks).toHaveBeenCalled();
    expect(rig.localParticipant.publishTrack).toHaveBeenCalled();
    expect((d.onError as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(voiceStore.getState().localCamera).toBe(true);
  });
});

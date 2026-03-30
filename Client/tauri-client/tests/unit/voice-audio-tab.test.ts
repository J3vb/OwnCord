import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lib/livekitSession", () => ({
  switchInputDevice: vi.fn().mockResolvedValue(undefined),
  switchOutputDevice: vi.fn().mockResolvedValue(undefined),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  reapplyAudioProcessing: vi.fn().mockResolvedValue(undefined),
}));

import { createVoiceAudioTab } from "@components/settings/VoiceAudioTab";

describe("VoiceAudioTab camera preview", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    localStorage.setItem("owncord:settings:videoInputDevice", '"camera-1"');

    vi.stubGlobal("AudioContext", class {
      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          frequencyBinCount: 32,
          getByteFrequencyData: vi.fn(),
        };
      }

      createMediaStreamSource() {
        return { connect: vi.fn() };
      }

      close() {
        return Promise.resolve();
      }
    });
  });

  it("does not restore a stale camera stream after the tab is aborted", async () => {
    let resolveVideo: ((stream: MediaStream) => void) | null = null;
    const stopVideoTrack = vi.fn();
    const videoStream = {
      getTracks: () => [{ stop: stopVideoTrack }],
    } as unknown as MediaStream;
    const audioStream = {
      getTracks: () => [],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "videoinput", deviceId: "camera-1", label: "Camera 1" },
        ]),
        getUserMedia: vi.fn().mockImplementation((constraints: MediaStreamConstraints) => {
          if (constraints.video && constraints.audio === false) {
            return new Promise<MediaStream>((resolve) => {
              resolveVideo = resolve;
            });
          }
          return Promise.resolve(audioStream);
        }),
      },
    });

    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const element = tab.build();
    document.body.appendChild(element);
    const preview = element.querySelector("video") as HTMLVideoElement;

    ac.abort();
    resolveVideo?.(videoStream);

    await vi.waitFor(() => {
      expect(stopVideoTrack).toHaveBeenCalledTimes(1);
      expect(preview.srcObject).toBeNull();
    });
  });

  it("does not restore a stale camera stream after the tab is cleaned up", async () => {
    let resolveVideo: ((stream: MediaStream) => void) | null = null;
    const stopVideoTrack = vi.fn();
    const videoStream = {
      getTracks: () => [{ stop: stopVideoTrack }],
    } as unknown as MediaStream;
    const audioStream = {
      getTracks: () => [],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "videoinput", deviceId: "camera-1", label: "Camera 1" },
        ]),
        getUserMedia: vi.fn().mockImplementation((constraints: MediaStreamConstraints) => {
          if (constraints.video && constraints.audio === false) {
            return new Promise<MediaStream>((resolve) => {
              resolveVideo = resolve;
            });
          }
          return Promise.resolve(audioStream);
        }),
      },
    });

    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const element = tab.build();
    document.body.appendChild(element);
    const preview = element.querySelector("video") as HTMLVideoElement;

    tab.cleanup();
    resolveVideo?.(videoStream);

    await vi.waitFor(() => {
      expect(stopVideoTrack).toHaveBeenCalledTimes(1);
      expect(preview.srcObject).toBeNull();
    });
  });
});
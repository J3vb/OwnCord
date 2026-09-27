import { afterEach, describe, expect, it, vi } from "vitest";
import { Room } from "livekit-client";

function fakeAudioTrack(): MediaStreamTrack {
  return {
    kind: "audio",
    id: "mic-track",
    enabled: true,
    muted: false,
    readyState: "live",
    getSettings: () => ({ deviceId: "usb-mic" }),
    getConstraints: () => ({}),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}

describe("RT-6: livekit capture device", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens the saved input on the first capture after switchActiveDevice with no mic published", async () => {
    const track = fakeAudioTrack();
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [track],
      getAudioTracks: () => [track],
      getVideoTracks: () => [],
    }));
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: MediaStreamTrack[] = []) {}
        getTracks = () => this.tracks;
      },
    );
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(async () => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    const room = new Room();
    await room.switchActiveDevice("audioinput", "usb-mic", false);
    await room.localParticipant.createTracks({ audio: true });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ deviceId: { exact: "usb-mic" } }),
      }),
    );
  });
});

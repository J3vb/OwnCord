import { describe, it, expect, vi } from "vitest";
import { VideoQuality, type Room } from "livekit-client";

vi.mock("../../lib/screenShare", () => ({
  getLocalCameraStream: vi.fn(() => "camera"),
  getLocalScreenshareStream: vi.fn(() => "screen"),
}));

import { getLocalCameraStream, getLocalScreenshareStream } from "../../lib/screenShare";
import { RemoteTracks } from "./remoteTracks";

function roomWith(identity: string, source: string, track: unknown): Room {
  return {
    remoteParticipants: new Map([
      [
        identity,
        {
          identity,
          getTrackPublication: (s: string) => (s === source ? { track } : undefined),
        },
      ],
    ]),
  } as unknown as Room;
}

function roomWithPublication(identity: string, source: string, publication: unknown): Room {
  return {
    remoteParticipants: new Map([
      [
        identity,
        {
          identity,
          getTrackPublication: (s: string) => (s === source ? publication : undefined),
        },
      ],
    ]),
  } as unknown as Room;
}

describe("RemoteTracks", () => {
  it("stores and clears both remote-video callbacks", () => {
    const tracks = new RemoteTracks(() => null);
    const onVideo = vi.fn();
    const onRemoved = vi.fn();
    tracks.setOnRemoteVideo(onVideo);
    tracks.setOnRemoteVideoRemoved(onRemoved);
    expect(tracks.onRemoteVideoCallback).toBe(onVideo);
    expect(tracks.onRemoteVideoRemovedCallback).toBe(onRemoved);
    tracks.clearOnRemoteVideo();
    expect(tracks.onRemoteVideoCallback).toBeNull();
    expect(tracks.onRemoteVideoRemovedCallback).toBeNull();
  });

  it("looks streams up on the room current at call time", () => {
    let room: Room | null = null;
    const tracks = new RemoteTracks(() => room);
    room = {} as Room;
    expect(tracks.getLocalCameraStream()).toBe("camera");
    expect(tracks.getLocalScreenshareStream()).toBe("screen");
    expect(getLocalCameraStream).toHaveBeenCalledWith(room);
    expect(getLocalScreenshareStream).toHaveBeenCalledWith(room);
  });

  describe("getRemoteVideoStats", () => {
    it("reads the receiver stats and bitrate of a user's screen share", async () => {
      const track = {
        currentBitrate: 5_800_000,
        getReceiverStats: vi.fn(async () => ({
          type: "video",
          frameWidth: 1920,
          frameHeight: 1080,
          framesDecoded: 600,
          timestamp: 1234,
          mimeType: "video/VP8",
          packetsLost: 1,
          packetsReceived: 999,
        })),
      };
      const tracks = new RemoteTracks(() => roomWith("user-7:abc", "screen_share", track));

      await expect(tracks.getRemoteVideoStats(7, "screenshare")).resolves.toEqual({
        frameWidth: 1920,
        frameHeight: 1080,
        framesDecoded: 600,
        timestamp: 1234,
        bitrate: 5_800_000,
        codec: "video/VP8",
        packetsLost: 1,
        packetsReceived: 999,
      });
    });

    it("is null without a room, a matching user, or receiver stats (the Linux native room)", async () => {
      await expect(
        new RemoteTracks(() => null).getRemoteVideoStats(7, "camera"),
      ).resolves.toBeNull();
      const other = new RemoteTracks(() =>
        roomWith("user-8", "camera", { getReceiverStats: vi.fn() }),
      );
      await expect(other.getRemoteVideoStats(7, "camera")).resolves.toBeNull();
      const native = new RemoteTracks(() => roomWith("user-7", "camera", {}));
      await expect(native.getRemoteVideoStats(7, "camera")).resolves.toBeNull();
    });
  });

  describe("setRemoteVideoView", () => {
    it("asks for the layer before enabling, and only disables a hidden tile", () => {
      const calls: string[] = [];
      const publication = {
        setEnabled: (on: boolean) => calls.push(`enabled ${String(on)}`),
        setVideoQuality: (q: VideoQuality) => calls.push(`quality ${String(q)}`),
        setVideoDimensions: (d: { width: number; height: number }) =>
          calls.push(`size ${String(d.width)}x${String(d.height)}`),
      };
      const tracks = new RemoteTracks(() =>
        roomWithPublication("user-7", "screen_share", publication),
      );

      tracks.setRemoteVideoView(7, "screenshare", {
        enabled: true,
        size: { width: 160, height: 90 },
      });
      tracks.setRemoteVideoView(7, "screenshare", { enabled: true });
      tracks.setRemoteVideoView(7, "screenshare", { enabled: false });
      expect(calls).toEqual([
        "size 160x90",
        "enabled true",
        `quality ${String(VideoQuality.HIGH)}`,
        "enabled true",
        "enabled false",
      ]);
    });

    it("does nothing without a room or a matching user", () => {
      const view = { enabled: false };
      expect(() =>
        new RemoteTracks(() => null).setRemoteVideoView(7, "camera", view),
      ).not.toThrow();
      const setEnabled = vi.fn();
      new RemoteTracks(() =>
        roomWithPublication("user-8", "camera", { setEnabled }),
      ).setRemoteVideoView(7, "camera", view);
      expect(setEnabled).not.toHaveBeenCalled();
    });
  });
});

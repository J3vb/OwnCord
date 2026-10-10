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

/** A room whose user has these sources published, each with a setSubscribed spy. */
function roomWithSources(identity: string, sources: string[]) {
  const pubs = new Map(sources.map((source) => [source, { setSubscribed: vi.fn() }]));
  const room = {
    remoteParticipants: new Map([
      [identity, { identity, getTrackPublication: (s: string) => pubs.get(s) }],
    ]),
  } as unknown as Room;
  return { room, pub: (source: string) => pubs.get(source)!.setSubscribed };
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
        isSubscribed: true,
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

    it("leaves a stream nobody watches alone: it is not subscribed", () => {
      const setEnabled = vi.fn();
      new RemoteTracks(() =>
        roomWithPublication("user-7", "camera", { isSubscribed: false, setEnabled }),
      ).setRemoteVideoView(7, "camera", { enabled: false });
      expect(setEnabled).not.toHaveBeenCalled();
    });
  });

  describe("watch (opt-in watching)", () => {
    it("watches nothing until asked", () => {
      const tracks = new RemoteTracks(() => null);
      expect(tracks.isWatched(7, "camera")).toBe(false);
      expect(tracks.isWatched(7, "screenshare")).toBe(false);
    });

    it("subscribes a screen share and its audio on watch, and unsubscribes both on stop", () => {
      const { room, pub } = roomWithSources("user-7:tok", [
        "camera",
        "screen_share",
        "screen_share_audio",
      ]);
      const tracks = new RemoteTracks(() => room);

      tracks.watch(7, "screenshare", true);
      expect(tracks.isWatched(7, "screenshare")).toBe(true);
      expect(tracks.isWatched(7, "camera")).toBe(false);
      expect(pub("screen_share")).toHaveBeenLastCalledWith(true);
      expect(pub("screen_share_audio")).toHaveBeenLastCalledWith(true);
      expect(pub("camera")).not.toHaveBeenCalled();

      tracks.watch(7, "screenshare", false);
      expect(tracks.isWatched(7, "screenshare")).toBe(false);
      expect(pub("screen_share")).toHaveBeenLastCalledWith(false);
      expect(pub("screen_share_audio")).toHaveBeenLastCalledWith(false);
    });

    it("subscribes only the camera for a camera watch", () => {
      const { room, pub } = roomWithSources("user-7", ["camera", "screen_share"]);
      const tracks = new RemoteTracks(() => room);
      tracks.watch(7, "camera", true);
      expect(pub("camera")).toHaveBeenCalledWith(true);
      expect(pub("screen_share")).not.toHaveBeenCalled();
    });

    it("remembers a watch made before the stream is published, with no room", () => {
      const tracks = new RemoteTracks(() => null);
      expect(() => tracks.watch(7, "camera", true)).not.toThrow();
      expect(tracks.isWatched(7, "camera")).toBe(true);
    });

    it("clearWatched forgets every watch", () => {
      const tracks = new RemoteTracks(() => null);
      tracks.watch(7, "screenshare", true);
      tracks.clearWatched();
      expect(tracks.isWatched(7, "screenshare")).toBe(false);
    });
  });
});

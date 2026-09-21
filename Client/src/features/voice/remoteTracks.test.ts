import { describe, it, expect, vi } from "vitest";
import type { Room } from "livekit-client";

vi.mock("../../lib/screenShare", () => ({
  getLocalCameraStream: vi.fn(() => "camera"),
  getLocalScreenshareStream: vi.fn(() => "screen"),
  getRemoteVideoStream: vi.fn(() => "remote"),
}));

import {
  getLocalCameraStream,
  getLocalScreenshareStream,
  getRemoteVideoStream,
} from "../../lib/screenShare";
import { RemoteTracks } from "./remoteTracks";

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
    expect(tracks.getRemoteVideoStream(4, "screenshare")).toBe("remote");
    expect(getLocalCameraStream).toHaveBeenCalledWith(room);
    expect(getLocalScreenshareStream).toHaveBeenCalledWith(room);
    expect(getRemoteVideoStream).toHaveBeenCalledWith(room, 4, "screenshare");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NativeScreenAudioTrack } from "./screenAudioTrack";

describe("NativeScreenAudioTrack", () => {
  const stopToken = vi.fn();
  const captureStream = vi.fn(() => ({ getVideoTracks: () => [{ stop: stopToken }] }));
  beforeEach(() => {
    stopToken.mockClear();
    captureStream.mockClear();
    (HTMLCanvasElement.prototype as unknown as { captureStream: unknown }).captureStream =
      captureStream;
  });
  afterEach(() => {
    delete (HTMLCanvasElement.prototype as unknown as { captureStream?: unknown }).captureStream;
  });

  it("is an audio track of the share's audio source", () => {
    const track = new NativeScreenAudioTrack(() => {});
    expect(track).toMatchObject({ kind: "audio", source: "screen_share_audio" });
  });

  it("calls onStop once however often it is stopped", () => {
    const onStop = vi.fn();
    const track = new NativeScreenAudioTrack(onStop);
    expect(track.isStopped).toBe(false);
    track.stop();
    track.stop();
    expect(track.isStopped).toBe(true);
    expect(onStop).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledWith(track);
  });

  it("makes its identity token lazily, stops it at once and keeps it", () => {
    const track = new NativeScreenAudioTrack(() => {});
    expect(captureStream).not.toHaveBeenCalled();
    const token = track.mediaStreamTrack;
    expect(stopToken).toHaveBeenCalledOnce();
    expect(track.mediaStreamTrack).toBe(token);
    expect(captureStream).toHaveBeenCalledOnce();
  });
});

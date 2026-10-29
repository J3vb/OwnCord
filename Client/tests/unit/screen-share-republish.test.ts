/**
 * The republish half of the live codec switch (WP M-5b): the same camera or
 * share capture goes out again with another codec, without stopping and
 * without telling the server anything.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Track } from "livekit-client";
import type { LocalTrack, LocalVideoTrack, Room } from "livekit-client";
import type { WsClient } from "@lib/ws";
import { expectConsole } from "../helpers/console";
import {
  cameraPublishOptions,
  republishVideo,
  screenVideoPublishOptions,
  disableScreenshare,
  type CameraTrackState,
  type ScreenTrackState,
  type VideoTrackDeps,
} from "@lib/screenShare";
import { voiceStore } from "@stores/voice.store";

const setH264GpuProfiles = vi.hoisted(() => vi.fn());
vi.mock("@lib/h264Profile", () => ({ setH264GpuProfiles }));
vi.mock("../../src/features/voice/videoCodec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/voice/videoCodec")>()),
  h264GpuPublish: (codec: string) => codec === "h264",
}));

vi.mock("@lib/preferences", () => ({
  loadPref: (_key: string, fallback: unknown) => fallback,
  savePref: vi.fn(),
}));

function fakeMediaStreamTrack(): MediaStreamTrack {
  return {
    readyState: "live",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function fakeVideo(): LocalVideoTrack & { stop: ReturnType<typeof vi.fn> } {
  return {
    kind: Track.Kind.Video,
    mediaStreamTrack: fakeMediaStreamTrack(),
    stop: vi.fn(),
  } as unknown as LocalVideoTrack & { stop: ReturnType<typeof vi.fn> };
}

function fakeAudio(): LocalTrack {
  return {
    kind: Track.Kind.Audio,
    mediaStreamTrack: fakeMediaStreamTrack(),
    stop: vi.fn(),
  } as unknown as LocalTrack;
}

/** A promise settled by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function rig() {
  const calls: string[] = [];
  const publishTrack = vi.fn((track: unknown, _options: unknown) => {
    calls.push(`publish:${(track as { kind: string }).kind}`);
    return Promise.resolve();
  });
  const unpublishTrack = vi.fn((track: unknown, _stop?: boolean) => {
    calls.push(`unpublish:${(track as { kind: string }).kind}`);
    return Promise.resolve();
  });
  const room = {
    localParticipant: {
      publishTrack,
      unpublishTrack,
      setCameraEnabled: vi.fn().mockResolvedValue(undefined),
      setScreenShareEnabled: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Room;
  const wsSend = vi.fn();
  const ws = { send: wsSend } as unknown as WsClient;
  const live = { room, ws };
  const deps: VideoTrackDeps = {
    getRoom: () => live.room,
    getWs: () => live.ws,
    onError: vi.fn(),
    reapplyAudioPipeline: vi.fn(),
  };
  return { room, publishTrack, unpublishTrack, wsSend, deps, live, calls };
}

function liveShare(): { state: ScreenTrackState; video: ReturnType<typeof fakeVideo> } {
  const video = fakeVideo();
  const state: ScreenTrackState = {
    manualScreenTracks: [video, fakeAudio()],
    announced: video,
    quality: "medium",
    fps: 30,
    preferred: "vp9",
    published: "vp9",
  };
  return { state, video };
}

function liveCamera(): { state: CameraTrackState; video: ReturnType<typeof fakeVideo> } {
  const video = fakeVideo();
  const state: CameraTrackState = {
    manualCameraTrack: video,
    announced: video,
    quality: "medium",
    preferred: "vp9",
    published: "vp9",
  };
  return { state, video };
}

beforeEach(() => {
  voiceStore.setState((prev) => ({ ...prev, localCamera: true, localScreenshare: true }));
});

describe("republishVideo", () => {
  beforeEach(() => setH264GpuProfiles.mockReset());

  it("unmarks the track when the live switch republishes it as VP8, before the publish", async () => {
    const r = rig();
    const { state, video } = liveShare();

    await expect(republishVideo("screen", state, r.deps, "vp8")).resolves.toBe(true);

    expect(setH264GpuProfiles).toHaveBeenCalledWith(video.mediaStreamTrack, false);
    expect(setH264GpuProfiles.mock.invocationCallOrder[0]!).toBeLessThan(
      r.publishTrack.mock.invocationCallOrder[0]!,
    );
  });

  it("marks the track again when it republishes as H.264", async () => {
    const r = rig();
    const { state, video } = liveCamera();

    await expect(republishVideo("camera", state, r.deps, "h264")).resolves.toBe(true);

    expect(setH264GpuProfiles).toHaveBeenCalledWith(video.mediaStreamTrack, true);
  });

  it("republishes the camera on the same track: unpublish without stopping, then the same options for the new codec", async () => {
    const r = rig();
    const { state, video } = liveCamera();

    await expect(republishVideo("camera", state, r.deps, "vp8")).resolves.toBe(true);

    expect(r.unpublishTrack).toHaveBeenCalledWith(video, false);
    expect(r.publishTrack).toHaveBeenCalledWith(video, cameraPublishOptions("vp8", "medium"));
    expect(r.calls).toEqual(["unpublish:video", "publish:video"]);
    expect(r.publishTrack.mock.calls[0]?.[1]).toMatchObject({
      videoCodec: "vp8",
      simulcast: true,
      videoEncoding: { maxBitrate: 1_700_000, maxFramerate: 30 },
    });
    expect(video.stop).not.toHaveBeenCalled();
    expect(state.published).toBe("vp8");
    expect(state.preferred).toBe("vp9");
    expect(r.wsSend).not.toHaveBeenCalled();
  });

  it("republishes only the share's video, with the share's options, and sends no message", async () => {
    const r = rig();
    const { state, video } = liveShare();
    const audio = state.manualScreenTracks[1]!;

    await expect(republishVideo("screen", state, r.deps, "vp8")).resolves.toBe(true);

    expect(r.unpublishTrack).toHaveBeenCalledTimes(1);
    expect(r.unpublishTrack).toHaveBeenCalledWith(video, false);
    expect(r.publishTrack).toHaveBeenCalledTimes(1);
    expect(r.publishTrack).toHaveBeenCalledWith(
      video,
      screenVideoPublishOptions("vp8", "medium", 30),
    );
    expect(r.publishTrack.mock.calls[0]?.[1]).toMatchObject({
      source: Track.Source.ScreenShare,
      videoCodec: "vp8",
      simulcast: true,
    });
    expect(audio.stop).not.toHaveBeenCalled();
    expect(state.published).toBe("vp8");
    expect(state.changing).toBe(false);
    expect(r.wsSend).not.toHaveBeenCalled();
  });

  it("publishes VP9 without simulcast layers", async () => {
    const r = rig();
    const { state } = liveShare();
    state.published = "vp8";

    await republishVideo("screen", state, r.deps, "vp9");

    const options = r.publishTrack.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.videoCodec).toBe("vp9");
    expect(options.simulcast).toBe(false);
    expect(options).not.toHaveProperty("screenShareSimulcastLayers");
  });

  it("marks the share as changing while it republishes, so Change source waits", async () => {
    const r = rig();
    const { state } = liveShare();
    const gate = deferred();
    r.publishTrack.mockReturnValueOnce(gate.promise);

    const run = republishVideo("screen", state, r.deps, "vp8");
    await Promise.resolve();
    await Promise.resolve();
    expect(state.changing).toBe(true);
    gate.resolve();
    await run;
    expect(state.changing).toBe(false);
  });

  it("does nothing for a share that is changing, not yet announced or gone", async () => {
    const r = rig();
    const busy = liveShare();
    busy.state.changing = true;
    const starting = liveShare();
    starting.state.announced = undefined;
    const gone = liveShare();
    gone.state.manualScreenTracks = [];

    for (const { state } of [busy, starting, gone]) {
      await expect(republishVideo("screen", state, r.deps, "vp8")).resolves.toBe(false);
    }
    expect(r.unpublishTrack).not.toHaveBeenCalled();
    expect(r.publishTrack).not.toHaveBeenCalled();
  });

  // Edge case 1 (design note M-5): the stop lands between the unpublish and
  // the publish.
  describe("a stop-share between the unpublish and the publish", () => {
    it("does not publish again: the stop already released the tracks and said false", async () => {
      const r = rig();
      const { state, video } = liveShare();
      const unpublished = deferred();
      r.unpublishTrack.mockReturnValueOnce(unpublished.promise);

      const run = republishVideo("screen", state, r.deps, "vp8");
      await Promise.resolve();
      // The user stops sharing while the republish waits for its unpublish.
      await disableScreenshare(state, r.deps);
      unpublished.resolve();

      await expect(run).resolves.toBe(false);
      expect(r.publishTrack).not.toHaveBeenCalled();
      expect(video.stop).toHaveBeenCalled();
      expect(r.wsSend).toHaveBeenCalledTimes(1);
      expect(r.wsSend).toHaveBeenCalledWith({
        type: "voice_screenshare",
        payload: { enabled: false },
      });
      expect(state.published).toBeUndefined();
    });

    it("undoes a publish that lands after the stop and sends no voice_screenshare(true)", async () => {
      const r = rig();
      const { state, video } = liveShare();
      const published = deferred();
      r.publishTrack.mockReturnValueOnce(published.promise);

      const run = republishVideo("screen", state, r.deps, "vp8");
      await vi.waitFor(() => expect(r.publishTrack).toHaveBeenCalled());
      await disableScreenshare(state, r.deps);
      r.unpublishTrack.mockClear();
      video.stop.mockClear();
      published.resolve();

      await expect(run).resolves.toBe(false);
      // The stop's unpublish may have run before this publish landed.
      expect(r.unpublishTrack).toHaveBeenCalledWith(video.mediaStreamTrack);
      expect(video.stop).toHaveBeenCalled();
      expect(r.wsSend).toHaveBeenCalledTimes(1);
      expect(r.wsSend).not.toHaveBeenCalledWith({
        type: "voice_screenshare",
        payload: { enabled: true },
      });
      expect(state.published).toBeUndefined();
      expect(state.changing).toBe(false);
    });
  });

  describe("superseded", () => {
    it("a reconnect (generation bump) after the unpublish ends the run without touching anything", async () => {
      const r = rig();
      const { state, video } = liveCamera();
      const unpublished = deferred();
      r.unpublishTrack.mockReturnValueOnce(unpublished.promise);

      const run = republishVideo("camera", state, r.deps, "vp8");
      state.generation = (state.generation ?? 0) + 1;
      unpublished.resolve();

      await expect(run).resolves.toBe(false);
      expect(r.publishTrack).not.toHaveBeenCalled();
      expect(video.stop).not.toHaveBeenCalled();
      expect(r.deps.onError).not.toHaveBeenCalled();
    });

    it("a new room or socket after the publish undoes it", async () => {
      const r = rig();
      const { state, video } = liveCamera();
      const published = deferred();
      r.publishTrack.mockReturnValueOnce(published.promise);

      const run = republishVideo("camera", state, r.deps, "vp8");
      await vi.waitFor(() => expect(r.publishTrack).toHaveBeenCalled());
      r.live.ws = { send: vi.fn() } as unknown as WsClient;
      published.resolve();

      await expect(run).resolves.toBe(false);
      expect(video.stop).toHaveBeenCalled();
      expect(state.published).toBe("vp9");
    });

    it("a failure after being superseded leaves the newer state alone", async () => {
      const r = rig();
      const { state } = liveShare();
      const failing = deferred();
      r.publishTrack.mockReturnValueOnce(failing.promise);

      const run = republishVideo("screen", state, r.deps, "vp8");
      await vi.waitFor(() => expect(r.publishTrack).toHaveBeenCalled());
      state.generation = (state.generation ?? 0) + 1;
      failing.reject(new Error("closed"));

      await expect(run).resolves.toBe(false);
      expect(r.wsSend).not.toHaveBeenCalled();
      expect(r.deps.onError).not.toHaveBeenCalled();
      expectConsole("warn", /Superseded codec switch failed/);
    });
  });

  describe("a failed republish takes the normal disable path", () => {
    it("ends the share: stops it, says false, shows the existing error", async () => {
      const r = rig();
      const { state, video } = liveShare();
      r.publishTrack.mockRejectedValueOnce(new Error("negotiation failed"));

      await expect(republishVideo("screen", state, r.deps, "vp8")).resolves.toBe(false);

      expectConsole("error", /Failed to republish/);
      expect(video.stop).toHaveBeenCalled();
      expect(r.wsSend).toHaveBeenCalledWith({
        type: "voice_screenshare",
        payload: { enabled: false },
      });
      expect(r.deps.onError).toHaveBeenCalledWith("Failed to start screen sharing");
      expect(voiceStore.getState().localScreenshare).toBe(false);
      expect(state.announced).toBeUndefined();
    });

    it("ends the camera the same way", async () => {
      const r = rig();
      const { state, video } = liveCamera();
      r.unpublishTrack.mockRejectedValueOnce(new Error("gone"));

      await expect(republishVideo("camera", state, r.deps, "vp8")).resolves.toBe(false);

      expectConsole("error", /Failed to republish/);
      expect(video.stop).toHaveBeenCalled();
      expect(r.wsSend).toHaveBeenCalledWith({ type: "voice_camera", payload: { enabled: false } });
      expect(r.deps.onError).toHaveBeenCalledWith("Failed to start camera");
      expect(voiceStore.getState().localCamera).toBe(false);
    });
  });
});

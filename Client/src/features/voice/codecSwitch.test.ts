import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVideoTrack } from "livekit-client";
import type { PublishCodec } from "./videoCodec";
import type { CameraTrackState, ScreenTrackState, VideoTrackDeps } from "../../lib/screenShare";

const republish = vi.hoisted(() => vi.fn());

vi.mock("../../lib/screenShare", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/screenShare")>();
  return { ...actual, republishVideo: republish };
});

const { voiceStore } = await import("../../stores/voice.store");
const {
  CodecSwitchController,
  SWITCH_BUSY_RETRY_MS,
  SWITCH_DOWN_MS,
  SWITCH_UP_MIN_GAP_MS,
  SWITCH_UP_STABLE_MS,
} = await import("./codecSwitch");

const VP8_PEER = ["vp8", "h264"];
const VP9_PEER = ["vp8", "h264", "vp9"];

/** Put `peers` (user id -> decode list) in the current channel. */
function setPeers(peers: ReadonlyMap<number, readonly string[]>): void {
  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId: 4,
    voiceUsers: new Map([
      [
        4,
        new Map([...peers.keys()].map((id) => [id, { userId: id, username: `u${id}` } as never])),
      ],
    ]),
    peerVideoDecode: new Map(peers),
  }));
  voiceStore.flush();
}

const join = (id = 2, list: readonly string[] = VP8_PEER) => setPeers(new Map([[id, list]]));
const leave = () => setPeers(new Map());

/** Every controller a test made, stopped after it so a failure cannot leak a subscription. */
const made: Array<InstanceType<typeof CodecSwitchController>> = [];

interface Rig {
  controller: InstanceType<typeof CodecSwitchController>;
  screen: ScreenTrackState;
  camera: CameraTrackState;
  /** Each republish call, as `${kind}:${codec}`. */
  calls: string[];
  /** Resolves every pending republish with true. */
  releaseAll: () => Promise<void>;
}

/** `delayed`: a republish stays in flight until `releaseAll`. */
function rig(opts: { screen?: PublishCodec; camera?: PublishCodec; delayed?: boolean } = {}): Rig {
  const shareVideo = {} as LocalVideoTrack;
  const cameraVideo = {} as LocalVideoTrack;
  const screen: ScreenTrackState = { manualScreenTracks: [], generation: 0 };
  const camera: CameraTrackState = { manualCameraTrack: null, generation: 0 };
  if (opts.screen !== undefined) {
    screen.manualScreenTracks = [shareVideo];
    screen.announced = shareVideo;
    screen.quality = "medium";
    screen.fps = 30;
    screen.preferred = "vp9";
    screen.published = opts.screen;
  }
  if (opts.camera !== undefined) {
    camera.manualCameraTrack = cameraVideo;
    camera.announced = cameraVideo;
    camera.quality = "medium";
    camera.preferred = "vp9";
    camera.published = opts.camera;
  }
  const calls: string[] = [];
  const pending: Array<() => void> = [];
  republish
    .mockReset()
    .mockImplementation(
      (
        kind: "camera" | "screen",
        state: CameraTrackState | ScreenTrackState,
        _d: unknown,
        codec: PublishCodec,
      ) => {
        calls.push(`${kind}:${codec}`);
        const finish = (): boolean => {
          state.published = codec;
          return true;
        };
        if (opts.delayed !== true) return Promise.resolve(finish());
        return new Promise<boolean>((resolve) => pending.push(() => resolve(finish())));
      },
    );
  const controller = new CodecSwitchController({
    getCameraState: () => camera,
    getScreenState: () => screen,
    getDeps: () => ({}) as VideoTrackDeps,
  });
  made.push(controller);
  return {
    controller,
    screen,
    camera,
    calls,
    releaseAll: async () => {
      for (const done of pending.splice(0)) done();
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

/** A peer joins and leaves `times` times, 2 s apart. */
async function flap(times: number): Promise<void> {
  if (times === 0) return;
  join();
  await vi.advanceTimersByTimeAsync(2000);
  leave();
  await vi.advanceTimersByTimeAsync(2000);
  await flap(times - 1);
}

beforeEach(() => {
  vi.useFakeTimers();
  leave();
});

afterEach(() => {
  for (const controller of made.splice(0)) controller.stop();
  vi.useRealTimers();
});

describe("CodecSwitchController", () => {
  it("switches a VP9 share down to VP8 1.5 s after a viewer without VP9 joins", async () => {
    const r = rig({ screen: "vp9" });
    r.controller.kick();

    join();
    await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS - 1);
    expect(r.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(r.calls).toEqual(["screen:vp8"]);
    r.controller.stop();
  });

  it("switches a camera the same way, and each kind on its own", async () => {
    const r = rig({ screen: "vp9", camera: "vp9" });
    r.controller.kick();
    r.screen.preferred = "vp8";
    r.screen.published = "vp8";

    join();
    await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS);

    expect(r.calls).toEqual(["camera:vp8"]);
    r.controller.stop();
  });

  it("leaves a share alone when the new viewer also decodes VP9", async () => {
    const r = rig({ screen: "vp9" });
    r.controller.kick();

    join(2, VP9_PEER);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(r.calls).toEqual([]);
    r.controller.stop();
  });

  it("switches back up only after 10 s of stability, and 30 s after the last switch", async () => {
    const r = rig({ screen: "vp9" });
    r.controller.kick();
    join();
    await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS);
    expect(r.calls).toEqual(["screen:vp8"]);

    // The viewer leaves 0.5 s after the switch: 10 s of stability is not
    // enough, because the last switch was less than 30 s ago.
    await vi.advanceTimersByTimeAsync(500);
    leave();
    await vi.advanceTimersByTimeAsync(SWITCH_UP_STABLE_MS);
    expect(r.calls).toEqual(["screen:vp8"]);
    await vi.advanceTimersByTimeAsync(SWITCH_UP_MIN_GAP_MS - 500 - SWITCH_UP_STABLE_MS - 1);
    expect(r.calls).toEqual(["screen:vp8"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls).toEqual(["screen:vp8", "screen:vp9"]);
    r.controller.stop();
  });

  it("waits the full 10 s when the last switch is long past", async () => {
    const r = rig({ screen: "vp8" });
    r.controller.kick();

    leave();
    voiceStore.setState((prev) => prev);
    // The pick is VP9 from the start; the kick found it, so it waits 10 s.
    await vi.advanceTimersByTimeAsync(SWITCH_UP_STABLE_MS - 1);
    expect(r.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls).toEqual(["screen:vp9"]);
    r.controller.stop();
  });

  // Edge case 2 (design note M-5): a peer joining and leaving repeatedly
  // while sharing alone with VP9.
  it("a peer flapping every 2 s causes one switch down, no switch up and no overlapping flights", async () => {
    const r = rig({ screen: "vp9", delayed: true });
    r.controller.kick();

    await flap(6);
    // The flight began at 1.5 s and is still going: nothing overlapped it.
    expect(r.calls).toEqual(["screen:vp8"]);

    await r.releaseAll();
    // The peer is gone now, so the pick is VP9 again, which waits for stability.
    expect(r.calls).toEqual(["screen:vp8"]);
    join();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.calls).toEqual(["screen:vp8"]);
  });

  it("a peer flapping every 2 s over quick flights also switches once and never back up", async () => {
    const r = rig({ screen: "vp9" });
    r.controller.kick();

    await flap(10);

    expect(r.calls).toEqual(["screen:vp8"]);
  });

  it("a change during a flight runs the pick again once it ends", async () => {
    const r = rig({ screen: "vp9", delayed: true });
    r.controller.kick();
    join();
    await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS);
    expect(r.calls).toEqual(["screen:vp8"]);

    // The viewer leaves while the republish is still going: no second flight.
    leave();
    await vi.advanceTimersByTimeAsync(SWITCH_UP_STABLE_MS * 4);
    expect(r.calls).toEqual(["screen:vp8"]);

    await r.releaseAll();
    expect(r.calls).toEqual(["screen:vp8"]);
    // Re-run at the end of the flight: the pick is VP9 again, and the 30 s
    // gap since the switch has long passed.
    await vi.advanceTimersByTimeAsync(SWITCH_UP_STABLE_MS);
    expect(r.calls).toEqual(["screen:vp8", "screen:vp9"]);
    r.controller.stop();
  });

  it("does nothing while an enable is in flight, and acts once the enable's kick finds it published", async () => {
    const r = rig();
    r.controller.kick();
    join();
    await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS * 4);
    expect(r.calls).toEqual([]);

    // The enable finishes with VP9 resolved before the viewer joined.
    const track = {} as LocalVideoTrack;
    r.screen.manualScreenTracks = [track];
    r.screen.announced = track;
    r.screen.quality = "medium";
    r.screen.preferred = "vp9";
    r.screen.published = "vp9";
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS);

    expect(r.calls).toEqual(["screen:vp8"]);
    r.controller.stop();
  });

  it("does nothing on Linux, where the preferred and published codec is always VP8", async () => {
    const r = rig({ screen: "vp8", camera: "vp8" });
    r.screen.preferred = "vp8";
    r.camera.preferred = "vp8";
    r.controller.kick();

    join();
    await vi.advanceTimersByTimeAsync(60_000);
    leave();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(r.calls).toEqual([]);
    r.controller.stop();
  });

  it("waits out a Change source or Quality change, then switches", async () => {
    const r = rig({ screen: "vp9" });
    r.screen.changing = true;
    r.controller.kick();

    join();
    await vi.advanceTimersByTimeAsync(SWITCH_BUSY_RETRY_MS * 3);
    expect(r.calls).toEqual([]);

    r.screen.changing = false;
    await vi.advanceTimersByTimeAsync(SWITCH_BUSY_RETRY_MS);
    expect(r.calls).toEqual(["screen:vp8"]);
    r.controller.stop();
  });

  describe("stop", () => {
    it("clears the timers, so a pending switch never runs", async () => {
      const r = rig({ screen: "vp9" });
      r.controller.kick();
      join();

      r.controller.stop();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(r.calls).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("drops the subscription: later roster changes do nothing until the next kick", async () => {
      const r = rig({ screen: "vp9" });
      r.controller.kick();
      r.controller.stop();

      join();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(r.calls).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a flight cut short by the teardown schedules nothing when it ends", async () => {
      const r = rig({ screen: "vp9", delayed: true });
      r.controller.kick();
      join();
      await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS);
      expect(r.calls).toEqual(["screen:vp8"]);
      leave();

      r.controller.stop();
      await r.releaseAll();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(r.calls).toEqual(["screen:vp8"]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("can be armed again by the next session's kick", async () => {
      const r = rig({ screen: "vp9" });
      r.controller.kick();
      r.controller.stop();

      r.controller.kick();
      join();
      await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS);

      expect(r.calls).toEqual(["screen:vp8"]);
      r.controller.stop();
    });
  });

  it("a stopped share (no longer announced) is not switched", async () => {
    const r = rig({ screen: "vp9" });
    r.controller.kick();
    join();

    r.screen.announced = undefined;
    r.screen.manualScreenTracks = [];
    await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS * 2);

    expect(r.calls).toEqual([]);
    r.controller.stop();
  });
});

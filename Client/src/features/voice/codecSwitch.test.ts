import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVideoTrack } from "livekit-client";
import type { PublishCodec } from "./videoCodec";
import type { ShareSenderSample } from "./shareSenderStats";
import type { CameraTrackState, ScreenTrackState, VideoTrackDeps } from "../../lib/screenShare";

const republish = vi.hoisted(() => vi.fn());
const isLinuxDesktop = vi.hoisted(() => vi.fn(() => false));
const nativeVp9 = vi.hoisted(() => ({ value: false }));

vi.mock("./native/platform", () => ({
  isLinuxDesktop: () => isLinuxDesktop(),
  isWindowsDesktop: () => false,
}));
vi.mock("./native/videoCodecs", () => ({
  nativeVideoCodecs: () => Promise.resolve({ h264: false, vp9: nativeVp9.value, decode: [] }),
}));

vi.mock("../../lib/screenShare", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/screenShare")>();
  return { ...actual, republishVideo: republish };
});

const { voiceStore } = await import("../../stores/voice.store");
const { resolveCodecChoice } = await import("./videoCodec");
const { channelPeerDecode } = await import("./peerDecode");
const {
  CodecSwitchController,
  SOFTWARE_CHECK_MS,
  SWITCH_BUSY_RETRY_MS,
  SWITCH_DOWN_MS,
  SWITCH_UP_MIN_GAP_MS,
  SWITCH_UP_STABLE_MS,
} = await import("./codecSwitch");

const VP8_PEER = ["vp8", "h264"];
const VP9_PEER = ["vp8", "h264", "vp9"];
const H265_PEER = ["vp8", "h264", "h265"];

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
function rig(
  opts: {
    screen?: PublishCodec;
    camera?: PublishCodec;
    delayed?: boolean;
    preferred?: PublishCodec;
    /** What the screen share's sender reports; none reads as null. */
    sample?: ShareSenderSample | null;
    /** Replaces the sender sample read (a deferred or failing one). */
    readSample?: () => Promise<ShareSenderSample | null>;
    onSwitchError?: (err: unknown) => void;
    /** A republish rejects with this. */
    failWith?: Error;
  } = {},
): Rig {
  const preferred = opts.preferred ?? "vp9";
  const shareVideo = {} as LocalVideoTrack;
  const cameraVideo = {} as LocalVideoTrack;
  const screen: ScreenTrackState = { manualScreenTracks: [], generation: 0 };
  const camera: CameraTrackState = { manualCameraTrack: null, generation: 0 };
  if (opts.screen !== undefined) {
    screen.manualScreenTracks = [shareVideo];
    screen.announced = shareVideo;
    screen.quality = "medium";
    screen.fps = 30;
    screen.preferred = preferred;
    screen.published = opts.screen;
  }
  if (opts.camera !== undefined) {
    camera.manualCameraTrack = cameraVideo;
    camera.announced = cameraVideo;
    camera.quality = "medium";
    camera.preferred = preferred;
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
        if (opts.failWith !== undefined) return Promise.reject(opts.failWith);
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
    readScreenSenderSample:
      opts.readSample ?? (() => Promise.resolve(opts.sample === undefined ? null : opts.sample)),
    onSwitchError: opts.onSwitchError ?? (() => {}),
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
  isLinuxDesktop.mockReturnValue(false);
  nativeVp9.value = false;
  localStorage.clear();
  for (const controller of made.splice(0)) controller.stop();
  vi.useRealTimers();
});

function h264Rig(sample: ShareSenderSample | null): ReturnType<typeof rig> {
  const r = rig({ screen: "h264", preferred: "h264", sample });
  r.controller.kick();
  return r;
}

describe("CodecSwitchController software H.264 check", () => {
  it("republishes an OpenH264 share as VP8 after SOFTWARE_CHECK_MS", async () => {
    const r = h264Rig({ encoder: "OpenH264", codec: "video/H264" });
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS - 1);
    expect(r.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls).toEqual(["screen:vp8"]);
    // The pick stays VP8: nothing flips the share back.
    await vi.advanceTimersByTimeAsync(SWITCH_UP_MIN_GAP_MS * 2);
    expect(r.calls).toEqual(["screen:vp8"]);
  });

  it.each(["ExternalEncoder", "MediaFoundationVideoEncodeAccelerator"])(
    "leaves a share on the hardware encoder %s alone",
    async (encoder) => {
      const r = h264Rig({ encoder });
      await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS * 3);
      expect(r.calls).toEqual([]);
    },
  );

  it("does nothing without a sample or an encoder name", async () => {
    const none = h264Rig(null);
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS * 3);
    expect(none.calls).toEqual([]);
    none.controller.stop();
    const unnamed = h264Rig({ sentFps: 30 });
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS * 3);
    expect(unnamed.calls).toEqual([]);
  });

  it("is cancelled by stop before the timer fires", async () => {
    const r = h264Rig({ encoder: "OpenH264" });
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS - 1);
    r.controller.stop();
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS);
    expect(r.calls).toEqual([]);
  });

  it("does not stack a second check on a second kick", async () => {
    const r = h264Rig({ encoder: "OpenH264" });
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS / 2);
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS / 2);
    expect(r.calls).toEqual(["screen:vp8"]);
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS * 3);
    expect(r.calls).toEqual(["screen:vp8"]);
  });

  it("checks a hardware share once, not again on later kicks", async () => {
    const r = h264Rig({ encoder: "ExternalEncoder" });
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS);
    r.controller.kick();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("looks once more when the first sample names no encoder", async () => {
    const opts: { screen: PublishCodec; preferred: PublishCodec; sample: ShareSenderSample } = {
      screen: "h264",
      preferred: "h264",
      sample: { sentFps: 2 },
    };
    const r = rig(opts);
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS);
    expect(r.calls).toEqual([]);
    opts.sample = { encoder: "OpenH264" };
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS);
    expect(r.calls).toEqual(["screen:vp8"]);
  });

  it("does not carry an OpenH264 share's VP8 over to the next share", async () => {
    const r = h264Rig({ encoder: "OpenH264" });
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS);
    expect(r.calls).toEqual(["screen:vp8"]);
    const next = {} as LocalVideoTrack;
    r.screen.manualScreenTracks = [next];
    r.screen.announced = next;
    r.screen.preferred = "vp9";
    r.screen.published = "vp9";
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SWITCH_UP_MIN_GAP_MS * 2);
    expect(r.calls).toEqual(["screen:vp8"]);
  });

  it("does not check on the Linux desktop", async () => {
    isLinuxDesktop.mockReturnValue(true);
    const r = h264Rig({ encoder: "OpenH264" });
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS * 3);
    expect(r.calls).toEqual([]);
  });

  it("does not check a VP8 share", async () => {
    const r = rig({ screen: "vp8", preferred: "vp8", sample: { encoder: "OpenH264" } });
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS * 3);
    expect(r.calls).toEqual([]);
  });
});

describe("CodecSwitchController", () => {
  it("never moves an H.264 share, whatever a peer's list says", async () => {
    const r = rig({ screen: "h264" });
    r.screen.preferred = "h264";
    r.controller.kick();
    join(2, ["vp8"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.calls).toEqual([]);
  });

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

  it("switches an H.265 share down to VP8 when a viewer without H.265 joins, and back up", async () => {
    const r = rig({ screen: "h265", preferred: "h265" });
    r.controller.kick();
    join(2, VP9_PEER);
    await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS);
    expect(r.calls).toEqual(["screen:vp8"]);
    leave();
    await vi.advanceTimersByTimeAsync(SWITCH_UP_MIN_GAP_MS);
    expect(r.calls).toEqual(["screen:vp8", "screen:h265"]);
    r.controller.stop();
  });

  it("leaves an H.265 share alone when the new viewer decodes H.265", async () => {
    const r = rig({ screen: "h265", camera: "h265", preferred: "h265" });
    r.controller.kick();
    join(2, H265_PEER);
    await vi.advanceTimersByTimeAsync(SWITCH_UP_MIN_GAP_MS);
    expect(r.calls).toEqual([]);
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

  it("a Linux VP9 share drops to VP8 when a baseline peer joins", async () => {
    // The native engine reports a VP9 encoder and VP9 is the saved choice, so
    // the codec comes from the real resolver rather than being set by hand
    // (before WP M-11b it was VP8 on Linux and nothing could switch).
    isLinuxDesktop.mockReturnValue(true);
    nativeVp9.value = true;
    localStorage.setItem("owncord:settings:videoCodec", JSON.stringify("vp9"));
    const track = { getSettings: () => ({ width: 1280, height: 720 }) } as MediaStreamTrack;
    const choice = await resolveCodecChoice(track, 30, 2_500_000, channelPeerDecode);
    expect(choice).toEqual({ preferred: "vp9", codec: "vp9" });

    // Linux native shares and cameras are live (announced, quality set) as on
    // the web, so the controller sees them (WP M-12b set quality there).
    const r = rig({ screen: choice.codec, camera: choice.codec, preferred: choice.preferred });
    r.controller.kick();

    join(2, VP8_PEER);
    await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS - 1);
    expect(r.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(r.calls).toEqual(["camera:vp8", "screen:vp8"]);
    expect(r.screen.published).toBe("vp8");
    expect(r.screen.preferred).toBe("vp9");
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

/** A sender read that stays open until the test resolves it. */
function deferredSample(): {
  read: () => Promise<ShareSenderSample | null>;
  resolve: (s: ShareSenderSample | null) => void;
} {
  let resolve: ((s: ShareSenderSample | null) => void) | null = null;
  const read = (): Promise<ShareSenderSample | null> =>
    new Promise((res) => {
      resolve = res;
    });
  return { read, resolve: (s) => resolve?.(s) };
}

describe("CodecSwitchController timers and ownership", () => {
  it("stop clears a pending switch at once, for both kinds", () => {
    const r = rig({ screen: "vp9", camera: "vp9" });
    r.controller.kick();
    join();
    expect(vi.getTimerCount()).toBe(2);
    r.controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop clears the software encoder check at once", () => {
    const r = h264Rig({ encoder: "OpenH264" });
    expect(vi.getTimerCount()).toBe(1);
    r.controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks the same share again after a stop and a new kick", async () => {
    const r = h264Rig({ encoder: "OpenH264" });
    r.controller.stop();
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS);
    expect(r.calls).toEqual(["screen:vp8"]);
  });

  it("does not clear a check that already ran when it stops", async () => {
    const r = h264Rig({ encoder: "ExternalEncoder" });
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS);
    const clear = vi.spyOn(globalThis, "clearTimeout");
    r.controller.stop();
    expect(clear).not.toHaveBeenCalled();
  });

  it("drops the check when the share stops being live", () => {
    const r = h264Rig({ encoder: "OpenH264" });
    expect(vi.getTimerCount()).toBe(1);
    r.screen.quality = undefined;
    r.controller.kick();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces the check when a different share goes live", () => {
    const r = h264Rig({ encoder: "OpenH264" });
    const next = {} as LocalVideoTrack;
    r.screen.manualScreenTracks = [next];
    r.screen.announced = next;
    r.controller.kick();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("looks for the encoder name only twice", async () => {
    h264Rig({ sentFps: 2 });
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not look again when the share stopped being live while the sample was read", async () => {
    const sample = deferredSample();
    const r = rig({
      screen: "h264",
      preferred: "h264",
      readSample: sample.read,
    });
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS);
    r.screen.quality = undefined;
    r.controller.kick();
    sample.resolve({ sentFps: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a sample that arrives after stop", async () => {
    const sample = deferredSample();
    const r = rig({
      screen: "h264",
      preferred: "h264",
      readSample: sample.read,
    });
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS);
    r.controller.stop();
    sample.resolve({ encoder: "OpenH264" });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls).toEqual([]);
  });

  it("does not let a sample of an earlier share move the next share early", async () => {
    const sample = deferredSample();
    const r = rig({
      screen: "h264",
      preferred: "h264",
      readSample: sample.read,
    });
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS);
    join();
    const next = {} as LocalVideoTrack;
    r.screen.manualScreenTracks = [next];
    r.screen.announced = next;
    r.screen.preferred = "vp9";
    r.screen.published = "vp9";
    r.controller.kick();
    sample.resolve({ encoder: "OpenH264" });
    await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS - 1);
    expect(r.calls).toEqual([]);
  });

  it("reports a failing sender read", async () => {
    const failure = new Error("stats unavailable");
    const onSwitchError = vi.fn();
    const r = rig({
      screen: "h264",
      preferred: "h264",
      readSample: () => Promise.reject(failure),
      onSwitchError,
    });
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS);
    expect(onSwitchError).toHaveBeenCalledWith(failure);
  });

  it("reports a failing republish", async () => {
    const failure = new Error("republish failed");
    const onSwitchError = vi.fn();
    const r = rig({ screen: "vp9", failWith: failure, onSwitchError });
    r.controller.kick();
    join();
    await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS);
    expect(onSwitchError).toHaveBeenCalledWith(failure);
  });

  it("keeps a camera on its pick when only the share is a software H.264 one", async () => {
    const r = rig({
      screen: "h264",
      camera: "vp9",
      preferred: "h264",
      sample: { encoder: "OpenH264" },
    });
    r.camera.preferred = "vp9";
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS);
    expect(r.calls).toEqual(["screen:vp8"]);
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SWITCH_UP_MIN_GAP_MS);
    expect(r.calls).toEqual(["screen:vp8"]);
  });

  it("keeps the start of a wait when the same target is looked at again", async () => {
    const r = rig({ screen: "vp9" });
    r.controller.kick();
    join();
    await vi.advanceTimersByTimeAsync(1000);
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS - 1000);
    expect(r.calls).toEqual(["screen:vp8"]);
  });

  it("replaces a wait whose target changed instead of keeping both", () => {
    const r = rig({ screen: "h264", preferred: "vp9" });
    r.controller.kick();
    const before = vi.getTimerCount();
    join();
    expect(vi.getTimerCount()).toBe(before);
    r.controller.stop();
  });

  it("drops a pending switch when the share stops being live", () => {
    const r = rig({ screen: "vp9" });
    r.controller.kick();
    join();
    expect(vi.getTimerCount()).toBe(1);
    r.screen.quality = undefined;
    r.controller.kick();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("schedules nothing while a switch is in flight", async () => {
    const r = rig({ screen: "vp9", delayed: true });
    r.controller.kick();
    join();
    await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS);
    expect(r.calls).toEqual(["screen:vp8"]);
    r.controller.kick();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no second switch while one is in flight", async () => {
    const r = rig({
      screen: "h264",
      preferred: "h265",
      delayed: true,
      sample: { encoder: "OpenH264" },
    });
    join();
    r.controller.kick();
    await vi.advanceTimersByTimeAsync(SOFTWARE_CHECK_MS * 2);
    expect(r.calls).toEqual(["screen:vp8"]);
  });

  it("retries a busy share on the busy interval, not the switch-down delay", async () => {
    const r = rig({ screen: "vp9" });
    r.screen.changing = true;
    r.controller.kick();
    join();
    await vi.advanceTimersByTimeAsync(SWITCH_BUSY_RETRY_MS - 1);
    r.screen.changing = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls).toEqual(["screen:vp8"]);
  });

  it("does not republish when the share already carries the target by the time the wait ends", async () => {
    const r = rig({ screen: "vp9" });
    r.controller.kick();
    join();
    r.screen.published = "vp8";
    await vi.advanceTimersByTimeAsync(SWITCH_DOWN_MS);
    expect(r.calls).toEqual([]);
  });
});

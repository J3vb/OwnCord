import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTrack, LocalVideoTrack, Room } from "livekit-client";
import { bitrates, fakeSender, type FakeSender } from "../../../tests/helpers/fakeSender";
import { expectConsole } from "../../../tests/helpers/console";
import {
  bumpLocalCameraRev,
  bumpLocalShareRev,
  setLocalCamera,
  setLocalScreenshare,
  voiceStore,
} from "../../stores/voice.store";
import { applyVideoBitrateCap, resetVideoBitrateCap } from "./videoBitrateCap";
import {
  CAP_FOLLOW_BUSY_RETRY_MS,
  VideoCapFollower,
  clampPublishedVideo,
  shareServerLimit,
} from "./videoCapFollow";
import type { CameraTrackState, ScreenTrackState } from "./videoTrackState";

/** Camera "medium" asks 1.7 Mbps; share "medium" at 30 fps asks 3 Mbps. */
const CAMERA_PRESET = 1_700_000;
const SHARE_PRESET = 3_000_000;
const LAYERS = [
  [2, 400_000],
  [1, SHARE_PRESET],
] as const;

interface Live {
  readonly sender: FakeSender;
  readonly track: LocalVideoTrack;
}

function webTrack(layers: ReadonlyArray<readonly [number, number | undefined]> = LAYERS): Live {
  const sender = fakeSender(layers);
  return { sender, track: { sender: sender.sender } as unknown as LocalVideoTrack };
}

/** Camera and share states with whichever streams are given already live. */
function liveStates(camera?: Live, share?: Live) {
  const cameraState: CameraTrackState = {
    manualCameraTrack: camera?.track ?? null,
    ...(camera ? { announced: camera.track, quality: "medium" as const } : {}),
  };
  const screenState: ScreenTrackState = {
    manualScreenTracks: share ? [share.track] : [],
    ...(share ? { announced: share.track, quality: "medium" as const, fps: 30 } : {}),
  };
  return { cameraState, screenState };
}

const followers: VideoCapFollower[] = [];

function follow(states: ReturnType<typeof liveStates>, room: Room | null = null): VideoCapFollower {
  const follower = new VideoCapFollower({
    getRoom: () => room,
    getCameraState: () => states.cameraState,
    getScreenState: () => states.screenState,
  });
  followers.push(follower);
  return follower;
}

/** Let a follower's pending applies settle. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  setLocalCamera(false);
  setLocalScreenshare(false);
});

afterEach(() => {
  for (const f of followers.splice(0)) f.stop();
  resetVideoBitrateCap();
  vi.useRealTimers();
});

describe("VideoCapFollower on the web path", () => {
  it("follows a cap change on the running senders without a republish", async () => {
    const share = webTrack();
    const states = liveStates(undefined, share);
    setLocalScreenshare(true);
    follow(states).kick();
    await settle();
    expect(bitrates(share.sender)).toEqual([400_000, SHARE_PRESET]);

    applyVideoBitrateCap(1_000_000);
    await settle();
    expect(bitrates(share.sender)).toEqual([400_000, 1_000_000]);

    applyVideoBitrateCap(0);
    await settle();
    expect(bitrates(share.sender)).toEqual([400_000, SHARE_PRESET]);
  });

  it("splits the cap when the share starts, and gives it back when the share stops", async () => {
    const camera = webTrack([[1, CAMERA_PRESET]]);
    const states = liveStates(camera);
    setLocalCamera(true);
    applyVideoBitrateCap(1_200_000);
    follow(states).kick();
    await settle();
    // Alone, the camera may use the whole cap, which is under its preset.
    expect(bitrates(camera.sender)).toEqual([1_200_000]);

    setLocalScreenshare(true);
    voiceStore.flush();
    await settle();
    // Both live: the camera keeps a quarter of the cap, never under 300 kbps.
    expect(bitrates(camera.sender)).toEqual([300_000]);

    setLocalScreenshare(false);
    voiceStore.flush();
    await settle();
    expect(bitrates(camera.sender)).toEqual([1_200_000]);
  });

  it("leaves a stream alone while no cap holds it back", async () => {
    const camera = webTrack([[1, CAMERA_PRESET]]);
    setLocalCamera(true);
    follow(liveStates(camera)).kick();
    await settle();
    expect(bitrates(camera.sender)).toEqual([CAMERA_PRESET]);
  });

  it("waits out a share that is changing and puts it on the newest cap after", async () => {
    const share = webTrack();
    const states = liveStates(undefined, share);
    setLocalScreenshare(true);
    follow(states).kick();
    await settle();
    states.screenState.changing = true;
    applyVideoBitrateCap(1_000_000);
    await settle();
    expect(bitrates(share.sender)).toEqual([400_000, SHARE_PRESET]);

    // The cap moves again mid-change; the retry reads the cap when it runs.
    applyVideoBitrateCap(800_000);
    states.screenState.changing = false;
    await vi.advanceTimersByTimeAsync(CAP_FOLLOW_BUSY_RETRY_MS);
    expect(bitrates(share.sender)).toEqual([400_000, 800_000]);
  });

  it("drops a re-apply that races a stop: a stopped share's sender is never touched", async () => {
    const share = webTrack();
    const states = liveStates(undefined, share);
    setLocalScreenshare(true);
    follow(states).kick();
    await settle();
    share.sender.setParameters.mockClear();

    states.screenState.changing = true;
    applyVideoBitrateCap(1_000_000);
    await settle();
    // A stop takes the share before the retry runs.
    states.screenState.manualScreenTracks = [];
    states.screenState.announced = undefined;
    states.screenState.changing = false;
    await vi.advanceTimersByTimeAsync(CAP_FOLLOW_BUSY_RETRY_MS * 2);
    expect(share.sender.setParameters).not.toHaveBeenCalled();
  });

  it("drops a re-apply that races a replacement: only the new share's sender is set", async () => {
    const old = webTrack();
    const states = liveStates(undefined, old);
    setLocalScreenshare(true);
    follow(states).kick();
    await settle();
    old.sender.setParameters.mockClear();

    states.screenState.changing = true;
    applyVideoBitrateCap(1_000_000);
    await settle();
    const fresh = webTrack();
    states.screenState.manualScreenTracks = [fresh.track];
    states.screenState.announced = fresh.track;
    states.screenState.generation = 1;
    states.screenState.changing = false;
    await vi.advanceTimersByTimeAsync(CAP_FOLLOW_BUSY_RETRY_MS);
    expect(old.sender.setParameters).not.toHaveBeenCalled();
    expect(bitrates(fresh.sender)).toEqual([400_000, 1_000_000]);
  });

  it("a camera starting while a share is live re-applies the share's smaller part", async () => {
    const share = webTrack();
    const states = liveStates(undefined, share);
    applyVideoBitrateCap(4_000_000);
    setLocalScreenshare(true);
    follow(states).kick();
    await settle();
    expect(bitrates(share.sender)).toEqual([400_000, SHARE_PRESET]);

    setLocalCamera(true);
    voiceStore.flush();
    await settle();
    // 75% of 4 Mbps.
    expect(bitrates(share.sender)).toEqual([400_000, 3_000_000]);
    applyVideoBitrateCap(2_000_000);
    await settle();
    expect(bitrates(share.sender)).toEqual([400_000, 1_500_000]);
  });

  it("stop ends the subscriptions and a pending retry", async () => {
    const share = webTrack();
    const states = liveStates(undefined, share);
    setLocalScreenshare(true);
    const follower = follow(states);
    follower.kick();
    await settle();
    states.screenState.changing = true;
    applyVideoBitrateCap(1_000_000);
    await settle();
    follower.stop();
    states.screenState.changing = false;
    share.sender.setParameters.mockClear();
    await vi.advanceTimersByTimeAsync(CAP_FOLLOW_BUSY_RETRY_MS * 2);
    applyVideoBitrateCap(900_000);
    await settle();
    expect(share.sender.setParameters).not.toHaveBeenCalled();
  });

  it("a setParameters that fails is logged and does not stop later changes", async () => {
    const share = webTrack();
    setLocalScreenshare(true);
    follow(liveStates(undefined, share)).kick();
    await settle();
    share.sender.setParameters.mockRejectedValueOnce(new Error("closed"));
    applyVideoBitrateCap(1_000_000);
    await settle();
    expectConsole("warn", "Could not set the video cap on a live stream");
    applyVideoBitrateCap(900_000);
    await settle();
    expect(bitrates(share.sender)).toEqual([400_000, 900_000]);
  });
});

/** A native room: it has `setVideoBitrate`, and its tracks have no sender. */
function nativeRoom(setVideoBitrate: (...args: unknown[]) => Promise<void>): Room {
  return { setVideoBitrate, on: vi.fn(), off: vi.fn() } as unknown as Room;
}

/** What livekit-client does on a source swap or a reconnect's republish. */
const sdkRebuilds = (share: Live): void => {
  share.sender.encodings = LAYERS.map(([scale, rate]) => ({
    scaleResolutionDownBy: scale,
    maxBitrate: rate,
  }));
};

describe("VideoCapFollower after the SDK rebuilt the layers", () => {
  it("a source swap after a live cap change ends on the cap", async () => {
    const share = webTrack();
    setLocalScreenshare(true);
    follow(liveStates(undefined, share)).kick();
    applyVideoBitrateCap(1_000_000);
    await settle();
    expect(bitrates(share.sender)).toEqual([400_000, 1_000_000]);

    sdkRebuilds(share);
    bumpLocalShareRev();
    voiceStore.flush();
    await settle();
    expect(bitrates(share.sender)).toEqual([400_000, 1_000_000]);
  });

  it("a camera device switch after a live cap change ends on the cap", async () => {
    const camera = webTrack([[1, CAMERA_PRESET]]);
    setLocalCamera(true);
    follow(liveStates(camera)).kick();
    applyVideoBitrateCap(900_000);
    await settle();
    camera.sender.encodings = [{ scaleResolutionDownBy: 1, maxBitrate: CAMERA_PRESET }];
    bumpLocalCameraRev();
    voiceStore.flush();
    await settle();
    expect(bitrates(camera.sender)).toEqual([900_000]);
  });

  it("keeps the budget in the options the SDK recomputes from", async () => {
    const share = webTrack();
    const options = { screenShareEncoding: { maxBitrate: SHARE_PRESET, maxFramerate: 30 } };
    (share.track as unknown as { publishOptions: unknown }).publishOptions = options;
    setLocalScreenshare(true);
    follow(liveStates(undefined, share)).kick();
    applyVideoBitrateCap(1_000_000);
    await settle();
    expect(
      (share.track as unknown as { publishOptions: typeof options }).publishOptions
        .screenShareEncoding,
    ).toEqual({ maxBitrate: 1_000_000, maxFramerate: 30 });
  });

  it("a reconnect that republished the track from its old options ends on the cap", async () => {
    const share = webTrack();
    let reconnected: (() => void) | undefined;
    const off = vi.fn();
    const room = {
      on: (_event: unknown, handler: () => void) => {
        reconnected = handler;
      },
      off,
    } as unknown as Room;
    setLocalScreenshare(true);
    const follower = follow(liveStates(undefined, share), room);
    follower.kick();
    applyVideoBitrateCap(1_000_000);
    await settle();

    sdkRebuilds(share);
    reconnected?.();
    await settle();
    expect(bitrates(share.sender)).toEqual([400_000, 1_000_000]);
    follower.stop();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe("VideoCapFollower on the Linux native path", () => {
  const noSender = {} as unknown as LocalVideoTrack;

  it("sends the budget-capped top through the room, not a sender", async () => {
    const setVideoBitrate = vi.fn(() => Promise.resolve());
    const share = noSender as unknown as LocalTrack;
    const states: ReturnType<typeof liveStates> = {
      cameraState: { manualCameraTrack: null },
      screenState: {
        manualScreenTracks: [share],
        announced: share,
        quality: "medium",
        fps: 30,
      },
    };
    setLocalScreenshare(true);
    follow(states, nativeRoom(setVideoBitrate)).kick();
    await settle();
    expect(setVideoBitrate).toHaveBeenLastCalledWith("screen", share, SHARE_PRESET);
    applyVideoBitrateCap(1_500_000);
    await settle();
    expect(setVideoBitrate).toHaveBeenLastCalledWith("screen", share, 1_500_000);
    applyVideoBitrateCap(0);
    await settle();
    expect(setVideoBitrate).toHaveBeenLastCalledWith("screen", share, SHARE_PRESET);
  });

  it("holds the native camera and share together under one cap", async () => {
    const setVideoBitrate = vi.fn(() => Promise.resolve());
    const share = {} as unknown as LocalTrack;
    const states: ReturnType<typeof liveStates> = {
      cameraState: { manualCameraTrack: noSender, announced: noSender, quality: "medium" },
      screenState: { manualScreenTracks: [share], announced: share, quality: "medium", fps: 30 },
    };
    setLocalCamera(true);
    setLocalScreenshare(true);
    applyVideoBitrateCap(4_000_000);
    follow(states, nativeRoom(setVideoBitrate)).kick();
    await settle();
    expect(setVideoBitrate).toHaveBeenCalledWith("camera", noSender, 1_000_000);
    expect(setVideoBitrate).toHaveBeenCalledWith("screen", share, SHARE_PRESET);
  });

  it("a rejected host command is logged, not thrown", async () => {
    const setVideoBitrate = vi.fn(() => Promise.reject(new Error("encoder refused")));
    const states: ReturnType<typeof liveStates> = {
      cameraState: { manualCameraTrack: noSender, announced: noSender, quality: "medium" },
      screenState: { manualScreenTracks: [] },
    };
    setLocalCamera(true);
    follow(states, nativeRoom(setVideoBitrate)).kick();
    await settle();
    expect(setVideoBitrate).toHaveBeenCalled();
    expectConsole("warn", "Could not set the video cap on a live stream");
  });
});

describe("clampPublishedVideo", () => {
  it("records the layers and holds the lower ones under a capped top", async () => {
    const share = webTrack();
    setLocalScreenshare(true);
    applyVideoBitrateCap(300_000);
    await clampPublishedVideo(share.track, "screen", SHARE_PRESET);
    expect(bitrates(share.sender)).toEqual([300_000, 300_000]);
  });

  it("leaves the rates as they were while no budget holds the stream back", async () => {
    const share = webTrack();
    setLocalScreenshare(true);
    await clampPublishedVideo(share.track, "screen", SHARE_PRESET);
    expect(bitrates(share.sender)).toEqual([400_000, SHARE_PRESET]);
    await expect(clampPublishedVideo(undefined, "screen", SHARE_PRESET)).resolves.toBeUndefined();
  });

  it("never throws, even when the sender rejects", async () => {
    const share = webTrack();
    share.sender.setParameters.mockRejectedValueOnce(new Error("closed"));
    setLocalScreenshare(true);
    applyVideoBitrateCap(500_000);
    await expect(clampPublishedVideo(share.track, "screen", SHARE_PRESET)).resolves.toBeUndefined();
    expectConsole("warn", "Could not hold the published layers under the cap");
  });
});

describe("shareServerLimit", () => {
  it("names the budget only when it is below what the quality asks", () => {
    const state: ScreenTrackState = { manualScreenTracks: [], quality: "medium", fps: 30 };
    expect(shareServerLimit(state)).toBe(0);
    applyVideoBitrateCap(2_000_000);
    expect(shareServerLimit(state)).toBe(2_000_000);
    // With the camera live too the share's part is smaller still.
    setLocalScreenshare(true);
    setLocalCamera(true);
    expect(shareServerLimit(state)).toBe(1_500_000);
    applyVideoBitrateCap(5_000_000);
    expect(shareServerLimit(state)).toBe(0);
    expect(shareServerLimit({ manualScreenTracks: [] })).toBe(0);
  });
});

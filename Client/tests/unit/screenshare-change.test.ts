/**
 * WP 1C-1: Change source and Quality on a live screen share
 * (src/features/voice/screenshareChange.ts). Change source swaps the capture
 * under the published track, so viewers keep the same publication and the
 * server hears no voice_screenshare at all.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Track } from "livekit-client";
import type { LocalTrack, Room } from "livekit-client";
import type { WsClient } from "@lib/ws";
import { expectConsole } from "../helpers/console";
import { captureLogs } from "../helpers/log-capture";

const createLocalScreenTracks = vi.fn();
const savePref = vi.fn();

vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return {
    ...actual,
    createLocalScreenTracks: (...args: unknown[]) => createLocalScreenTracks(...args) as unknown,
  };
});

const setH264GpuProfiles = vi.hoisted(() => vi.fn());
vi.mock("@lib/voice/h264Profile", () => ({ setH264GpuProfiles }));
vi.mock("../../src/features/voice/videoCodec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/voice/videoCodec")>()),
  h264GpuPublish: (codec: string) => codec === "h264",
}));

vi.mock("@lib/prefs/preferences", () => ({
  loadPref: (_key: string, fallback: unknown) => fallback,
  savePref: (...args: unknown[]) => savePref(...args) as unknown,
}));

const { watchScreenEnded } = await import("@lib/voice/screenShare");
const { changeScreenshareSource, setScreenshareQuality } =
  await import("../../src/features/voice/screenshareChange");
const { voiceStore } = await import("@stores/voice.store");

type State = Parameters<typeof changeScreenshareSource>[0];
type Deps = Parameters<typeof changeScreenshareSource>[1];

interface FakeMst extends MediaStreamTrack {
  fire(type: string): void;
  stop: Mock<() => void>;
  applyConstraints: Mock<(c?: MediaTrackConstraints) => Promise<void>>;
}

function mst(id: string): FakeMst {
  const listeners = new Map<string, Set<EventListener>>();
  const track = {
    id,
    readyState: "live",
    stop: vi.fn(),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    clone: () => mst(`${id}-clone`),
    addEventListener: (type: string, cb: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: EventListener) => listeners.get(type)?.delete(cb),
    fire: (type: string) => {
      // Copy first: a listener that removes itself must not skip the next one.
      // oxlint-disable-next-line unicorn/no-useless-spread
      for (const cb of [...(listeners.get(type) ?? [])]) cb(new Event(type));
    },
  };
  return track as unknown as FakeMst;
}

interface FakeTrack {
  kind: Track.Kind;
  mediaStreamTrack: FakeMst;
  replaceTrack: Mock<(next: FakeMst) => Promise<FakeTrack>>;
  stop: Mock<() => void>;
  simulcastCodecs: Map<string, { mediaStreamTrack: FakeMst; sender?: RTCRtpSender }>;
  sender?: { getParameters: () => RTCRtpSendParameters; setParameters: ReturnType<typeof vi.fn> };
  publishOptions?: object;
}

function track(kind: Track.Kind, id: string): FakeTrack {
  const t: FakeTrack = {
    kind,
    mediaStreamTrack: mst(id),
    replaceTrack: vi.fn((next: FakeMst) => {
      t.mediaStreamTrack = next;
      return Promise.resolve(t);
    }),
    stop: vi.fn(() => t.mediaStreamTrack.stop()),
    simulcastCodecs: new Map(),
  };
  return t;
}

function setup(withAudio: boolean) {
  const publishTrack = vi.fn().mockResolvedValue(undefined);
  const unpublishTrack = vi.fn().mockResolvedValue(undefined);
  const room = {
    localParticipant: {
      publishTrack,
      unpublishTrack,
      setScreenShareEnabled: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Room;
  const wsSend = vi.fn(() => "id");
  const ws = { send: wsSend } as unknown as WsClient;
  const deps: Deps & { onError: Mock<(message: string) => void> } = {
    getRoom: () => room,
    getWs: () => ws,
    onError: vi.fn<(message: string) => void>(),
    reapplyAudioPipeline: vi.fn(),
  };
  const video = track(Track.Kind.Video, "window-a");
  const audio = track(Track.Kind.Audio, "audio-a");
  const tracks = (withAudio ? [video, audio] : [video]) as unknown as LocalTrack[];
  const state: State = { manualScreenTracks: tracks, generation: 0, quality: "medium" };
  watchScreenEnded(state, deps, video as unknown as LocalTrack, tracks, 0);
  voiceStore.setState((prev) => ({ ...prev, localScreenshare: true, localShareRev: 0 }));
  return { room, publishTrack, unpublishTrack, wsSend, deps, state, video, audio };
}

function picked(withAudio: boolean): FakeTrack[] {
  const fresh = [track(Track.Kind.Video, "window-b")];
  if (withAudio) fresh.push(track(Track.Kind.Audio, "audio-b"));
  createLocalScreenTracks.mockResolvedValueOnce(fresh);
  return fresh;
}

/** The ways something else can take a share while an async change is in flight. */
function takenShareCases(
  generation: number,
): Array<[string, (rig: ReturnType<typeof setup>) => void]> {
  return [
    [
      "a stop",
      (rig) => {
        rig.state.generation = generation;
      },
    ],
    [
      "a new set of tracks",
      (rig) => {
        rig.state.manualScreenTracks = [...rig.state.manualScreenTracks];
      },
    ],
  ];
}

/** A share whose video track runs the quality change itself, as the native
 *  track does: it asks the host to re-size the capture and republish. */
function nativeRig(setQuality = vi.fn().mockResolvedValue(undefined)) {
  const rig = setup(false);
  rig.state.fps = 60;
  rig.state.published = "h264";
  Object.assign(rig.video, { quality: "medium", fps: 60, setQuality });
  return { ...rig, setQuality };
}

beforeEach(() => {
  createLocalScreenTracks.mockReset();
  savePref.mockReset();
});

describe("changeScreenshareSource", () => {
  it("carries an H.264 share's GPU profiles over to the new capture", async () => {
    const logs = captureLogs();
    setH264GpuProfiles.mockClear();
    const rig = setup(false);
    rig.state.published = "h264";
    const [freshVideo] = picked(false);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(setH264GpuProfiles).toHaveBeenCalledWith(freshVideo!.mediaStreamTrack, true);
    expect(logs.find("Screenshare source changed")[0]!.component).toBe("screenShare");
  });

  it("swaps the capture under the same publication and tells the server nothing", async () => {
    const rig = setup(false);
    const [freshVideo] = picked(false);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(rig.video.replaceTrack).toHaveBeenCalledWith(freshVideo!.mediaStreamTrack, {
      userProvidedTrack: false,
    });
    expect(rig.state.manualScreenTracks[0]).toBe(rig.video);
    expect(rig.unpublishTrack).not.toHaveBeenCalled();
    expect(rig.publishTrack).not.toHaveBeenCalled();
    expect(rig.wsSend).not.toHaveBeenCalled();
    expect(voiceStore.getState().localScreenshare).toBe(true);
    expect(voiceStore.getState().localShareRev).toBe(1);
    expect(rig.state.changing).toBe(false);
  });

  it("the old capture ending changes nothing; the new one ending stops the share", async () => {
    const rig = setup(false);
    const old = rig.video.mediaStreamTrack;
    picked(false);
    await changeScreenshareSource(rig.state, rig.deps);

    old.fire("ended");
    await Promise.resolve();
    expect(rig.wsSend).not.toHaveBeenCalled();

    rig.video.mediaStreamTrack.fire("ended");
    await vi.waitFor(() =>
      expect(rig.wsSend).toHaveBeenCalledWith({
        type: "voice_screenshare",
        payload: { enabled: false },
      }),
    );
  });

  it("a new capture that ends while it is swapped in stops the share", async () => {
    const rig = setup(false);
    const [freshVideo] = picked(false);
    rig.video.replaceTrack.mockImplementationOnce((next: FakeMst) => {
      rig.video.mediaStreamTrack = next;
      // The OS Stop sharing bar, pressed before the watch moved over.
      (next as { readyState: string }).readyState = "ended";
      next.fire("ended");
      return Promise.resolve(rig.video);
    });

    await changeScreenshareSource(rig.state, rig.deps);

    expect(freshVideo!.mediaStreamTrack.readyState).toBe("ended");
    expect(rig.wsSend).toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: false },
    });
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("a closed picker keeps the old source going, silently", async () => {
    const rig = setup(false);
    const old = rig.video.mediaStreamTrack;
    createLocalScreenTracks.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"));

    await changeScreenshareSource(rig.state, rig.deps);

    expect(rig.video.replaceTrack).not.toHaveBeenCalled();
    expect(rig.video.mediaStreamTrack).toBe(old);
    expect(rig.deps.onError).not.toHaveBeenCalled();
    expect(rig.state.changing).toBe(false);
    // The OS ending the old capture still stops the share.
    old.fire("ended");
    await vi.waitFor(() => expect(rig.wsSend).toHaveBeenCalled());
  });

  it("Stop while the picker is open drops the new capture", async () => {
    const rig = setup(false);
    let resolvePick!: (tracks: FakeTrack[]) => void;
    createLocalScreenTracks.mockReturnValueOnce(
      new Promise<FakeTrack[]>((resolve) => {
        resolvePick = resolve;
      }),
    );
    const changing = changeScreenshareSource(rig.state, rig.deps);
    const { disableScreenshare } = await import("@lib/voice/screenShare");
    await disableScreenshare(rig.state, rig.deps);
    const fresh = track(Track.Kind.Video, "window-b");
    resolvePick([fresh]);
    await changing;

    expect(rig.video.replaceTrack).not.toHaveBeenCalled();
    expect(fresh.mediaStreamTrack.stop).toHaveBeenCalled();
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("captures the new source at the frame rate picked for this share", async () => {
    const rig = setup(false);
    rig.state.quality = "high";
    rig.state.fps = 60;
    picked(false);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(createLocalScreenTracks).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: expect.objectContaining({ width: 1920, height: 1080, frameRate: 60 }),
      }),
    );
  });

  it("swaps the audio too when both sources carry it", async () => {
    const rig = setup(true);
    const [, freshAudio] = picked(true);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(rig.audio.replaceTrack).toHaveBeenCalledWith(freshAudio!.mediaStreamTrack, {
      userProvidedTrack: false,
    });
    expect(rig.state.manualScreenTracks).toEqual([rig.video, rig.audio]);
    expect(rig.deps.reapplyAudioPipeline).toHaveBeenCalled();
  });

  it("drops the audio when the new source has none", async () => {
    const rig = setup(true);
    const oldAudio = rig.audio.mediaStreamTrack;
    picked(false);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(rig.unpublishTrack).toHaveBeenCalledWith(oldAudio);
    expect(rig.audio.stop).toHaveBeenCalled();
    expect(rig.state.manualScreenTracks).toEqual([rig.video]);
  });

  it("publishes audio when only the new source has it", async () => {
    const rig = setup(false);
    const [, freshAudio] = picked(true);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(rig.publishTrack).toHaveBeenCalledWith(
      freshAudio,
      expect.objectContaining({ source: Track.Source.ScreenShareAudio }),
    );
    expect(rig.state.manualScreenTracks).toEqual([rig.video, freshAudio]);
  });

  it("moves a backup-codec sender to the new capture", async () => {
    const rig = setup(false);
    const backupMst = mst("backup-a");
    const replace = vi.fn().mockResolvedValue(undefined);
    rig.video.simulcastCodecs.set("vp8", {
      mediaStreamTrack: backupMst,
      sender: { replaceTrack: replace } as unknown as RTCRtpSender,
    });
    picked(false);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({ id: "window-b-clone" }) as MediaStreamTrack,
    );
    expect(backupMst.stop).toHaveBeenCalled();
  });

  it("a share that changes its own source does it in place, without a browser picker", async () => {
    const rig = setup(false);
    rig.state.quality = undefined;
    const changeSource = vi.fn().mockResolvedValue(undefined);
    Object.assign(rig.video, { changeSource });

    await changeScreenshareSource(rig.state, rig.deps);

    expect(changeSource).toHaveBeenCalledTimes(1);
    expect(createLocalScreenTracks).not.toHaveBeenCalled();
    expect(rig.state.manualScreenTracks[0]).toBe(rig.video);
    expect(rig.wsSend).not.toHaveBeenCalled();
    expect(voiceStore.getState().localShareRev).toBe(1);
    expect(rig.state.changing).toBe(false);
  });

  it("an in-place change that is cancelled stays silent; one that fails says so", async () => {
    const rig = setup(false);
    const changeSource = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
      .mockRejectedValueOnce(new Error("no frame"));
    Object.assign(rig.video, { changeSource });

    await changeScreenshareSource(rig.state, rig.deps);
    expect(rig.deps.onError).not.toHaveBeenCalled();

    await changeScreenshareSource(rig.state, rig.deps);
    expectConsole("error", /\[screenShare\] Failed to change screenshare source/);
    expect(rig.deps.onError).toHaveBeenCalledWith("Couldn't change what you're sharing");
    expect(voiceStore.getState().localShareRev).toBe(0);
    expect(rig.state.changing).toBe(false);
    expect(voiceStore.getState().localScreenshare).toBe(true);
  });

  it("an in-place change that a Stop overtook leaves the stopped share alone", async () => {
    const rig = setup(false);
    let finish!: () => void;
    const changeSource = vi.fn(() => new Promise<void>((r) => (finish = r)));
    Object.assign(rig.video, { changeSource });

    const changing = changeScreenshareSource(rig.state, rig.deps);
    rig.state.generation = 1;
    rig.state.manualScreenTracks = [];
    finish();
    await changing;

    expect(voiceStore.getState().localShareRev).toBe(0);
    expect(rig.deps.onError).not.toHaveBeenCalled();
  });

  it("does nothing on a share that cannot change (Linux native, or still starting)", async () => {
    const rig = setup(false);
    rig.state.quality = undefined;

    await changeScreenshareSource(rig.state, rig.deps);

    expect(createLocalScreenTracks).not.toHaveBeenCalled();
  });
});

describe("setScreenshareQuality", () => {
  it("re-sizes the capture and its top layer without a picker, for this share only", async () => {
    const rig = setup(false);
    const setParameters = vi.fn().mockResolvedValue(undefined);
    const params = {
      encodings: [
        { rid: "q", scaleResolutionDownBy: 1.5, maxBitrate: 1_200_000 },
        { rid: "h", scaleResolutionDownBy: 1, maxBitrate: 3_000_000 },
      ],
    } as unknown as RTCRtpSendParameters;
    rig.video.sender = { getParameters: () => params, setParameters };

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expect(createLocalScreenTracks).not.toHaveBeenCalled();
    expect(rig.video.mediaStreamTrack.applyConstraints).toHaveBeenCalledWith({
      width: { max: 1920 },
      height: { max: 1080 },
      frameRate: 30,
    });
    expect(setParameters).toHaveBeenCalledTimes(1);
    expect(params.encodings[1]).toMatchObject({ maxBitrate: 6_000_000, maxFramerate: 30 });
    expect(params.encodings[0]!.maxBitrate).toBe(1_200_000);
    expect(rig.video.publishOptions).toMatchObject({
      screenShareEncoding: { maxBitrate: 6_000_000, maxFramerate: 30 },
    });
    expect(rig.state.quality).toBe("high");
    expect(savePref).not.toHaveBeenCalled();
    expect(rig.wsSend).not.toHaveBeenCalled();
  });

  it("keeps the frame rate picked for this share", async () => {
    const rig = setup(false);
    rig.state.fps = 60;

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expect(rig.video.mediaStreamTrack.applyConstraints).toHaveBeenCalledWith(
      expect.objectContaining({ frameRate: 60 }),
    );
    expect(rig.video.publishOptions).toMatchObject({
      screenShareEncoding: { maxBitrate: 9_000_000, maxFramerate: 60 },
    });
  });

  it("a quality change on a 120 fps share keeps balanced degradation", async () => {
    const rig = setup(false);
    rig.state.fps = 120;
    rig.video.publishOptions = { ...rig.video.publishOptions, degradationPreference: "balanced" };

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expect(rig.video.publishOptions).toMatchObject({
      degradationPreference: "balanced",
      screenShareEncoding: { maxFramerate: 120 },
    });
  });

  it("a refused size keeps the old quality and says so", async () => {
    const rig = setup(false);
    rig.video.mediaStreamTrack.applyConstraints.mockRejectedValueOnce(new Error("over"));

    await setScreenshareQuality(rig.state, rig.deps, "source");

    expectConsole("error", /\[screenShare\] Failed to change screenshare quality/);
    expect(rig.state.quality).toBe("medium");
    expect(rig.deps.onError).toHaveBeenCalledWith("Couldn't change the stream quality");
    expect(rig.state.changing).toBe(false);
  });
});

describe("setScreenshareQuality on a share that changes its own quality (Linux native)", () => {
  it("asks the track with the share's frame rate and published codec, then records the quality", async () => {
    const rig = nativeRig();

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expect(rig.setQuality).toHaveBeenCalledWith("high", 60, "h264");
    expect(rig.state.quality).toBe("high");
    expect(rig.video.replaceTrack).not.toHaveBeenCalled();
    expect(rig.video.mediaStreamTrack.applyConstraints).not.toHaveBeenCalled();
    expect(rig.wsSend).not.toHaveBeenCalled();
    expect(voiceStore.getState().localShareRev).toBe(1);
    expect(rig.state.changing).toBe(false);
  });

  it("the current quality, or a change already running, asks nothing", async () => {
    const rig = nativeRig();
    await setScreenshareQuality(rig.state, rig.deps, "medium");
    rig.state.changing = true;
    await setScreenshareQuality(rig.state, rig.deps, "high");

    expect(rig.setQuality).not.toHaveBeenCalled();
    expect(rig.state.changing).toBe(true);
  });

  it("a refused change shows the toast and keeps the quality and the share", async () => {
    const refused = Object.assign(new Error("a source change is pending"), { stage: "refused" });
    const rig = nativeRig(vi.fn().mockRejectedValue(refused));

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expectConsole("error", /\[screenShare\] Failed to change screenshare quality/);
    expect(rig.deps.onError).toHaveBeenCalledWith("Couldn't change the stream quality");
    expect(rig.state.quality).toBe("medium");
    expect(rig.state.manualScreenTracks[0]).toBe(rig.video);
    expect(rig.video.stop).not.toHaveBeenCalled();
    expect(voiceStore.getState().localScreenshare).toBe(true);
    expect(voiceStore.getState().localShareRev).toBe(0);
    expect(rig.state.changing).toBe(false);
  });

  it("a publish-stage failure ends the share and says so", async () => {
    const failed = Object.assign(new Error("publish failed"), { stage: "publish" });
    const rig = nativeRig(vi.fn().mockRejectedValue(failed));

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expectConsole("error", /\[screenShare\] Failed to change screenshare quality/);
    expect(rig.deps.onError).toHaveBeenCalledWith("Couldn't change the stream quality");
    expect(rig.video.stop).toHaveBeenCalled();
    expect(rig.state.manualScreenTracks).toEqual([]);
    expect(voiceStore.getState().localScreenshare).toBe(false);
    expect(rig.wsSend).toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: false },
    });
    expect(rig.state.changing).toBe(false);
  });

  it("a Stop that overtook the host's answer leaves the stopped share alone", async () => {
    let finish!: () => void;
    const rig = nativeRig(vi.fn(() => new Promise<void>((r) => (finish = r))));

    const changing = setScreenshareQuality(rig.state, rig.deps, "high");
    rig.state.generation = 1;
    rig.state.manualScreenTracks = [];
    finish();
    await changing;

    expect(rig.state.quality).toBe("medium");
    expect(voiceStore.getState().localShareRev).toBe(0);
    expect(rig.deps.onError).not.toHaveBeenCalled();
  });

  it("a failure after a Stop stays silent and does not end the newer state", async () => {
    let fail!: (e: Error) => void;
    const rig = nativeRig(vi.fn(() => new Promise<void>((_, rej) => (fail = rej))));

    const changing = setScreenshareQuality(rig.state, rig.deps, "high");
    rig.state.generation = 1;
    rig.state.manualScreenTracks = [];
    fail(Object.assign(new Error("gone"), { stage: "publish" }));
    await changing;

    expect(rig.deps.onError).not.toHaveBeenCalled();
    expect(rig.wsSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ordering, guards and supersession of a change
// ---------------------------------------------------------------------------

/** A picker that stays open until the test answers it. */
function openPicker(): { answer: (tracks: FakeTrack[]) => void; fail: (err: unknown) => void } {
  let answer!: (tracks: FakeTrack[]) => void;
  let fail!: (err: unknown) => void;
  createLocalScreenTracks.mockReturnValueOnce(
    new Promise<FakeTrack[]>((resolve, reject) => {
      answer = resolve;
      fail = reject;
    }),
  );
  return { answer, fail };
}

/** `deps` whose room and ws a test can swap while a change waits. */
function movableDeps(rig: ReturnType<typeof setup>) {
  const current = { room: rig.deps.getRoom(), ws: rig.deps.getWs() };
  const deps: Deps = {
    getRoom: () => current.room,
    getWs: () => current.ws,
    onError: rig.deps.onError,
    reapplyAudioPipeline: rig.deps.reapplyAudioPipeline,
  };
  return { deps, current };
}

describe("changeScreenshareSource: guards", () => {
  it("does nothing while another change is running", async () => {
    const rig = setup(false);
    rig.state.changing = true;

    await changeScreenshareSource(rig.state, rig.deps);

    expect(createLocalScreenTracks).not.toHaveBeenCalled();
    expect(rig.state.changing).toBe(true);
  });

  it("does nothing on a share with no published video", async () => {
    const rig = setup(true);
    rig.state.manualScreenTracks = [rig.audio as unknown as LocalTrack];

    await changeScreenshareSource(rig.state, rig.deps);

    expect(createLocalScreenTracks).not.toHaveBeenCalled();
  });

  it("holds the change flag while the picker is open and ignores a second request", async () => {
    const rig = setup(false);
    const picker = openPicker();

    const first = changeScreenshareSource(rig.state, rig.deps);
    expect(rig.state.changing).toBe(true);
    await changeScreenshareSource(rig.state, rig.deps);
    expect(createLocalScreenTracks).toHaveBeenCalledTimes(1);

    picker.answer([track(Track.Kind.Video, "window-b")]);
    await first;
    expect(rig.state.changing).toBe(false);
  });

  it("swaps the video and audio by kind, whatever order the tracks are listed in", async () => {
    const rig = setup(true);
    rig.state.manualScreenTracks = [
      rig.audio as unknown as LocalTrack,
      rig.video as unknown as LocalTrack,
    ];
    const freshAudio = track(Track.Kind.Audio, "audio-b");
    const freshVideo = track(Track.Kind.Video, "window-b");
    createLocalScreenTracks.mockResolvedValueOnce([freshAudio, freshVideo]);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(rig.video.replaceTrack).toHaveBeenCalledWith(freshVideo.mediaStreamTrack, {
      userProvidedTrack: false,
    });
    expect(rig.audio.replaceTrack).toHaveBeenCalledWith(freshAudio.mediaStreamTrack, {
      userProvidedTrack: false,
    });
    expect(rig.state.manualScreenTracks).toEqual([rig.video, rig.audio]);
  });

  it("drops a pick whose capture has already ended and leaves the old source going", async () => {
    const rig = setup(false);
    const [freshVideo] = picked(false);
    (freshVideo!.mediaStreamTrack as { readyState: string }).readyState = "ended";

    await changeScreenshareSource(rig.state, rig.deps);

    expect(rig.video.replaceTrack).not.toHaveBeenCalled();
    expect(freshVideo!.mediaStreamTrack.stop).toHaveBeenCalled();
    expect(rig.deps.onError).not.toHaveBeenCalled();
    expect(voiceStore.getState().localScreenshare).toBe(true);
    expect(rig.state.changing).toBe(false);
  });

  it("moves only the backup-codec senders that are still open", async () => {
    const rig = setup(false);
    const closedMst = mst("backup-closed");
    const openMst = mst("backup-open");
    const senderlessMst = mst("backup-none");
    const closedReplace = vi.fn().mockResolvedValue(undefined);
    const openReplace = vi.fn().mockResolvedValue(undefined);
    rig.video.simulcastCodecs.set("vp9", {
      mediaStreamTrack: closedMst,
      sender: {
        transport: { state: "closed" },
        replaceTrack: closedReplace,
      } as unknown as RTCRtpSender,
    });
    rig.video.simulcastCodecs.set("av1", { mediaStreamTrack: senderlessMst });
    rig.video.simulcastCodecs.set("h264", {
      mediaStreamTrack: openMst,
      sender: {
        transport: { state: "connected" },
        replaceTrack: openReplace,
      } as unknown as RTCRtpSender,
    });
    picked(false);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(closedReplace).not.toHaveBeenCalled();
    expect(closedMst.stop).not.toHaveBeenCalled();
    expect(senderlessMst.stop).not.toHaveBeenCalled();
    expect(openReplace).toHaveBeenCalledTimes(1);
    expect(openMst.stop).toHaveBeenCalled();
  });

  it.each(takenShareCases(1))(
    "drops the new capture when %s took the share while the picker was open",
    async (_n, act) => {
      const rig = setup(false);
      const picker = openPicker();
      const changing = changeScreenshareSource(rig.state, rig.deps);
      act(rig);
      const fresh = track(Track.Kind.Video, "window-b");
      picker.answer([fresh]);
      await changing;

      expect(rig.video.replaceTrack).not.toHaveBeenCalled();
      expect(fresh.mediaStreamTrack.stop).toHaveBeenCalled();
      expect(rig.state.changing).toBe(false);
    },
  );

  it("drops the new capture when the room changed while the picker was open", async () => {
    const rig = setup(false);
    const { deps, current } = movableDeps(rig);
    const picker = openPicker();
    const changing = changeScreenshareSource(rig.state, deps);
    current.room = {} as Room;
    const fresh = track(Track.Kind.Video, "window-b");
    picker.answer([fresh]);
    await changing;

    expect(rig.video.replaceTrack).not.toHaveBeenCalled();
    expect(fresh.mediaStreamTrack.stop).toHaveBeenCalled();
  });

  it("drops the new capture when the connection changed while the picker was open", async () => {
    const rig = setup(false);
    const { deps, current } = movableDeps(rig);
    const picker = openPicker();
    const changing = changeScreenshareSource(rig.state, deps);
    current.ws = { send: vi.fn() } as unknown as WsClient;
    const fresh = track(Track.Kind.Video, "window-b");
    picker.answer([fresh]);
    await changing;

    expect(rig.video.replaceTrack).not.toHaveBeenCalled();
    expect(fresh.mediaStreamTrack.stop).toHaveBeenCalled();
  });
});

describe("changeScreenshareSource: logging", () => {
  it("logs whether the swapped share carries audio", async () => {
    const logs = captureLogs();
    const silent = setup(false);
    picked(false);
    await changeScreenshareSource(silent.state, silent.deps);
    const withAudio = setup(true);
    picked(true);
    await changeScreenshareSource(withAudio.state, withAudio.deps);

    expect(new Set(logs.find("Screenshare source changed").map((e) => e.component))).toEqual(
      new Set(["screenShare"]),
    );
    expect(logs.find("Screenshare source changed").map((e) => e.data)).toEqual([
      { audio: false },
      { audio: true },
    ]);
  });
});

describe("changeScreenshareSource: a change that goes wrong", () => {
  it("shows an error and keeps the old source when the picker fails for another reason", async () => {
    const logs = captureLogs();
    const rig = setup(false);
    createLocalScreenTracks.mockRejectedValueOnce(new Error("no capture"));

    await changeScreenshareSource(rig.state, rig.deps);

    expectConsole("error", /\[screenShare\] Failed to open a new screenshare source/);
    expect(logs.find("Failed to open a new screenshare source")).toHaveLength(1);
    expect(rig.deps.onError).toHaveBeenCalledWith("Couldn't change what you're sharing");
    expect(rig.video.replaceTrack).not.toHaveBeenCalled();
    expect(voiceStore.getState().localScreenshare).toBe(true);
    expect(rig.wsSend).not.toHaveBeenCalled();
    expect(rig.state.changing).toBe(false);
  });

  it("treats a picker error that is not a refusal as a failure", async () => {
    const rig = setup(false);
    createLocalScreenTracks.mockRejectedValueOnce(new DOMException("none", "NotFoundError"));

    await changeScreenshareSource(rig.state, rig.deps);

    expectConsole("error", /Failed to open a new screenshare source/);
    expect(rig.deps.onError).toHaveBeenCalledWith("Couldn't change what you're sharing");
  });

  it("ends the share cleanly and stops the new capture when the swap fails half way", async () => {
    const logs = captureLogs();
    const rig = setup(false);
    const [freshVideo] = picked(false);
    rig.video.replaceTrack.mockRejectedValueOnce(new Error("sender gone"));

    await changeScreenshareSource(rig.state, rig.deps);

    expectConsole("error", /\[screenShare\] Failed to change screenshare source/);
    expect(logs.find("Failed to change screenshare source")).toHaveLength(1);
    expect(rig.deps.onError).toHaveBeenCalledWith("Couldn't change what you're sharing");
    expect(freshVideo!.mediaStreamTrack.stop).toHaveBeenCalled();
    expect(rig.wsSend).toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: false },
    });
    expect(voiceStore.getState().localScreenshare).toBe(false);
    expect(rig.state.changing).toBe(false);
  });

  it("stays silent about a failure once a stop has taken the share", async () => {
    const rig = setup(false);
    picked(false);
    rig.video.replaceTrack.mockImplementationOnce(() => {
      rig.state.generation = 1;
      return Promise.reject(new Error("sender gone"));
    });

    await changeScreenshareSource(rig.state, rig.deps);

    expect(rig.deps.onError).not.toHaveBeenCalled();
    expect(rig.wsSend).not.toHaveBeenCalled();
    expect(rig.state.changing).toBe(false);
  });

  it("releases a newly published audio track when a stop lands during the publish", async () => {
    const rig = setup(false);
    const [freshVideo, freshAudio] = picked(true);
    rig.publishTrack.mockImplementationOnce(() => {
      rig.state.generation = 1;
      return Promise.resolve(undefined);
    });
    const tracksBefore = rig.state.manualScreenTracks;

    await changeScreenshareSource(rig.state, rig.deps);

    expect(rig.unpublishTrack).toHaveBeenCalledExactlyOnceWith(freshAudio!.mediaStreamTrack);
    expect(freshVideo!.mediaStreamTrack.stop).toHaveBeenCalled();
    expect(freshAudio!.mediaStreamTrack.stop).toHaveBeenCalled();
    expect(rig.state.manualScreenTracks).toBe(tracksBefore);
    expect(voiceStore.getState().localShareRev).toBe(0);
    expect(rig.deps.reapplyAudioPipeline).not.toHaveBeenCalled();
    expect(rig.deps.onError).not.toHaveBeenCalled();
  });

  it("unpublishes nothing of its own when a stop lands after the audio was swapped in place", async () => {
    const rig = setup(true);
    const [freshVideo] = picked(true);
    rig.audio.replaceTrack.mockImplementationOnce((next: FakeMst) => {
      rig.audio.mediaStreamTrack = next;
      rig.state.generation = 1;
      return Promise.resolve(rig.audio);
    });
    const tracksBefore = rig.state.manualScreenTracks;

    await changeScreenshareSource(rig.state, rig.deps);

    expect(rig.unpublishTrack).not.toHaveBeenCalled();
    expect(freshVideo!.mediaStreamTrack.stop).toHaveBeenCalled();
    expect(rig.state.manualScreenTracks).toBe(tracksBefore);
    expect(voiceStore.getState().localShareRev).toBe(0);
  });
});

describe("changeScreenshareSource on a share that swaps its own capture", () => {
  function inPlaceRig(changeSource: () => Promise<void>) {
    const rig = setup(false);
    rig.state.generation = 3;
    Object.assign(rig.video, { changeSource });
    return rig;
  }

  it("reports the change and logs it as in place", async () => {
    const logs = captureLogs();
    const rig = inPlaceRig(() => Promise.resolve());

    await changeScreenshareSource(rig.state, rig.deps);

    expect(voiceStore.getState().localShareRev).toBe(1);
    expect(logs.find("Screenshare source changed").map((e) => e.data)).toEqual([{ inPlace: true }]);
  });

  it("holds the change flag while the host works and ignores a second request", async () => {
    let finish!: () => void;
    const changeSource = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const rig = inPlaceRig(changeSource);

    const first = changeScreenshareSource(rig.state, rig.deps);
    expect(rig.state.changing).toBe(true);
    await changeScreenshareSource(rig.state, rig.deps);
    expect(changeSource).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(rig.state.changing).toBe(false);
  });

  it("asks nothing of the host while a change is already running", async () => {
    const changeSource = vi.fn().mockResolvedValue(undefined);
    const rig = inPlaceRig(changeSource);
    rig.state.changing = true;

    await changeScreenshareSource(rig.state, rig.deps);

    expect(changeSource).not.toHaveBeenCalled();
  });

  it("asks nothing of the host when there is no room", async () => {
    const changeSource = vi.fn().mockResolvedValue(undefined);
    const rig = inPlaceRig(changeSource);
    const { deps, current } = movableDeps(rig);
    current.room = null;

    await changeScreenshareSource(rig.state, deps);

    expect(changeSource).not.toHaveBeenCalled();
  });

  it.each(takenShareCases(4))(
    "reports nothing when %s took the share meanwhile",
    async (_n, act) => {
      let finish!: () => void;
      const rig = inPlaceRig(() => new Promise<void>((r) => (finish = r)));
      const changing = changeScreenshareSource(rig.state, rig.deps);
      act(rig);
      finish();
      await changing;

      expect(voiceStore.getState().localShareRev).toBe(0);
    },
  );

  it("reports nothing when the room changed meanwhile", async () => {
    let finish!: () => void;
    const rig = inPlaceRig(() => new Promise<void>((r) => (finish = r)));
    const { deps, current } = movableDeps(rig);
    const changing = changeScreenshareSource(rig.state, deps);
    current.room = {} as Room;
    finish();
    await changing;

    expect(voiceStore.getState().localShareRev).toBe(0);
  });

  it("stays silent about a failure once a stop has taken the share", async () => {
    let fail!: (e: Error) => void;
    const rig = inPlaceRig(() => new Promise<void>((_, rej) => (fail = rej)));
    const changing = changeScreenshareSource(rig.state, rig.deps);
    rig.state.generation = 4;
    fail(new Error("gone"));
    await changing;

    expect(rig.deps.onError).not.toHaveBeenCalled();
  });

  it("treats a host error that is not a refusal as a failure", async () => {
    const rig = inPlaceRig(() => Promise.reject(new DOMException("none", "NotFoundError")));

    await changeScreenshareSource(rig.state, rig.deps);

    expectConsole("error", /\[screenShare\] Failed to change screenshare source/);
    expect(rig.deps.onError).toHaveBeenCalledWith("Couldn't change what you're sharing");
  });
});

describe("setScreenshareQuality on the web", () => {
  it("asks nothing for the quality the share already has", async () => {
    const rig = setup(false);

    await setScreenshareQuality(rig.state, rig.deps, "medium");

    expect(rig.video.mediaStreamTrack.applyConstraints).not.toHaveBeenCalled();
    expect(rig.state.changing).toBeFalsy();
  });

  it("asks nothing while another change is running, and leaves its flag alone", async () => {
    const rig = setup(false);
    rig.state.changing = true;

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expect(rig.video.mediaStreamTrack.applyConstraints).not.toHaveBeenCalled();
    expect(rig.state.changing).toBe(true);
  });

  it("holds the change flag while the capture is re-sized", async () => {
    const rig = setup(false);
    let finish!: () => void;
    rig.video.mediaStreamTrack.applyConstraints.mockReturnValueOnce(
      new Promise<void>((r) => (finish = r)),
    );

    const changing = setScreenshareQuality(rig.state, rig.deps, "high");
    expect(rig.state.changing).toBe(true);
    finish();
    await changing;
    expect(rig.state.changing).toBe(false);
  });

  it("re-sizes by frame rate alone for the source quality", async () => {
    const rig = setup(false);

    await setScreenshareQuality(rig.state, rig.deps, "source");

    expect(rig.video.mediaStreamTrack.applyConstraints).toHaveBeenCalledExactlyOnceWith({
      frameRate: 30,
    });
    expect(rig.state.quality).toBe("source");
  });

  it("sets the track again on its sender with the user's own track kept, then reports", async () => {
    const logs = captureLogs();
    const rig = setup(false);
    const capture = rig.video.mediaStreamTrack;

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expect(rig.video.replaceTrack).toHaveBeenCalledExactlyOnceWith(capture, {
      userProvidedTrack: false,
    });
    expect(voiceStore.getState().localShareRev).toBe(1);
    expect(logs.find("Screenshare quality changed").map((e) => e.data)).toEqual([
      { quality: "high", fps: 30, maxBitrate: 6_000_000 },
    ]);
  });

  it("puts the bitrate on the top layer whatever order the layers are listed in", async () => {
    const rig = setup(false);
    const setParameters = vi.fn().mockResolvedValue(undefined);
    const params = {
      encodings: [
        { rid: "h", scaleResolutionDownBy: 1 },
        { rid: "q", scaleResolutionDownBy: 2 },
      ],
    } as unknown as RTCRtpSendParameters;
    rig.video.sender = { getParameters: () => params, setParameters };

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expect(params.encodings[0]).toMatchObject({ maxBitrate: 6_000_000, maxFramerate: 30 });
    expect(params.encodings[1]).not.toHaveProperty("maxBitrate");
  });

  it("puts the bitrate on the last of the layers that share the top size", async () => {
    const rig = setup(false);
    const params = {
      encodings: [
        { rid: "a", scaleResolutionDownBy: 1 },
        { rid: "b", scaleResolutionDownBy: 1 },
      ],
    } as unknown as RTCRtpSendParameters;
    rig.video.sender = { getParameters: () => params, setParameters: vi.fn() };

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expect(params.encodings[0]).not.toHaveProperty("maxBitrate");
    expect(params.encodings[1]).toMatchObject({ maxBitrate: 6_000_000 });
  });

  it("leaves everything as it was when a stop lands while the capture is re-sized", async () => {
    const rig = setup(false);
    let finish!: () => void;
    rig.video.mediaStreamTrack.applyConstraints.mockReturnValueOnce(
      new Promise<void>((r) => (finish = r)),
    );

    const changing = setScreenshareQuality(rig.state, rig.deps, "high");
    rig.state.generation = 1;
    finish();
    await changing;

    expect(rig.video.replaceTrack).not.toHaveBeenCalled();
    expect(rig.video.publishOptions).toBeUndefined();
    expect(rig.state.quality).toBe("medium");
    expect(voiceStore.getState().localShareRev).toBe(0);
  });

  it("leaves the quality as it was when a stop lands while the track is set again", async () => {
    const rig = setup(false);
    rig.video.replaceTrack.mockImplementationOnce(() => {
      rig.state.generation = 1;
      return Promise.resolve(rig.video);
    });

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expect(rig.state.quality).toBe("medium");
    expect(voiceStore.getState().localShareRev).toBe(0);
    expect(rig.deps.onError).not.toHaveBeenCalled();
  });

  it("stays silent about a refusal once a stop has taken the share", async () => {
    const rig = setup(false);
    rig.video.mediaStreamTrack.applyConstraints.mockImplementationOnce(() => {
      rig.state.generation = 1;
      return Promise.reject(new Error("over"));
    });

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expect(rig.deps.onError).not.toHaveBeenCalled();
    expect(rig.state.changing).toBe(false);
  });
});

describe("setScreenshareQuality on a share that changes its own quality: guards", () => {
  it("logs the new quality, the frame rate and that it was done in place", async () => {
    const logs = captureLogs();
    const rig = nativeRig();

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expect(logs.find("Screenshare quality changed").map((e) => e.data)).toEqual([
      { quality: "high", fps: 60, inPlace: true },
    ]);
  });

  it("falls back to the track's frame rate when the share has none of its own", async () => {
    const rig = nativeRig();
    rig.state.fps = undefined;

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expect(rig.setQuality).toHaveBeenCalledWith("high", 60, "h264");
  });

  it("holds the change flag while the host works", async () => {
    let finish!: () => void;
    const rig = nativeRig(vi.fn(() => new Promise<void>((r) => (finish = r))));

    const changing = setScreenshareQuality(rig.state, rig.deps, "high");
    expect(rig.state.changing).toBe(true);
    finish();
    await changing;
    expect(rig.state.changing).toBe(false);
  });

  it("asks nothing before the share has a quality", async () => {
    const rig = nativeRig();
    rig.state.quality = undefined;

    await setScreenshareQuality(rig.state, rig.deps, "high");

    expect(rig.setQuality).not.toHaveBeenCalled();
  });

  it("asks nothing without a room, or without a connection", async () => {
    const rig = nativeRig();
    const { deps, current } = movableDeps(rig);

    current.room = null;
    await setScreenshareQuality(rig.state, deps, "high");
    current.room = rig.deps.getRoom()!;
    current.ws = null;
    await setScreenshareQuality(rig.state, deps, "high");

    expect(rig.setQuality).not.toHaveBeenCalled();
  });

  it.each(takenShareCases(1))(
    "reports nothing when %s took the share meanwhile",
    async (_n, act) => {
      let finish!: () => void;
      const rig = nativeRig(vi.fn(() => new Promise<void>((r) => (finish = r))));
      const changing = setScreenshareQuality(rig.state, rig.deps, "high");
      act(rig);
      finish();
      await changing;

      expect(rig.state.quality).toBe("medium");
      expect(voiceStore.getState().localShareRev).toBe(0);
    },
  );

  it("reports nothing when the room changed meanwhile", async () => {
    let finish!: () => void;
    const rig = nativeRig(vi.fn(() => new Promise<void>((r) => (finish = r))));
    const { deps, current } = movableDeps(rig);
    const changing = setScreenshareQuality(rig.state, deps, "high");
    current.room = {} as Room;
    finish();
    await changing;

    expect(rig.state.quality).toBe("medium");
    expect(voiceStore.getState().localShareRev).toBe(0);
  });

  it("reports nothing when the connection changed meanwhile", async () => {
    let finish!: () => void;
    const rig = nativeRig(vi.fn(() => new Promise<void>((r) => (finish = r))));
    const { deps, current } = movableDeps(rig);
    const changing = setScreenshareQuality(rig.state, deps, "high");
    current.ws = { send: vi.fn() } as unknown as WsClient;
    finish();
    await changing;

    expect(rig.state.quality).toBe("medium");
    expect(voiceStore.getState().localShareRev).toBe(0);
  });
});

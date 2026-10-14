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

const createLocalScreenTracks = vi.fn();
const savePref = vi.fn();

vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return {
    ...actual,
    createLocalScreenTracks: (...args: unknown[]) => createLocalScreenTracks(...args) as unknown,
  };
});

vi.mock("@lib/preferences", () => ({
  loadPref: (_key: string, fallback: unknown) => fallback,
  savePref: (...args: unknown[]) => savePref(...args) as unknown,
}));

const { watchScreenEnded } = await import("@lib/screenShare");
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

beforeEach(() => {
  createLocalScreenTracks.mockReset();
  savePref.mockReset();
});

describe("changeScreenshareSource", () => {
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
    const { disableScreenshare } = await import("@lib/screenShare");
    await disableScreenshare(rig.state, rig.deps);
    const fresh = track(Track.Kind.Video, "window-b");
    resolvePick([fresh]);
    await changing;

    expect(rig.video.replaceTrack).not.toHaveBeenCalled();
    expect(fresh.mediaStreamTrack.stop).toHaveBeenCalled();
    expect(voiceStore.getState().localScreenshare).toBe(false);
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

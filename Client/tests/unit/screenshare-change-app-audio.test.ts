/**
 * WP 6.7b: Change source and the app's sound on Windows
 * (src/features/voice/screenshareChange.ts). Leaving a window always stops the
 * host capture; a fresh window starts its own and joins the existing four audio
 * cases as the "fresh audio" track.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as shareRig from "../helpers/screenShareRig";
import { Track } from "livekit-client";
import type { LocalTrack } from "livekit-client";
import { initToast, teardownToast } from "@lib/ui/toast";
import type { ToastContainer } from "@components/Toast";
import { expectConsole } from "../helpers/console";

const createLocalScreenTracks = vi.fn();
const invoke = vi.hoisted(() => vi.fn());
const openAppAudio = vi.hoisted(() => vi.fn());

vi.mock("livekit-client", (importOriginal) =>
  shareRig.livekitScreenMock(
    importOriginal,
    (...a) => createLocalScreenTracks(...a) as unknown,
    true,
  ),
);
vi.mock("@tauri-apps/api/core", () => shareRig.tauriInvokeMock(invoke));
vi.mock("../../src/lib/voice/appAudioTrack", () => shareRig.appAudioTrackMock(openAppAudio));
vi.mock("@lib/prefs/preferences", () => shareRig.fallbackPrefsMock());

const { watchScreenEnded } = await import("@lib/voice/screenShare");
const { changeScreenshareSource } = await import("../../src/features/voice/screenshareChange");
const { startAppShareAudio } = await import("../../src/lib/voice/appAudioShare");
const { voiceStore } = await import("@stores/voice.store");

type State = Parameters<typeof changeScreenshareSource>[0];

function mst(id: string, surface?: string): MediaStreamTrack {
  return {
    id,
    label: id,
    readyState: "live",
    stop: vi.fn(),
    clone: () => mst(`${id}-clone`, surface),
    getSettings: () => (surface === undefined ? {} : { displaySurface: surface }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
}

interface FakeTrack {
  kind: Track.Kind;
  mediaStreamTrack: MediaStreamTrack;
  replaceTrack: Mock<(next: MediaStreamTrack) => Promise<FakeTrack>>;
  stop: Mock<() => void>;
  simulcastCodecs: Map<string, { mediaStreamTrack: MediaStreamTrack; sender?: RTCRtpSender }>;
}

function track(kind: Track.Kind, id: string, surface?: string): FakeTrack {
  const t: FakeTrack = {
    kind,
    mediaStreamTrack: mst(id, surface),
    replaceTrack: vi.fn((next: MediaStreamTrack) => {
      t.mediaStreamTrack = next;
      return Promise.resolve(t);
    }),
    stop: vi.fn(() => t.mediaStreamTrack.stop()),
    simulcastCodecs: new Map(),
  };
  return t;
}

function handle(id: string) {
  return { track: mst(id), close: vi.fn() };
}

const commands = (): string[] => invoke.mock.calls.map((c) => c[0] as string);

/** A live window share; `oldAudio` is the app's sound or Chromium's. */
async function setup(opts: { audio: "app" | "chromium" | "none"; appAudioOn?: boolean }) {
  const { room, publishTrack, unpublishTrack, deps } = shareRig.screenShareRig();
  const video = track(Track.Kind.Video, "window-a", "window");
  // The old window's app sound is a real one, started through the lib, so
  // its close() applies the real "stop unless a newer start" rule.
  const oldPageHandle = handle("app-a");
  let oldApp: Awaited<ReturnType<typeof startAppShareAudio>> = null;
  if (opts.audio === "app") {
    openAppAudio.mockResolvedValueOnce(oldPageHandle);
    oldApp = await startAppShareAudio(video.mediaStreamTrack, () => false);
    invoke.mockClear();
  }
  const audio =
    opts.audio === "none"
      ? undefined
      : oldApp !== null
        ? (oldApp.track as unknown as FakeTrack)
        : track(Track.Kind.Audio, "audio-a");
  if (audio !== undefined && oldApp !== null) {
    audio.stop = vi.fn(() => audio.mediaStreamTrack.stop());
    audio.replaceTrack = vi.fn((next: MediaStreamTrack) => {
      audio.mediaStreamTrack = next;
      return Promise.resolve(audio);
    });
  }
  const tracks = (audio === undefined ? [video] : [video, audio]) as unknown as LocalTrack[];
  const oldHandle = oldPageHandle;
  const state: State = {
    manualScreenTracks: tracks,
    generation: 0,
    quality: "medium",
    appAudioOn: opts.appAudioOn ?? true,
    ...(oldApp !== null ? { appAudio: oldApp } : {}),
  };
  watchScreenEnded(state, deps, video as unknown as LocalTrack, tracks, 0);
  voiceStore.setState((prev) => ({ ...prev, localScreenshare: true, localShareRev: 0 }));
  return { room, publishTrack, unpublishTrack, deps, state, video, audio, oldHandle };
}

function pick(surface: string, withChromiumAudio: boolean): FakeTrack[] {
  const fresh = [track(Track.Kind.Video, "window-b", surface)];
  if (withChromiumAudio) fresh.push(track(Track.Kind.Audio, "audio-b"));
  createLocalScreenTracks.mockResolvedValueOnce(fresh);
  return fresh;
}

const toastShow = vi.fn();

beforeEach(() => {
  createLocalScreenTracks.mockReset();
  invoke.mockReset().mockResolvedValue({ url: "ws://127.0.0.1:9/t/app-audio" });
  openAppAudio.mockReset();
  toastShow.mockReset();
  initToast({ show: toastShow } as unknown as ToastContainer);
  return () => teardownToast();
});

describe("changeScreenshareSource with the app's sound", () => {
  it("window to window: the fresh window's capture replaces the old on the same audio publication", async () => {
    const rig = await setup({ audio: "app" });
    const h = handle("app-b");
    openAppAudio.mockResolvedValue(h);
    pick("window", false);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(invoke).toHaveBeenCalledWith("start_app_audio", {
      label: "window-b",
      surface: "window",
    });
    expect(rig.audio!.replaceTrack).toHaveBeenCalledWith(h.track, { userProvidedTrack: false });
    expect(rig.state.manualScreenTracks).toContain(rig.audio);
    expect(rig.state.appAudio).toBeDefined();
    expect(rig.state.appAudio).not.toBe(rig.oldHandle);
    // The host already replaced the old capture: closing it must not stop the new one.
    expect(rig.oldHandle.close).toHaveBeenCalledTimes(1);
    // The newer start was issued: the old close must not stop the new capture.
    expect(commands()).not.toContain("stop_app_audio");
    expect(rig.unpublishTrack).not.toHaveBeenCalled();
  });

  it("window to screen with system audio: the screen's audio takes the slot and the capture stops", async () => {
    const rig = await setup({ audio: "app" });
    const [, freshAudio] = pick("monitor", true);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(commands()).not.toContain("start_app_audio");
    expect(rig.audio!.replaceTrack).toHaveBeenCalledWith(freshAudio!.mediaStreamTrack, {
      userProvidedTrack: false,
    });
    expect(rig.oldHandle.close).toHaveBeenCalledTimes(1);
    expect(commands()).toEqual(["stop_app_audio"]);
    expect(rig.state.appAudio).toBeUndefined();
  });

  it("window to screen without audio: the audio is unpublished and the capture stops", async () => {
    const rig = await setup({ audio: "app" });
    pick("monitor", false);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(rig.unpublishTrack).toHaveBeenCalledWith(rig.audio!.mediaStreamTrack);
    expect(rig.audio!.stop).toHaveBeenCalled();
    expect(rig.oldHandle.close).toHaveBeenCalledTimes(1);
    expect(commands()).toEqual(["stop_app_audio"]);
    expect(rig.state.manualScreenTracks).toEqual([rig.video]);
    expect(rig.state.appAudio).toBeUndefined();
  });

  it("leaving a window whose own start never produced a track has no capture to stop", async () => {
    const rig = await setup({ audio: "none" });
    pick("monitor", false);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(commands()).toEqual([]);
  });

  it("starts no app audio on Linux native, whatever the share's switch", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
    try {
      const rig = await setup({ audio: "none" });
      pick("window", false);

      await changeScreenshareSource(rig.state, rig.deps);

      expect(commands()).not.toContain("start_app_audio");
      expect(rig.publishTrack).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("screen to window: the app's sound takes over the screen audio's publication", async () => {
    const rig = await setup({ audio: "chromium" });
    const h = handle("app-b");
    openAppAudio.mockResolvedValue(h);
    pick("window", false);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(rig.audio!.replaceTrack).toHaveBeenCalledWith(h.track, { userProvidedTrack: false });
    expect(rig.state.appAudio).toBeDefined();
  });

  it("window to window with no audio published before: publishes the app's sound", async () => {
    const rig = await setup({ audio: "none" });
    const h = handle("app-b");
    openAppAudio.mockResolvedValue(h);
    pick("window", false);

    await changeScreenshareSource(rig.state, rig.deps);

    const published = rig.publishTrack.mock.calls[0]?.[0] as LocalTrack;
    expect(published.mediaStreamTrack).toBe(h.track);
    expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({
      source: Track.Source.ScreenShareAudio,
    });
    expect(rig.state.manualScreenTracks).toHaveLength(2);
  });

  it("starts nothing when the share's switch was off", async () => {
    const rig = await setup({ audio: "none", appAudioOn: false });
    pick("window", false);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(invoke).not.toHaveBeenCalled();
    expect(rig.publishTrack).not.toHaveBeenCalled();
  });

  it("starts nothing when Chromium gave audio for the new source", async () => {
    const rig = await setup({ audio: "none" });
    pick("window", true);

    await changeScreenshareSource(rig.state, rig.deps);

    expect(commands()).not.toContain("start_app_audio");
  });

  it("a refused start toasts once and the share goes on without the old window's sound", async () => {
    const rig = await setup({ audio: "app" });
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_app_audio" ? Promise.reject("not_found") : Promise.resolve(),
    );
    pick("window", false);

    await changeScreenshareSource(rig.state, rig.deps);

    expectConsole("warn", /\[appAudioShare\] App audio did not start/);
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(rig.unpublishTrack).toHaveBeenCalledWith(rig.audio!.mediaStreamTrack);
    expect(rig.oldHandle.close).toHaveBeenCalledTimes(1);
    expect(commands()).toEqual(["start_app_audio"]); // the host replaced the old capture itself
    expect(rig.deps.onError).not.toHaveBeenCalled();
    expect(rig.state.changing).toBe(false);
  });

  it("a start that lands after the share stopped swaps nothing and stops the capture", async () => {
    const rig = await setup({ audio: "app" });
    let answer!: (v: unknown) => void;
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_app_audio" ? new Promise((resolve) => (answer = resolve)) : Promise.resolve(),
    );
    const h = handle("app-b");
    openAppAudio.mockResolvedValue(h);
    const [freshVideo] = pick("window", false);

    const changing = changeScreenshareSource(rig.state, rig.deps);
    await vi.waitFor(() => expect(answer).toBeDefined());
    rig.state.generation = 1; // a stop or leave
    answer({ url: "ws://127.0.0.1:9/t/app-audio" });
    await changing;

    expect(openAppAudio).toHaveBeenCalledTimes(1); // the old window's, at setup
    expect(commands()).toContain("stop_app_audio");
    expect(rig.video.replaceTrack).not.toHaveBeenCalled();
    expect(rig.audio!.replaceTrack).not.toHaveBeenCalled();
    expect(freshVideo!.stop).toHaveBeenCalled();
  });
  it("releases the new window's sound when the swap fails before the share takes it", async () => {
    const rig = await setup({ audio: "app" });
    const h = handle("app-b");
    openAppAudio.mockResolvedValue(h);
    const [freshVideo] = pick("window", false);
    rig.video.replaceTrack.mockRejectedValueOnce(new Error("sender gone"));

    await changeScreenshareSource(rig.state, rig.deps);

    expectConsole("error", /\[screenShare\] Failed to change screenshare source/);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(freshVideo!.stop).toHaveBeenCalled();
    expect(rig.deps.onError).toHaveBeenCalledWith("Couldn't change what you're sharing");
    expect(rig.state.appAudio).toBeUndefined();
    expect(rig.oldHandle.close).toHaveBeenCalledTimes(1);
  });

  it("releases the new window's sound when a stop lands after the video was swapped", async () => {
    const rig = await setup({ audio: "app" });
    const h = handle("app-b");
    openAppAudio.mockResolvedValue(h);
    const [freshVideo] = pick("window", false);
    rig.audio!.replaceTrack.mockImplementationOnce((next: MediaStreamTrack) => {
      rig.audio!.mediaStreamTrack = next;
      rig.state.generation = 1;
      return Promise.resolve(rig.audio!);
    });
    const oldApp = rig.state.appAudio;

    await changeScreenshareSource(rig.state, rig.deps);

    expect(h.close).toHaveBeenCalledTimes(1);
    expect(freshVideo!.stop).toHaveBeenCalled();
    expect(rig.state.appAudio).toBe(oldApp);
    expect(voiceStore.getState().localShareRev).toBe(0);
    expect(rig.deps.onError).not.toHaveBeenCalled();
  });
});

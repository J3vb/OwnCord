/**
 * WP 6.7b: Windows per-app share audio on the web share path
 * (src/lib/voice/screenShare.ts + src/lib/voice/appAudioShare.ts). The host commands are
 * driven through the real desktop wrappers over a mocked Tauri `invoke`; the
 * socket-to-track step (`openAppAudio`) is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const { disableScreenshare, enableScreenshare, stopManualScreenTracks } =
  await import("@lib/voice/screenShare");
const { setScreenSourcePicker } = await import("../../src/features/voice/native/screenPickerSlot");
const { voiceStore } = await import("@stores/voice.store");

type State = Parameters<typeof enableScreenshare>[0];

function mst(label = "", surface?: string): MediaStreamTrack {
  return {
    label,
    readyState: "live",
    stop: vi.fn(),
    getSettings: () => (surface === undefined ? {} : { displaySurface: surface }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function shareTrack(kind: Track.Kind, label = "", surface?: string): LocalTrack {
  const m = mst(label, surface);
  return { kind, mediaStreamTrack: m, stop: vi.fn(() => m.stop()) } as unknown as LocalTrack;
}

function rig() {
  return shareRig.screenShareRig(vi.fn());
}

/** A rig whose picker hands back a live window share titled "Game". */
function rigSharingGame() {
  createLocalScreenTracks.mockResolvedValue([shareTrack(Track.Kind.Video, "Game", "window")]);
  return rig();
}

const publishedAudio = (r: ReturnType<typeof rig>) =>
  r.publishTrack.mock.calls.filter((c) => (c[0] as LocalTrack).kind === Track.Kind.Audio);

function handle() {
  const track = mst("app");
  return { track, close: vi.fn() };
}

/** Which host commands ran, in order. */
function commands(): string[] {
  return invoke.mock.calls.map((c) => c[0] as string);
}

const toastShow = vi.fn();
function toastText(): string {
  return toastShow.mock.calls.map((c) => String(c[0])).join("\n");
}

beforeEach(() => {
  createLocalScreenTracks.mockReset();
  invoke.mockReset();
  openAppAudio.mockReset();
  toastShow.mockReset();
  voiceStore.setState((prev) => ({ ...prev, localScreenshare: false }));
  initToast({ show: toastShow } as unknown as ToastContainer);
});

afterEach(() => {
  setScreenSourcePicker(null);
  teardownToast();
});

function pickWith(audio: boolean | undefined): void {
  setScreenSourcePicker(() =>
    Promise.resolve({
      source: "os",
      quality: "medium",
      fps: 30,
      ...(audio === undefined ? {} : { audio }),
    }),
  );
}

describe("enableScreenshare app audio", () => {
  it("shares the window's app sound as the share audio", async () => {
    pickWith(true);
    const h = handle();
    invoke.mockResolvedValue({ url: "ws://127.0.0.1:9/t/app-audio" });
    openAppAudio.mockResolvedValue(h);
    const video = shareTrack(Track.Kind.Video, "Spotify", "window");
    createLocalScreenTracks.mockResolvedValue([video]);
    const r = rig();
    const state: State = { manualScreenTracks: [] };

    await enableScreenshare(state, r.deps);

    expect(invoke).toHaveBeenCalledWith("start_app_audio", { label: "Spotify", surface: "window" });
    expect(openAppAudio).toHaveBeenCalledWith("ws://127.0.0.1:9/t/app-audio");
    const audioCall = r.publishTrack.mock.calls.find(
      (c) => (c[0] as LocalTrack).kind === Track.Kind.Audio,
    );
    expect(audioCall?.[1]).toMatchObject({
      source: Track.Source.ScreenShareAudio,
      dtx: false,
      forceStereo: true,
    });
    expect(state.manualScreenTracks).toHaveLength(2);
    expect(state.appAudio).toBeDefined();
    expect(state.appAudioOn).toBe(true);
    expect(r.wsSend).toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: true },
    });
  });

  it.each([
    ["the switch is off", false, "window", false],
    ["the picker offered no switch", undefined, "window", false],
    ["the share is a screen", true, "monitor", false],
    ["the share is a tab", true, "browser", false],
    ["Chromium already gave audio", true, "window", true],
  ])("does not start when %s", async (_name, audio, surface, chromiumAudio) => {
    pickWith(audio);
    const tracks = [shareTrack(Track.Kind.Video, "x", surface)];
    if (chromiumAudio) tracks.push(shareTrack(Track.Kind.Audio));
    createLocalScreenTracks.mockResolvedValue(tracks);
    const r = rig();

    await enableScreenshare({ manualScreenTracks: [] }, r.deps);

    expect(commands()).not.toContain("start_app_audio");
    expect(openAppAudio).not.toHaveBeenCalled();
    expect(r.publishTrack).toHaveBeenCalledTimes(tracks.length);
  });

  it("publishes nothing and stops the capture when the share stops during the start", async () => {
    pickWith(true);
    let answer!: (v: unknown) => void;
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_app_audio" ? new Promise((resolve) => (answer = resolve)) : Promise.resolve(),
    );
    const h = handle();
    openAppAudio.mockResolvedValue(h);
    const r = rigSharingGame();
    const state: State = { manualScreenTracks: [] };

    const enabling = enableScreenshare(state, r.deps);
    await vi.waitFor(() => expect(answer).toBeDefined());
    await disableScreenshare(state, r.deps);
    answer({ url: "ws://127.0.0.1:9/t/app-audio" });
    await enabling;

    expect(commands()).toContain("stop_app_audio");
    expect(openAppAudio).not.toHaveBeenCalled();
    expect(publishedAudio(r)).toHaveLength(0);
    expect(r.wsSend).not.toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: true },
    });
  });

  it("closes the track and stops the capture when the share stops while the socket opens", async () => {
    pickWith(true);
    invoke.mockResolvedValue({ url: "ws://127.0.0.1:9/t/app-audio" });
    let opened!: (h: unknown) => void;
    openAppAudio.mockImplementation(() => new Promise((resolve) => (opened = resolve)));
    const r = rigSharingGame();
    const state: State = { manualScreenTracks: [] };
    const h = handle();

    const enabling = enableScreenshare(state, r.deps);
    await vi.waitFor(() => expect(opened).toBeDefined());
    await disableScreenshare(state, r.deps);
    invoke.mockClear();
    opened(h);
    await enabling;

    expect(h.close).toHaveBeenCalled();
    expect(commands()).toEqual(["stop_app_audio"]);
    expect(publishedAudio(r)).toHaveLength(0);
  });

  it("undoes the publish when the share stops while the audio track is publishing", async () => {
    pickWith(true);
    invoke.mockResolvedValue({ url: "ws://127.0.0.1:9/t/app-audio" });
    const h = handle();
    openAppAudio.mockResolvedValue(h);
    const r = rigSharingGame();
    const state: State = { manualScreenTracks: [] };
    let release!: () => void;
    r.publishTrack.mockImplementation((t: LocalTrack) =>
      t.kind === Track.Kind.Audio
        ? new Promise<void>((resolve) => (release = resolve))
        : Promise.resolve(),
    );

    const enabling = enableScreenshare(state, r.deps);
    await vi.waitFor(() => expect(release).toBeDefined());
    await disableScreenshare(state, r.deps);
    release();
    await enabling;

    expect(h.close).toHaveBeenCalled();
    expect(r.unpublishTrack).toHaveBeenCalledWith(h.track);
    expect(state.appAudio).toBeUndefined();
  });

  it("keeps the video share and toasts once when the host refuses", async () => {
    pickWith(true);
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_app_audio" ? Promise.reject("ambiguous") : Promise.resolve(),
    );
    const r = rigSharingGame();
    const state: State = { manualScreenTracks: [] };

    await enableScreenshare(state, r.deps);

    expectConsole("warn", /\[appAudioShare\] App audio did not start/);
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastText()).toContain("Couldn't share this app's sound");
    expect(state.manualScreenTracks).toHaveLength(1);
    expect(r.wsSend).toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: true },
    });
    expect(r.deps.onError).not.toHaveBeenCalled();
  });

  it.each(["not_window", "superseded", "own_window", "ancestor"])(
    "is silent for %s",
    async (code) => {
      pickWith(true);
      invoke.mockImplementation((cmd: string) =>
        cmd === "start_app_audio" ? Promise.reject(code) : Promise.resolve(),
      );
      const r = rigSharingGame();

      await enableScreenshare({ manualScreenTracks: [] }, r.deps);

      expect(toastText()).not.toContain("sound");
      expect(r.wsSend).toHaveBeenCalledWith({
        type: "voice_screenshare",
        payload: { enabled: true },
      });
    },
  );

  it("keeps the video share and toasts when the socket cannot open", async () => {
    pickWith(true);
    invoke.mockResolvedValue({ url: "ws://127.0.0.1:9/t/app-audio" });
    openAppAudio.mockRejectedValue(new Error("refused"));
    const r = rigSharingGame();
    const state: State = { manualScreenTracks: [] };

    await enableScreenshare(state, r.deps);

    expectConsole("warn", /\[appAudioShare\] App audio socket could not be opened/);
    expect(commands()).toContain("stop_app_audio");
    expect(toastText()).toContain("Couldn't share this app's sound");
    expect(state.manualScreenTracks).toHaveLength(1);
  });

  it("keeps the video share and toasts when publishing the audio fails", async () => {
    pickWith(true);
    invoke.mockResolvedValue({ url: "ws://127.0.0.1:9/t/app-audio" });
    const h = handle();
    openAppAudio.mockResolvedValue(h);
    const r = rigSharingGame();
    r.publishTrack.mockImplementation((t: LocalTrack) =>
      t.kind === Track.Kind.Audio ? Promise.reject(new Error("no")) : Promise.resolve(),
    );
    const state: State = { manualScreenTracks: [] };

    await enableScreenshare(state, r.deps);

    expectConsole("warn", /\[appAudioShare\] Publishing the app's sound failed/);
    expect(h.close).toHaveBeenCalled();
    expect(state.appAudio).toBeUndefined();
    expect(state.manualScreenTracks).toHaveLength(1);
    expect(r.wsSend).toHaveBeenCalledWith({
      type: "voice_screenshare",
      payload: { enabled: true },
    });
  });
  it("starts nothing on Linux native", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
    try {
      pickWith(true);
      const r = rig();
      const createScreenTracks = vi
        .fn()
        .mockResolvedValue([shareTrack(Track.Kind.Video, "Game", "window")]);
      (r.room.localParticipant as unknown as Record<string, unknown>).createScreenTracks =
        createScreenTracks;

      await enableScreenshare({ manualScreenTracks: [] }, r.deps);

      expect(createScreenTracks).toHaveBeenCalled();
      expect(commands()).not.toContain("start_app_audio");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("an older share's late stale cleanup does not stop a newer share's capture", async () => {
    pickWith(true);
    invoke.mockResolvedValue({ url: "ws://127.0.0.1:9/t/app-audio" });
    const hA = handle();
    const hB = handle();
    openAppAudio.mockResolvedValueOnce(hA).mockResolvedValueOnce(hB);
    const r = rig();
    const state: State = { manualScreenTracks: [] };
    let releaseA!: () => void;
    r.publishTrack.mockImplementationOnce(() => Promise.resolve()); // A's video
    r.publishTrack.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseA = resolve)), // A's audio stalls
    );
    createLocalScreenTracks.mockResolvedValueOnce([shareTrack(Track.Kind.Video, "A", "window")]);

    const enablingA = enableScreenshare(state, r.deps);
    await vi.waitFor(() => expect(releaseA).toBeDefined());
    await disableScreenshare(state, r.deps); // stop #1: correct
    expect(commands().filter((c) => c === "stop_app_audio")).toHaveLength(1);

    createLocalScreenTracks.mockResolvedValueOnce([shareTrack(Track.Kind.Video, "B", "window")]);
    await enableScreenshare(state, r.deps); // B's start installs B's capture
    expect(commands().filter((c) => c === "start_app_audio")).toHaveLength(2);
    invoke.mockClear();

    releaseA(); // A's publish resolves, stale
    await enablingA;

    expect(commands()).not.toContain("stop_app_audio");
    expect(hA.close).toHaveBeenCalled();
    expect(hB.close).not.toHaveBeenCalled();
    expect(state.appAudio).toBeDefined();
  });
});

describe("app audio teardown", () => {
  async function live() {
    pickWith(true);
    invoke.mockResolvedValue({ url: "ws://127.0.0.1:9/t/app-audio" });
    const h = handle();
    openAppAudio.mockResolvedValue(h);
    const r = rigSharingGame();
    const state: State = { manualScreenTracks: [] };
    await enableScreenshare(state, r.deps);
    invoke.mockClear();
    return { r, state, h };
  }

  it("stopManualScreenTracks (leave, reconnect, a failed enable) closes it and stops the host", async () => {
    const { r, state, h } = await live();

    stopManualScreenTracks(state, r.room);

    expect(h.close).toHaveBeenCalled();
    expect(commands()).toEqual(["stop_app_audio"]);
    expect(state.appAudio).toBeUndefined();
  });

  it("disableScreenshare (Stop sharing, the OS stop button) closes it and stops the host", async () => {
    const { r, state, h } = await live();

    await disableScreenshare(state, r.deps);

    expect(h.close).toHaveBeenCalled();
    expect(commands()).toEqual(["stop_app_audio"]);
  });

  it("closes only once however many stop paths run", async () => {
    const { r, state } = await live();

    stopManualScreenTracks(state, r.room);
    await disableScreenshare(state, r.deps);

    expect(commands()).toEqual(["stop_app_audio"]);
  });
});

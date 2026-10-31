// Tests for the track-publishing half of src/lib/voice/screenShare.ts, continued from camera.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/screenShareTracksMocks";
import { AudioPresets, Track } from "livekit-client";
import type { LocalTrack } from "livekit-client";
import { expectConsole } from "../../helpers/console";
import { initToast, teardownToast } from "@lib/ui/toast";
import type { ToastContainer } from "@components/Toast";
import {
  disableScreenshare,
  enableScreenshare,
  voiceStore,
  setScreenSourcePicker,
  fakeVideoTrack,
  fakeAudioTrack,
  fakeRoom,
  fakeDeps,
  publishCamera,
  publishScreen,
  firstPublishOptions,
  publishScreenWithAudio,
  publishedOptions,
  expectAnnounced,
  expectNotAnnounced,
  useScreenShareTracksHarness,
} from "../../helpers/screenShareTracksHarness";

vi.mock("@lib/voice/shareFps", (importOriginal) => mocks.voiceShareFpsMock(importOriginal));
vi.mock("@lib/voice/h264Profile", () => mocks.voiceH264ProfileMock());
vi.mock("../../../src/features/voice/videoCodec", (importOriginal) =>
  mocks.voiceVideoCodecMock(importOriginal),
);
vi.mock("livekit-client", (importOriginal) => mocks.livekitClientMock(importOriginal));
vi.mock("@lib/prefs/preferences", () => mocks.prefsPreferencesMock());
vi.mock("../../../src/features/voice/native/devices", () => mocks.nativeDevicesMock());

const { createLocalVideoTrack, createLocalScreenTracks, loadPref, offer120 } = mocks;

useScreenShareTracksHarness();

// ── enableScreenshare ──────────────────────────────────────────────────────

describe("enableScreenshare", () => {
  it("publishes video and audio tracks with the right sources", async () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();
    createLocalScreenTracks.mockResolvedValue([video, audio]);
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expect(rig.publishTrack).toHaveBeenCalledWith(
      video,
      expect.objectContaining({ source: Track.Source.ScreenShare }),
    );
    expect(rig.publishTrack).toHaveBeenCalledWith(
      audio,
      expect.objectContaining({ source: Track.Source.ScreenShareAudio }),
    );
    expectAnnounced(deps, "voice_screenshare", true);
    expect(voiceStore.getState().localScreenshare).toBe(true);
  });

  it("publishes the screen audio as music: no DTX, stereo, music preset", async () => {
    const { rig, video, audio } = await publishScreenWithAudio();

    const audioOpts = publishedOptions(rig, audio);
    expect(audioOpts).toMatchObject({
      source: Track.Source.ScreenShareAudio,
      dtx: false,
      forceStereo: true,
      audioPreset: AudioPresets.musicHighQualityStereo,
    });
    const videoOpts = publishedOptions(rig, video);
    expect(videoOpts).not.toHaveProperty("dtx");
    expect(videoOpts).not.toHaveProperty("forceStereo");
  });

  it("sets a video encoding on the video track only", async () => {
    const { rig, video, audio } = await publishScreenWithAudio();

    const videoOpts = publishedOptions(rig, video) as Record<string, unknown>;
    const audioOpts = publishedOptions(rig, audio) as Record<string, unknown>;
    // livekit-client reads a screen share's encoding from screenShareEncoding
    // and ignores videoEncoding for that source.
    expect(videoOpts).toHaveProperty("screenShareEncoding");
    expect(audioOpts).not.toHaveProperty("screenShareEncoding");
  });

  it("publishes the default (medium) share as 720p30 with a 720p 15 fps simulcast layer", async () => {
    const { rig, video, audio } = await publishScreenWithAudio();

    expect(createLocalScreenTracks).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: expect.objectContaining({ width: 1280, height: 720, frameRate: 30 }),
      }),
    );
    const videoOpts = publishedOptions(rig, video);
    expect(videoOpts).toMatchObject({
      source: Track.Source.ScreenShare,
      simulcast: true,
      screenShareEncoding: { maxBitrate: 3_000_000, maxFramerate: 30 },
      screenShareSimulcastLayers: [
        { width: 1280, height: 720, encoding: { maxBitrate: 1_200_000, maxFramerate: 15 } },
      ],
    });
    const audioOpts = publishedOptions(rig, audio) as Record<string, unknown>;
    expect(audioOpts).toMatchObject({ simulcast: false });
    expect(audioOpts).not.toHaveProperty("screenShareSimulcastLayers");
  });

  it("publishes the high share at 1080p with the 720p layer", async () => {
    loadPref.mockImplementation((key: string) => (key === "screenShareQuality" ? "high" : ""));
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    createLocalScreenTracks.mockResolvedValue([video]);

    await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    expect(createLocalScreenTracks).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: expect.objectContaining({ width: 1920, height: 1080, frameRate: 30 }),
      }),
    );
    expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({
      simulcast: true,
      screenShareEncoding: { maxBitrate: 6_000_000, maxFramerate: 30 },
      screenShareSimulcastLayers: [{ width: 1280, height: 720 }],
    });
  });

  it("publishes a high share at 120 fps as one layer", async () => {
    offer120.value = true;
    loadPref.mockImplementation((key: string) =>
      key === "screenShareQuality" ? "high" : key === "screenShareFps" ? 120 : "",
    );
    const rig = await publishScreen([fakeVideoTrack()]);

    const videoOpts = firstPublishOptions(rig);
    expect(videoOpts).toMatchObject({
      simulcast: false,
      screenShareEncoding: { maxBitrate: 12_000_000, maxFramerate: 120 },
      degradationPreference: "maintain-framerate",
    });
    expect(videoOpts).not.toHaveProperty("screenShareSimulcastLayers");
  });

  it("publishes a saved 120 share at 60 fps while 120 is hidden", async () => {
    loadPref.mockImplementation((key: string) =>
      key === "screenShareQuality" ? "high" : key === "screenShareFps" ? 120 : "",
    );
    const rig = await publishScreen([fakeVideoTrack()]);

    const videoOpts = firstPublishOptions(rig);
    expect(videoOpts).toMatchObject({
      screenShareEncoding: { maxFramerate: 60 },
      degradationPreference: "maintain-framerate",
    });
  });

  it("publishes 30 and 60 fps shares keeping their frame rate", async () => {
    for (const fps of [30, 60]) {
      loadPref.mockImplementation((key: string) =>
        key === "screenShareQuality" ? "high" : key === "screenShareFps" ? fps : "",
      );
      const rig = fakeRoom();
      const audio = fakeAudioTrack();
      createLocalScreenTracks.mockResolvedValue([fakeVideoTrack(), audio]);

      // oxlint-disable-next-line no-await-in-loop -- one frame rate at a time
      await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

      expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({
        degradationPreference: "maintain-framerate",
      });
      const audioOpts = publishedOptions(rig, audio);
      expect(audioOpts).not.toHaveProperty("degradationPreference");
    }
  });

  it("keeps the source share as a single full-resolution layer", async () => {
    loadPref.mockImplementation((key: string) => (key === "screenShareQuality" ? "source" : ""));
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    createLocalScreenTracks.mockResolvedValue([video]);

    await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    const videoOpts = firstPublishOptions(rig);
    expect(videoOpts).toMatchObject({ simulcast: false });
    expect(videoOpts).not.toHaveProperty("screenShareSimulcastLayers");
  });

  it("takes the camera quality from streamQuality, not the screen share pref", async () => {
    loadPref.mockImplementation((key: string) =>
      key === "streamQuality" ? "medium" : key === "screenShareQuality" ? "high" : "",
    );
    const rig = await publishCamera();

    expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({
      videoEncoding: { maxBitrate: 1_700_000 },
    });
  });

  it("adds a 720p simulcast layer to a 1080p camera, so a 1-3 Mbps viewer gets 720p not 360p", async () => {
    loadPref.mockImplementation((key: string) => (key === "streamQuality" ? "high" : ""));
    const rig = await publishCamera();

    const opts = rig.publishTrack.mock.calls[0]?.[1] as {
      videoSimulcastLayers: { width: number; height: number }[];
    };
    expect(opts.videoSimulcastLayers.map((l) => [l.width, l.height])).toEqual([
      [640, 360],
      [1280, 720],
    ]);
  });

  it("leaves a 720p camera on the SDK's default layers", async () => {
    loadPref.mockImplementation((key: string) => (key === "streamQuality" ? "medium" : ""));
    const rig = await publishCamera();

    expect(rig.publishTrack.mock.calls[0]?.[1]).not.toHaveProperty("videoSimulcastLayers");
  });

  it("defaults the camera to 720p when no quality is saved", async () => {
    loadPref.mockImplementation((_key: string, fallback: unknown) => fallback);
    await publishCamera();

    expect(createLocalVideoTrack.mock.calls[0]?.[0]).toMatchObject({
      resolution: { width: 1280, height: 720 },
    });
  });

  it("tears down when the OS stop-sharing button ends the track", async () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    createLocalScreenTracks.mockResolvedValue([video]);
    const deps = fakeDeps(rig.room);
    const state = { manualScreenTracks: [] as LocalTrack[] };

    await enableScreenshare(state, deps);
    deps.wsSend.mockClear();

    // Simulate the browser/OS ending the capture without going through the app.
    (video.mediaStreamTrack as unknown as { dispatch: (t: string) => void }).dispatch("ended");
    await vi.waitFor(() => {
      expectAnnounced(deps, "voice_screenshare", false);
    });
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("refuses when there is no voice session", async () => {
    const deps = fakeDeps(null);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expectConsole("warn", /\[screenShare\] Cannot enable screenshare: no active voice session/);
    expect(deps.onError).toHaveBeenCalledWith("Join a voice channel first");
    expect(createLocalScreenTracks).not.toHaveBeenCalled();
  });

  it("releases created tracks when publishing fails", async () => {
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    createLocalScreenTracks.mockResolvedValue([video]);
    rig.publishTrack.mockRejectedValue(new Error("publish failed"));
    const deps = fakeDeps(rig.room);
    const state = { manualScreenTracks: [] as LocalTrack[] };

    await enableScreenshare(state, deps);

    expectConsole("error", /\[screenShare\] Failed to enable screenshare/);
    // Otherwise the OS keeps showing "screen is being shared" forever.
    expect(video.stop).toHaveBeenCalled();
    expect(state.manualScreenTracks).toEqual([]);
    expect(voiceStore.getState().localScreenshare).toBe(false);
    expect(deps.onError).toHaveBeenCalledWith("Failed to start screen sharing");
  });

  it("reports a denied picker separately", async () => {
    const rig = fakeRoom();
    createLocalScreenTracks.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expectConsole("error", /\[screenShare\] Failed to enable screenshare/);
    expect(deps.onError).toHaveBeenCalledWith("Screen sharing permission denied");
  });

  it("stays silent when the user cancels the picker (polish #10)", async () => {
    // A cancel is not a denial. Chromium (WebView2) rejects a dismissed
    // picker with this NotAllowedError, and the Linux native path raises the
    // same; announcing "permission denied" for closing the dialog is wrong.
    const rig = fakeRoom();
    createLocalScreenTracks.mockRejectedValue(
      new DOMException("Permission denied by user", "NotAllowedError"),
    );
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expectConsole("error", /\[screenShare\] Failed to enable screenshare/);
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("answers a desktop portal that never started with a soft notice", async () => {
    const rig = fakeRoom();
    createLocalScreenTracks.mockRejectedValue(
      new DOMException("screen capture portal did not start", "NotAllowedError"),
    );
    const deps = fakeDeps(rig.room);
    const toasts = { show: vi.fn() };
    initToast(toasts as unknown as ToastContainer);

    try {
      await enableScreenshare({ manualScreenTracks: [] }, deps);
    } finally {
      teardownToast();
    }

    expectConsole("error", /\[screenShare\] Failed to enable screenshare/);
    // A notice, not the error channel the refusals and failures use.
    expect(deps.onError).not.toHaveBeenCalled();
    expect(toasts.show).toHaveBeenCalledWith(
      "Screen share didn't start. If you didn't cancel it, check your desktop's screen-sharing permission.",
      "info",
      undefined,
    );
  });

  it("still reports a refusal the OS made rather than the user", async () => {
    const rig = fakeRoom();
    createLocalScreenTracks.mockRejectedValue(
      new DOMException("Permission denied by system", "NotAllowedError"),
    );
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expectConsole("error", /\[screenShare\] Failed to enable screenshare/);
    expect(deps.onError).toHaveBeenCalledWith("Screen sharing permission denied");
  });

  it("reports an aborted capture as a failure, not a cancel", async () => {
    // Chromium raises AbortError for a capture that could not start (a start
    // timeout, an invalid state), never for the user closing the picker.
    const rig = fakeRoom();
    createLocalScreenTracks.mockRejectedValue(
      new DOMException("Timeout starting video source", "AbortError"),
    );
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expectConsole("error", /\[screenShare\] Failed to enable screenshare/);
    expect(deps.onError).toHaveBeenCalledWith("Failed to start screen sharing");
  });

  it("tolerates a capture with no video track", async () => {
    const rig = fakeRoom();
    createLocalScreenTracks.mockResolvedValue([fakeAudioTrack()]);
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("unpublishes a track that already published before a later one in the batch fails", async () => {
    // All quality presets request audio alongside video — a second publish
    // call (audio) can reject after the first (video) already succeeded.
    const rig = fakeRoom();
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();
    createLocalScreenTracks.mockResolvedValue([video, audio]);
    rig.publishTrack.mockImplementation((track: unknown) =>
      track === audio ? Promise.reject(new Error("publish failed")) : Promise.resolve(undefined),
    );
    const deps = fakeDeps(rig.room);
    const state = { manualScreenTracks: [] as LocalTrack[] };

    await enableScreenshare(state, deps);

    expectConsole("error", /\[screenShare\] Failed to enable screenshare/);
    // track.stop() is programmatic and never fires the DOM "ended" event, so
    // LiveKit's ended-driven auto-unpublish never runs — without an explicit
    // unpublish the video track stays live in the room while nothing in this
    // client can find its publication to clean it up later.
    expect(rig.unpublishTrack).toHaveBeenCalledWith(video.mediaStreamTrack);
    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
    expect(state.manualScreenTracks).toEqual([]);
  });

  it("discards the tracks and does not publish when disableScreenshare runs during capture", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const video = fakeVideoTrack();
    let resolveTracks!: (t: LocalTrack[]) => void;
    createLocalScreenTracks.mockReturnValue(
      new Promise((resolve) => {
        resolveTracks = resolve;
      }),
    );
    const state = { manualScreenTracks: [] as LocalTrack[] };

    const enabling = enableScreenshare(state, deps);
    // A concurrent disable runs to completion while the OS picker is still up.
    await disableScreenshare(state, deps);
    resolveTracks([video]);
    await enabling;

    expect(rig.publishTrack).not.toHaveBeenCalled();
    expect(video.stop).toHaveBeenCalled();
    expect(state.manualScreenTracks).toEqual([]);
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("does not announce the share when disableScreenshare runs during the publish loop", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();
    createLocalScreenTracks.mockResolvedValue([video, audio]);
    let resolveFirstPublish!: () => void;
    rig.publishTrack
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveFirstPublish = resolve;
        }),
      )
      .mockResolvedValue(undefined);
    const state = { manualScreenTracks: [] as LocalTrack[] };

    const enabling = enableScreenshare(state, deps);
    await vi.waitFor(() => {
      expect(rig.publishTrack).toHaveBeenCalledTimes(1);
    });
    // A concurrent disable runs to completion while the first publish is
    // still in flight — it announces voice_screenshare(false), stops both
    // tracks and empties state.manualScreenTracks.
    await disableScreenshare(state, deps);
    resolveFirstPublish();
    await enabling;

    // The superseded enable must not publish the remaining track — after the
    // disable emptied the state, only this attempt can still reach it — and
    // must not announce voice_screenshare(true) after the disable's false.
    expect(rig.publishTrack).toHaveBeenCalledTimes(1);
    expectNotAnnounced(deps, "voice_screenshare", true);
    expect(rig.unpublishTrack).toHaveBeenCalledWith(video.mediaStreamTrack);
    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
    expect(state.manualScreenTracks).toEqual([]);
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("does not tear down a newer share when a superseded enable's capture rejects", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const videoB = fakeVideoTrack();
    let rejectA!: (err: unknown) => void;
    const promiseA = new Promise<LocalTrack[]>((_, reject) => {
      rejectA = reject;
    });
    createLocalScreenTracks.mockReturnValueOnce(promiseA).mockResolvedValueOnce([videoB]);
    const state = { manualScreenTracks: [] as LocalTrack[] };

    // Attempt A starts (generation 0) and is stuck awaiting the OS picker.
    const enablingA = enableScreenshare(state, deps);
    await vi.waitFor(() => {
      expect(createLocalScreenTracks).toHaveBeenCalledTimes(1);
    });

    // The user cycles the share off and back on while A is still pending:
    // disable bumps the generation, then a fresh enable (B) captures the new
    // generation, resolves immediately, and goes fully live.
    await disableScreenshare(state, deps);
    await enableScreenshare(state, deps);
    expect(state.manualScreenTracks).toEqual([videoB]);
    expect(voiceStore.getState().localScreenshare).toBe(true);

    // Now A's stale createLocalScreenTracks call finally rejects. A's catch
    // block must recognise it was superseded and leave B's live tracks and
    // state alone.
    rejectA(new Error("capture failed"));
    await enablingA;

    expectConsole("warn", /\[screenShare\] Superseded screenshare enable failed/);
    expect(videoB.stop).not.toHaveBeenCalled();
    expect(state.manualScreenTracks).toEqual([videoB]);
    expect(voiceStore.getState().localScreenshare).toBe(true);
  });
});

// ── disableScreenshare ─────────────────────────────────────────────────────

describe("disableScreenshare", () => {
  it("stops tracks, disables sharing and announces it", async () => {
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const video = fakeVideoTrack();

    await disableScreenshare({ manualScreenTracks: [video] as LocalTrack[] }, deps);

    expect(video.stop).toHaveBeenCalled();
    expect(rig.setScreenShareEnabled).toHaveBeenCalledWith(false);
    expectAnnounced(deps, "voice_screenshare", false);
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("still clears local state when the room call throws", async () => {
    const rig = fakeRoom();
    rig.setScreenShareEnabled.mockRejectedValue(new Error("disconnected"));
    voiceStore.setState((prev) => ({ ...prev, localScreenshare: true }));

    await disableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));

    expectConsole("warn", /\[screenShare\] Failed to disable screenshare track \(non-fatal\)/);
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("works with no room", async () => {
    await disableScreenshare({ manualScreenTracks: [] }, fakeDeps(null));

    expect(voiceStore.getState().localScreenshare).toBe(false);
  });
});

describe("enableScreenshare quality step", () => {
  afterEach(() => setScreenSourcePicker(null));

  it("captures and publishes at the quality and fps picked before the OS picker", async () => {
    const picker = vi.fn().mockResolvedValue({ source: "os", quality: "high", fps: 60 });
    setScreenSourcePicker(picker);
    const rig = fakeRoom();
    createLocalScreenTracks.mockResolvedValue([fakeVideoTrack()]);
    const state = { manualScreenTracks: [] as LocalTrack[] } as Parameters<
      typeof enableScreenshare
    >[0];

    await enableScreenshare(state, fakeDeps(rig.room));

    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ osPicker: true, defaultQuality: "medium", defaultFps: 30 }),
    );
    expect(createLocalScreenTracks).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: expect.objectContaining({ width: 1920, height: 1080, frameRate: 60 }),
      }),
    );
    expect(rig.publishTrack.mock.calls[0]?.[1]).toMatchObject({
      screenShareEncoding: { maxBitrate: 9_000_000, maxFramerate: 60 },
    });
    expect(state.quality).toBe("high");
    expect(state.fps).toBe(60);
  });

  it("opens the OS picker only after the quality step", async () => {
    let goLive!: (pick: unknown) => void;
    setScreenSourcePicker(() => new Promise((resolve) => (goLive = resolve as typeof goLive)));
    const rig = fakeRoom();
    createLocalScreenTracks.mockResolvedValue([fakeVideoTrack()]);

    const enabling = enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));
    await vi.waitFor(() => expect(goLive).toBeDefined());
    expect(createLocalScreenTracks).not.toHaveBeenCalled();
    goLive({ source: "os", quality: "medium", fps: 30 });
    await enabling;

    expect(createLocalScreenTracks).toHaveBeenCalledTimes(1);
  });

  it("captures nothing and announces nothing when the quality step is closed", async () => {
    setScreenSourcePicker(() => Promise.resolve(null));
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);

    await enableScreenshare({ manualScreenTracks: [] }, deps);

    expect(createLocalScreenTracks).not.toHaveBeenCalled();
    expect(deps.wsSend).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("does not capture when the share is stopped while the quality step is open", async () => {
    let goLive!: (pick: unknown) => void;
    setScreenSourcePicker(() => new Promise((resolve) => (goLive = resolve as typeof goLive)));
    const rig = fakeRoom();
    const deps = fakeDeps(rig.room);
    const state = { manualScreenTracks: [] as LocalTrack[] };

    const enabling = enableScreenshare(state, deps);
    await vi.waitFor(() => expect(goLive).toBeDefined());
    await disableScreenshare(state, deps);
    goLive({ source: "os", quality: "high", fps: 60 });
    await enabling;

    expect(createLocalScreenTracks).not.toHaveBeenCalled();
    expectNotAnnounced(deps, "voice_screenshare", true);
    expect(voiceStore.getState().localScreenshare).toBe(false);
  });

  it("leaves Linux to its own picker: no quality step before the native capture", async () => {
    const picker = vi.fn();
    setScreenSourcePicker(picker);
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
    const rig = fakeRoom();
    const createScreenTracks = vi.fn().mockResolvedValue([fakeVideoTrack()]);
    (rig.room.localParticipant as unknown as { createScreenTracks: unknown }).createScreenTracks =
      createScreenTracks;

    try {
      await enableScreenshare({ manualScreenTracks: [] }, fakeDeps(rig.room));
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }

    expect(picker).not.toHaveBeenCalled();
    expect(createScreenTracks).toHaveBeenCalledTimes(1);
    expect(createLocalScreenTracks).not.toHaveBeenCalled();
  });

  it("shares at the saved defaults when the dialog cannot load", async () => {
    setScreenSourcePicker(() => Promise.reject(new Error("chunk failed")));
    await publishScreen([fakeVideoTrack()]);

    expectConsole("warn", /Screen share quality step unavailable/);
    expect(createLocalScreenTracks).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: expect.objectContaining({ width: 1280, height: 720, frameRate: 30 }),
      }),
    );
  });
});

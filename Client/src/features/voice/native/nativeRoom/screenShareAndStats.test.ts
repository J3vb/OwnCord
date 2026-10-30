import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../../../../tests/helpers/nativeRoomMocks";
import type { NativeVoiceStats } from "../../../../platform/contracts/nativeVoice";
import { createNativeRoom } from "../nativeRoom";
import { NativeScreenAudioTrack } from "../screenAudioTrack";
import { nativeCounters } from "../counters";
import { setLocalDeafened } from "../../../../stores/voice.store";
import { createConnectionStatsPoller } from "../../../../lib/voice/connectionStats";
import { readSenderSample } from "../../shareSenderStats";
import {
  audio,
  emit,
  video,
  settle,
  cameraOptions,
  startCamera,
  screenOptions,
  share,
  audioOptions,
  shareWithAudio,
  names,
  sample,
  getStatsCalls,
  transports,
  tile,
  remote,
  layer,
  nativeVoice,
  connected,
} from "../../../../../tests/helpers/nativeRoomHarness";

vi.mock("livekit-client", () => mocks.livekitClientMock());
vi.mock("../../../../lib/logger", () => mocks.loggerMock());
vi.mock("../videoRenderer", () => mocks.videoRendererMock());
vi.mock("../screenPicker", () => mocks.screenPickerMock());
vi.mock("../../../../platform/desktop", () => mocks.platformDesktopMock());

const { log, host } = mocks;

beforeEach(() => {
  vi.clearAllMocks();
  host.calls.length = 0;
  host.handlers.clear();
  host.unsubscribed = 0;
  host.connectResult = Promise.resolve({
    session: 1,
    identity: "user-1",
    frames: "ws://127.0.0.1:9/tok",
  });
  host.publishCamera = () => Promise.resolve("TR_cam");
  host.startCamera = () => Promise.resolve({ capture: 5, width: 1280, height: 720 });
  host.changeCamera = () => Promise.resolve({ capture: 7, width: 960, height: 720 });
  host.setVideoView = () => Promise.resolve();
  host.getStats = () => Promise.resolve(null);
  host.pick = () =>
    Promise.resolve({
      source: "screen:7",
      quality: "low",
      fps: 30,
      capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
      maxBitrate: 1_500_000,
      maxFramerate: 5,
      simulcast: false,
    });
  host.startScreen = () => Promise.resolve({ capture: 4, width: 1280, height: 720 });
  host.changeScreen = () => Promise.resolve({ capture: 6, width: 800, height: 600 });
  host.setScreenQuality = () =>
    Promise.resolve({ ok: true, sid: "TR_screen2", width: 1920, height: 1080 });
  host.notedQuality.length = 0;
  host.pickChange = () => Promise.resolve("window:9");
  host.publishScreenAudio = () => Promise.resolve("TR_audio");
  host.noted = [];
  nativeCounters.screenTracks = 0;
  host.renderers.length = 0;
  nativeCounters.openRooms = 0;
  nativeCounters.listeners = 0;
  nativeCounters.rust = null;
  setLocalDeafened(false);
});

describe("NativeRoom screen share", () => {
  it("changes the live share's source in the host, keeping the track and its preview", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await screen.changeSource();
    // The share keeps the capture settings it was started with.
    expect(host.calls.at(-1)).toEqual([
      "changeScreen",
      [1, "window:9", { fps: 30, maxWidth: 1920, maxHeight: 1080 }],
    ]);
    expect(screen).toMatchObject({ capture: 6, width: 800, height: 600 });
    expect(host.noted).toEqual(["window:9"]);
    expect(room.localParticipant.getTrackPublication("screen_share")!.track).toBe(screen);
    expect(host.renderers).toHaveLength(1);
    expect(host.renderers[0]!.disposed).toBe(false);
    // The new capture ending on its own ends the share; Stop stops it by id.
    emit({ session: 1, event: { type: "screenCaptureEnded", capture: 4 } });
    expect(host.renderers[0]!.mediaStreamTrack!.events).toEqual([]);
    emit({ session: 1, event: { type: "screenCaptureEnded", capture: 6 } });
    expect(host.renderers[0]!.mediaStreamTrack!.events).toContain("ended");
    screen.stop();
    expect(host.calls.at(-1)).toEqual(["stopScreen", [1, 6]]);
  });

  it("a cancelled or refused change leaves the live capture as it was", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    host.pickChange = () => Promise.resolve(null);
    await expect(screen.changeSource()).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(host.calls.map(([n]) => n)).not.toContain("changeScreen");
    host.pickChange = () => Promise.resolve("portal");
    host.changeScreen = () => Promise.reject(new Error("screen capture portal did not start"));
    await expect(screen.changeSource()).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(screen.capture).toBe(4);
    expect(host.noted).toEqual([]);
  });

  it("a Stop that reached the host after the swap still stops the new capture", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    let resolve!: (v: unknown) => void;
    host.changeScreen = () => new Promise((r) => (resolve = r));
    const changing = screen.changeSource();
    await vi.waitFor(() => expect(host.calls.map(([n]) => n)).toContain("changeScreen"));
    screen.stop();
    expect(host.calls.at(-1)).toEqual(["stopScreen", [1, 4]]);
    resolve({ capture: 6, width: 800, height: 600 });
    await changing;
    expect(screen.capture).toBe(4);
    expect(host.calls.at(-1)).toEqual(["stopScreen", [1, 6]]);
  });

  it("a live quality change sends the preset's capture and encoding with the published codec", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    expect(screen).toMatchObject({ quality: "low", fps: 30 });

    await screen.setQuality("high", 30, "h264");

    // High at 30 fps: 1080p, 6 Mbps and the lower simulcast layer; the codec
    // is the one the share goes out with, not the saved preference.
    expect(host.calls.at(-1)).toEqual([
      "setScreenQuality",
      [
        1,
        4,
        { fps: 30, maxWidth: 1920, maxHeight: 1080 },
        {
          width: 1280,
          height: 720,
          maxBitrate: 6_000_000,
          maxFramerate: 30,
          simulcast: true,
          codec: "h264",
        },
      ],
    ]);
    // The host sized the capture; the track and the publication follow it.
    expect(screen).toMatchObject({ quality: "high", fps: 30, width: 1920, height: 1080 });
    expect(screen.publishEncoding).toEqual({
      maxBitrate: 6_000_000,
      maxFramerate: 30,
      simulcast: true,
    });
    expect(screen.captureRequest).toEqual({ fps: 30, maxWidth: 1920, maxHeight: 1080 });
    const pub = room.localParticipant.getTrackPublication("screen_share")!;
    expect(pub.trackSid).toBe("TR_screen2");
    expect(pub.track).toBe(screen);
    expect(host.notedQuality).toEqual([["high", 30]]);
    // VP9 is a native codec (WP M-11b) and goes out as asked; H.265 is not
    // and publishes as VP8.
    await screen.setQuality("low", 30, "vp9");
    expect(host.calls.at(-1)![1][3]).toMatchObject({ codec: "vp9" });
    await screen.setQuality("low", 30, "h265");
    expect(host.calls.at(-1)![1][3]).toMatchObject({ codec: "vp8" });
  });

  it("a refused quality change leaves the share and its quality as they were", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    host.setScreenQuality = () =>
      Promise.resolve({ ok: false, stage: "refused", message: "a source change is pending" });

    await expect(screen.setQuality("high", 30, "vp8")).rejects.toMatchObject({
      name: "ScreenQualityError",
      stage: "refused",
    });

    expect(screen).toMatchObject({ quality: "low", fps: 30, width: 1280, height: 720 });
    expect(screen.captureRequest).toEqual({ fps: 30, maxWidth: 1920, maxHeight: 1080 });
    expect(room.localParticipant.getTrackPublication("screen_share")!.trackSid).toBe("TR_screen");
    expect(host.notedQuality).toEqual([]);
  });

  it("a publish-stage failure throws a typed error that names the stage", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    host.setScreenQuality = () =>
      Promise.resolve({ ok: false, stage: "publish", message: "publish failed" });

    await expect(screen.setQuality("high", 30, "vp8")).rejects.toMatchObject({
      name: "ScreenQualityError",
      stage: "publish",
      message: "publish failed",
    });
    expect(host.notedQuality).toEqual([]);
  });

  it("a quality change after a Stop is refused without asking the host", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    screen.stop();
    host.calls.length = 0;

    await expect(screen.setQuality("high", 30, "vp8")).rejects.toMatchObject({ stage: "refused" });
    expect(names()).not.toContain("setScreenQuality");
  });

  it("a Stop that overtook the host's reply leaves the stopped share alone", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    let resolve!: (v: unknown) => void;
    host.setScreenQuality = () => new Promise((r) => (resolve = r));
    const changing = screen.setQuality("high", 30, "vp8");
    await vi.waitFor(() => expect(names()).toContain("setScreenQuality"));
    screen.stop();
    resolve({ ok: true, sid: "TR_screen2", width: 1920, height: 1080 });
    await expect(changing).rejects.toMatchObject({ stage: "refused" });

    expect(screen.quality).toBe("low");
    expect(host.notedQuality).toEqual([]);
  });

  it("a codec republish after a quality change publishes the new encoding", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await screen.setQuality("high", 30, "vp8");

    await room.localParticipant.unpublishTrack(screen.mediaStreamTrack, false);
    await room.localParticipant.publishTrack(screen, screenOptions);

    expect(host.calls.at(-1)).toEqual([
      "publishScreen",
      [
        1,
        4,
        {
          width: 1920,
          height: 1080,
          maxBitrate: 6_000_000,
          maxFramerate: 30,
          simulcast: true,
          codec: "vp8",
        },
      ],
    ]);
  });

  it("Change source keeps the changed capture request", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await screen.setQuality("medium", 30, "vp8");

    await screen.changeSource();

    expect(host.calls.at(-1)).toEqual([
      "changeScreen",
      [1, "window:9", { fps: 30, maxWidth: 1280, maxHeight: 720 }],
    ]);
  });

  it("captures the picked source natively and previews it on the frame socket", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    expect(host.calls.at(-1)).toEqual([
      "startScreen",
      [1, "screen:7", { fps: 30, maxWidth: 1920, maxHeight: 1080 }],
    ]);
    expect(screen).toMatchObject({ kind: "video", source: "screen_share", capture: 4 });
    expect(host.renderers.map((r) => r.url)).toEqual(["ws://127.0.0.1:9/tok/screen"]);
    expect(screen.mediaStreamTrack).toBe(host.renderers[0]!.mediaStreamTrack);
    expect(nativeCounters.screenTracks).toBe(1);
  });

  it("publishes the capture at its size and unpublishes it by its preview track", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    const pub = await room.localParticipant.publishTrack(screen, screenOptions);
    expect(host.calls.at(-1)).toEqual([
      "publishScreen",
      [
        1,
        4,
        {
          width: 1280,
          height: 720,
          maxBitrate: 1_500_000,
          maxFramerate: 5,
          simulcast: false,
          codec: "vp8",
        },
      ],
    ]);
    expect(pub).toMatchObject({ trackSid: "TR_screen", source: "screen_share" });
    // getLocalScreenshareStream reads it by source.
    expect(room.localParticipant.getTrackPublication("screen_share")!.track).toBe(screen);
    await room.localParticipant.unpublishTrack(screen.mediaStreamTrack);
    expect(host.calls.at(-1)).toEqual(["stopScreen", [1, 4]]);
    expect(room.localParticipant.getTrackPublication("screen_share")).toBeUndefined();
    expect(host.renderers[0]!.disposed).toBe(true);
    // The shared code stops the track next: nothing more reaches the host.
    screen.stop();
    expect(host.calls.filter(([n]) => n === "stopScreen")).toHaveLength(1);
    expect(nativeCounters.screenTracks).toBe(0);
  });

  it("publishScreen passes the codec", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, { ...screenOptions, videoCodec: "h264" });
    expect(host.calls.at(-1)).toEqual([
      "publishScreen",
      [1, 4, expect.objectContaining({ codec: "h264" })],
    ]);
    // H.265 is not a native codec: it publishes VP8.
    await room.localParticipant.publishTrack(screen, { ...screenOptions, videoCodec: "h265" });
    expect(host.calls.at(-1)).toEqual([
      "publishScreen",
      [1, 4, expect.objectContaining({ codec: "vp8" })],
    ]);
  });

  it("publishScreen passes vp9", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, { ...screenOptions, videoCodec: "vp9" });
    expect(host.calls.at(-1)).toEqual([
      "publishScreen",
      [1, 4, expect.objectContaining({ codec: "vp9" })],
    ]);
  });

  it("a codec republish keeps the screen capture and publishes with the new codec", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, { ...screenOptions, videoCodec: "h264" });
    host.calls.length = 0;
    await room.localParticipant.unpublishTrack(screen.mediaStreamTrack, false);
    expect(host.calls).toEqual([["unpublishScreen", [1, 4]]]);
    expect(host.renderers[0]!.disposed).toBe(false);
    expect(nativeCounters.screenTracks).toBe(1);
    await room.localParticipant.publishTrack(screen, { ...screenOptions, videoCodec: "vp8" });
    expect(host.calls.map(([n]) => n)).toEqual(["unpublishScreen", "publishScreen"]);
    expect(host.calls.filter(([n]) => n === "stopScreen")).toHaveLength(0);
    expect(host.calls.at(-1)).toEqual([
      "publishScreen",
      [1, 4, expect.objectContaining({ codec: "vp8" })],
    ]);
    expect(room.localParticipant.getTrackPublication("screen_share")!.track).toBe(screen);
  });

  it("publishes with simulcast when the picked quality asks for it", async () => {
    host.pick = () =>
      Promise.resolve({
        source: "screen:7",
        capture: { fps: 30, maxWidth: 1280, maxHeight: 720 },
        maxBitrate: 3_000_000,
        maxFramerate: 30,
        simulcast: true,
      });
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    expect(host.calls.at(-1)).toEqual([
      "publishScreen",
      [
        1,
        4,
        {
          width: 1280,
          height: 720,
          maxBitrate: 3_000_000,
          maxFramerate: 30,
          simulcast: true,
          codec: "vp8",
        },
      ],
    ]);
  });

  it("maps a closed picker to a dismissed picker and a portal that never started to its own outcome", async () => {
    const dismissed = { name: "NotAllowedError", message: "Permission denied by user" };
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    host.pick = () => Promise.resolve(null);
    await expect(share(room)).rejects.toMatchObject(dismissed);
    expect(host.calls.filter(([n]) => n === "startScreen")).toHaveLength(0);
    host.pick = () =>
      Promise.resolve({
        source: "portal",
        capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
        maxBitrate: 6_000_000,
        maxFramerate: 30,
      });
    // The portal cannot say whether the user cancelled, so it is not the
    // silent dismissal but its own outcome.
    host.startScreen = () => Promise.reject("screen capture portal did not start");
    await expect(share(room)).rejects.toMatchObject({
      name: "NotAllowedError",
      message: "screen capture portal did not start",
    });
    // A failure before the first frame and the first-frame timeout are
    // errors the user is told about, not cancels.
    for (const failure of [
      "that screen or window is no longer available",
      "screen capture failed to start",
      "screen capture produced no frame in time",
    ]) {
      host.startScreen = () => Promise.reject(failure);
      // oxlint-disable-next-line no-await-in-loop -- each start must settle before the next
      await expect(share(room)).rejects.toBe(failure);
    }
    expect(host.renderers).toHaveLength(0);
  });

  it("raises ended on the preview when the desktop ends its capture, not a stale one", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    await share(room);
    emit({ session: 1, event: { type: "screenCaptureEnded", capture: 3 } });
    expect(host.renderers[0]!.mediaStreamTrack!.events).toEqual([]);
    emit({ session: 1, event: { type: "screenCaptureEnded", capture: 4 } });
    expect(host.renderers[0]!.mediaStreamTrack!.events).toEqual(["ended"]);
  });

  it("ends a track whose capture ended before its start result arrived", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    host.startScreen = () => {
      emit({ session: 1, event: { type: "screenCaptureEnded", capture: 4 } });
      return Promise.resolve({ capture: 4, width: 1280, height: 720 });
    };
    const screen = await share(room);
    expect(screen.mediaStreamTrack.readyState).toBe("ended");
    expect(host.renderers[0]!.mediaStreamTrack!.events).toEqual(["ended"]);
    host.startScreen = () => Promise.resolve({ capture: 5, width: 1280, height: 720 });
    const next = await share(room);
    expect(next.mediaStreamTrack.readyState).toBe("live");
  });

  it("stops the previous capture's track when a new capture replaces it", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const first = await share(room);
    host.startScreen = () => Promise.resolve({ capture: 5, width: 800, height: 600 });
    const second = await share(room);
    expect(host.renderers.map((r) => r.disposed)).toEqual([true, false]);
    expect(host.calls.filter(([n]) => n === "stopScreen")).toEqual([["stopScreen", [1, 4]]]);
    first.stop();
    expect(second.capture).toBe(5);
    expect(nativeCounters.screenTracks).toBe(1);
  });

  it("releases the screen track on disconnect and refuses one without a session", async () => {
    const room = createNativeRoom(audio);
    await expect(share(room)).rejects.toThrow(/not connected/);
    await room.connect("u", "t");
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await room.disconnect();
    expect(host.renderers[0]!.disposed).toBe(true);
    expect(room.localParticipant.getTrackPublication("screen_share")).toBeUndefined();
    expect(nativeCounters.screenTracks).toBe(0);
  });

  it("drops a capture that finished starting after the room disconnected", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    let finish: (() => void) | undefined;
    host.startScreen = () =>
      new Promise((r) => (finish = () => r({ capture: 4, width: 1, height: 1 })));
    const sharing = share(room);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await room.disconnect();
    finish!();
    await expect(sharing).rejects.toThrow(/disconnected/);
    expect(host.renderers).toHaveLength(0);
  });
});

describe("NativeRoom stats", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the stats poller reads ping, loss and jitter from the native reply", async () => {
    host.getStats = () => Promise.resolve(sample());
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const poller = createConnectionStatsPoller(() => room as never);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);
    const stats = poller.getStats();
    poller.stop();
    expect(stats.available).toBe(true);
    expect(stats.rtt).toBeCloseTo(42, 5);
    expect(stats.jitter).toBeCloseTo(4, 5);
    expect(stats.quality).toBe("excellent");
    expect(stats.totalUp).toBe(900);
  });

  it("one host call per tick is shared by the poller, a tile and the share", async () => {
    host.getStats = () =>
      Promise.resolve(
        sample({
          remoteVideo: {
            TR_v: {
              frameWidth: 640,
              frameHeight: 360,
              framesDecoded: 1,
              bytesReceived: 1,
              packetsLost: 0,
              packetsReceived: 1,
            },
          },
          localVideo: {
            screen_share: [
              { frameWidth: 1, frameHeight: 1, qualityLimitationReason: "none", active: true },
            ],
          },
        }),
      );
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    const watched = room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!.track!;
    const screen = await share(room);
    await Promise.all([
      transports(room).publisher.getStats(),
      transports(room).subscriber.getStats(),
      watched.getReceiverStats(),
      screen.getSenderStats(),
    ]);
    expect(getStatsCalls()).toEqual([["getStats", [1]]]);
    await vi.advanceTimersByTimeAsync(1500);
    await transports(room).publisher.getStats();
    expect(getStatsCalls()).toHaveLength(2);
  });

  it("no host call and no report while not connected", async () => {
    host.getStats = () => Promise.resolve(sample());
    const room = createNativeRoom(audio);
    expect(await transports(room).publisher.getStats()).toBeUndefined();
    await room.connect("u", "t");
    emit({ session: 1, event: { type: "reconnecting" } });
    expect(await transports(room).publisher.getStats()).toBeUndefined();
    emit({ session: 1, event: { type: "reconnected" } });
    expect(await transports(room).publisher.getStats()).toBeDefined();
    expect(getStatsCalls()).toHaveLength(1);
    await room.disconnect();
    expect(await transports(room).publisher.getStats()).toBeUndefined();
    expect(getStatsCalls()).toHaveLength(1);
  });

  it("a reply that lands after disconnect is dropped", async () => {
    let land: ((s: NativeVoiceStats) => void) | undefined;
    host.getStats = () => new Promise((r) => (land = r));
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const pending = transports(room).publisher.getStats();
    await room.disconnect();
    land!(sample());
    expect(await pending).toBeUndefined();
  });

  it("a failed reply reads as no transports", async () => {
    host.getStats = () => Promise.resolve(null);
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const poller = createConnectionStatsPoller(() => room as never);
    const updates = vi.fn();
    poller.onUpdate(updates);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);
    poller.stop();
    expect(updates).not.toHaveBeenCalled();
    expect(poller.getStats().available).toBe(false);
    // A rejecting host is the same as a null one, and is not cached as a rejection.
    host.getStats = () => Promise.reject(new Error("boom"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await transports(room).publisher.getStats()).toBeUndefined();
  });

  it("an empty transport list is no report, not an empty one", async () => {
    host.getStats = () => Promise.resolve(sample({ publisher: [], subscriber: [] }));
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    expect(await transports(room).publisher.getStats()).toBeUndefined();
    expect(await transports(room).subscriber.getStats()).toBeUndefined();
  });

  it("serves each side's entries by id as a report", async () => {
    host.getStats = () => Promise.resolve(sample());
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const report = await transports(room).publisher.getStats();
    expect([...report!.keys()]).toEqual(["CP1", "OA1", "IA1"]);
    expect(await transports(room).subscriber.getStats()).toBeUndefined();
  });

  it("getReceiverStats maps the tile sample and bitrate comes from byte deltas", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const tileTrack = await tile(room);
    host.getStats = () => Promise.resolve(sample({ atMs: 1000, remoteVideo: { TR_v: remote(0) } }));
    const first = await tileTrack.getReceiverStats();
    expect(tileTrack.currentBitrate).toBeUndefined();
    expect(first).toEqual({
      frameWidth: 1280,
      frameHeight: 720,
      framesDecoded: 60,
      timestamp: 1000,
      mimeType: "video/VP8",
      packetsLost: 2,
      packetsReceived: 300,
    });
    await vi.advanceTimersByTimeAsync(2000);
    host.getStats = () =>
      Promise.resolve(sample({ atMs: 3000, remoteVideo: { TR_v: remote(250_000) } }));
    await tileTrack.getReceiverStats();
    expect(tileTrack.currentBitrate).toBe(1_000_000);
  });

  it("getReceiverStats is undefined for a sid not in the reply and after dispose", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const tileTrack = await tile(room);
    host.getStats = () => Promise.resolve(sample({ remoteVideo: { TR_other: remote(1) } }));
    expect(await tileTrack.getReceiverStats()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    host.getStats = () => Promise.resolve(sample({ remoteVideo: { TR_v: remote(1) } }));
    expect(await tileTrack.getReceiverStats()).toBeDefined();
    tileTrack.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await tileTrack.getReceiverStats()).toBeUndefined();
  });

  it("getSenderStats returns the share's layers and readSenderSample gives the sent fps", async () => {
    host.getStats = () =>
      Promise.resolve(sample({ localVideo: { screen_share: [layer(30), layer(15)] } }));
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const screen = await share(room);
    expect(await screen.getSenderStats()).toEqual([layer(30), layer(15)]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await readSenderSample(screen)).toMatchObject({ sentFps: 30, limitation: "cpu" });
    await vi.advanceTimersByTimeAsync(2000);
    host.getStats = () => Promise.resolve(sample());
    await expect(screen.getSenderStats()).rejects.toThrow(/unavailable/);
    await vi.advanceTimersByTimeAsync(2000);
    host.getStats = () => Promise.resolve(null);
    await expect(screen.getSenderStats()).rejects.toThrow(/unavailable/);
  });

  it("the ICE getters read unknown rather than throw", async () => {
    const room = createNativeRoom(audio);
    const pub = room.engine.pcManager.publisher;
    expect([
      pub.getICEConnectionState(),
      pub.getConnectionState(),
      pub.getSignallingState(),
    ]).toEqual(["unknown", "unknown", "unknown"]);
  });
});

describe("NativeRoom screen-share audio", () => {
  beforeEach(() => {
    (HTMLCanvasElement.prototype as unknown as { captureStream: () => unknown }).captureStream =
      () => ({ getVideoTracks: () => [{ stop() {} }] });
  });
  afterEach(() => {
    delete (HTMLCanvasElement.prototype as unknown as { captureStream?: unknown }).captureStream;
  });

  it("createScreenTracks adds a screen-audio track when the pick asks for it", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const none = await room.localParticipant.createScreenTracks();
    expect(none).toHaveLength(1);
    const { audioTrack } = await shareWithAudio(room);
    expect(audioTrack).toBeInstanceOf(NativeScreenAudioTrack);
    expect(audioTrack).toMatchObject({ kind: "audio", source: "screen_share_audio" });
  });

  it("publishing screen_share_audio calls the host and stores the publication", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    const pub = await room.localParticipant.publishTrack(audioTrack, audioOptions);
    expect(host.calls.at(-1)).toEqual(["publishScreenAudio", [1, 4]]);
    expect(pub).toMatchObject({
      trackSid: "TR_audio",
      source: "screen_share_audio",
      kind: "audio",
    });
    expect(room.localParticipant.getTrackPublication("screen_share_audio")!.track).toBe(audioTrack);
    // Unpublishing by the token unpublishes the sid and nothing else.
    await room.localParticipant.unpublishTrack(audioTrack.mediaStreamTrack);
    expect(host.calls.at(-1)).toEqual(["unpublishScreenAudio", [1, "TR_audio"]]);
    expect(room.localParticipant.getTrackPublication("screen_share_audio")).toBeUndefined();
    expect(room.localParticipant.getTrackPublication("screen_share")).toBeDefined();
  });

  it("a codec republish unpublishes only the video", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await room.localParticipant.publishTrack(audioTrack, audioOptions);
    host.calls.length = 0;
    await room.localParticipant.unpublishTrack(screen.mediaStreamTrack, false);
    expect(host.calls).toEqual([["unpublishScreen", [1, 4]]]);
    expect(room.localParticipant.getTrackPublication("screen_share_audio")!.track).toBe(audioTrack);
    await room.localParticipant.publishTrack(screen, screenOptions);
    expect(names()).toEqual(["unpublishScreen", "publishScreen"]);
  });

  it("stopping the audio track unpublishes its sid once, and a stop of the share ends it too", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await room.localParticipant.publishTrack(audioTrack, audioOptions);
    host.calls.length = 0;
    audioTrack.stop();
    audioTrack.stop();
    expect(host.calls).toEqual([["unpublishScreenAudio", [1, "TR_audio"]]]);
    expect(room.localParticipant.getTrackPublication("screen_share_audio")).toBeUndefined();

    // Stopping the video stops the audio that follows it.
    const second = await shareWithAudio(room);
    await room.localParticipant.publishTrack(second.audioTrack, audioOptions);
    host.calls.length = 0;
    second.screen.stop();
    expect(second.audioTrack.isStopped).toBe(true);
    expect(names()).toEqual(["unpublishScreenAudio", "stopScreen"]);
  });

  it("a_share_audio_stopped_mid_publish_is_unpublished_when_its_sid_lands", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    let land!: (sid: string) => void;
    host.publishScreenAudio = () => new Promise<string>((resolve) => (land = resolve));
    const publishing = room.localParticipant.publishTrack(audioTrack, audioOptions);
    await vi.waitFor(() => expect(names()).toContain("publishScreenAudio"));
    audioTrack.stop();
    // Nothing to unpublish yet: the sid is unknown.
    expect(names()).not.toContain("unpublishScreenAudio");
    land("TR_late");
    await publishing;
    expect(host.calls.at(-1)).toEqual(["unpublishScreenAudio", [1, "TR_late"]]);
    expect(room.localParticipant.getTrackPublication("screen_share_audio")).toBeUndefined();
  });

  it("a_share_audio_publish_after_disconnect_throws_and_keeps_nothing", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    let land!: (sid: string) => void;
    host.publishScreenAudio = () => new Promise<string>((resolve) => (land = resolve));
    const publishing = room.localParticipant.publishTrack(audioTrack, audioOptions);
    await vi.waitFor(() => expect(names()).toContain("publishScreenAudio"));
    await room.disconnect();
    land("TR_late");
    await expect(publishing).rejects.toThrow(
      "native room disconnected during screen audio publish",
    );
    expect(room.localParticipant.getTrackPublication("screen_share_audio")).toBeUndefined();
    expect(names()).not.toContain("unpublishScreenAudio");
  });

  it("refuses a screen-audio publish while no share is running", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const orphan = new NativeScreenAudioTrack(() => {});
    await expect(room.localParticipant.publishTrack(orphan, audioOptions)).rejects.toThrow(
      "screen share is not running",
    );
    expect(names()).not.toContain("publishScreenAudio");
  });

  it("a stale screen track's late stop leaves the live share's audio", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const first = await shareWithAudio(room);
    host.startScreen = () => Promise.resolve({ capture: 5, width: 800, height: 600 });
    const second = await shareWithAudio(room);
    await room.localParticipant.publishTrack(second.screen, screenOptions);
    await room.localParticipant.publishTrack(second.audioTrack, audioOptions);
    first.screen.stop();
    expect(second.audioTrack.isStopped).toBe(false);
    expect(room.localParticipant.getTrackPublication("screen_share_audio")!.track).toBe(
      second.audioTrack,
    );
  });

  it("refuses a stale audio track's publish so it cannot replace a newer share's", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const first = await shareWithAudio(room);
    await shareWithAudio(room);
    host.calls.length = 0;
    await expect(
      room.localParticipant.publishTrack(first.audioTrack, audioOptions),
    ).rejects.toThrow("stale");
    expect(names()).not.toContain("publishScreenAudio");
  });

  it("disconnect stops the audio track", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await room.localParticipant.publishTrack(audioTrack, audioOptions);
    await room.disconnect();
    expect(audioTrack.isStopped).toBe(true);
    expect(room.localParticipant.getTrackPublication("screen_share_audio")).toBeUndefined();
  });

  it("a Change source keeps the screen_share_audio publication", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await room.localParticipant.publishTrack(audioTrack, audioOptions);
    host.calls.length = 0;
    await screen.changeSource();
    expect(screen.capture).toBe(6);
    expect(names()).toEqual(["changeScreen"]);
    expect(audioTrack.isStopped).toBe(false);
    expect(room.localParticipant.getTrackPublication("screen_share_audio")!.track).toBe(audioTrack);
  });
});

describe("NativeRoom screen publication", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names the refusals it makes", async () => {
    const room = createNativeRoom(audio);
    const browserTrack = { kind: "video", source: "screen_share", mediaStreamTrack: {} } as never;
    await expect(room.localParticipant.publishTrack(browserTrack, screenOptions)).rejects.toThrow(
      "native room is not connected",
    );
    await expect(
      room.localParticipant.publishTrack(
        { kind: "audio", source: "screen_share_audio", mediaStreamTrack: {} } as never,
        audioOptions,
      ),
    ).rejects.toThrow("native room is not connected");
    await room.connect("u", "t");
    await expect(room.localParticipant.publishTrack(browserTrack, screenOptions)).rejects.toThrow(
      "publishing a browser screen track is not available on Linux yet",
    );
    await expect(
      room.localParticipant.publishTrack(
        { kind: "audio", source: "screen_share_audio", mediaStreamTrack: {} } as never,
        audioOptions,
      ),
    ).rejects.toThrow("publishing a browser screen audio track is not available on Linux yet");
    await expect(room.localParticipant.setScreenShareEnabled(true)).rejects.toThrow(
      "setScreenShareEnabled(true) is not available on Linux yet",
    );
  });

  it("routes a publish by the option's source before the track's own", async () => {
    const room = await connected();
    const browserCamera = { kind: "video", source: "camera", mediaStreamTrack: {} } as never;
    await expect(
      room.localParticipant.publishTrack(browserCamera, { source: "screen_share" }),
    ).rejects.toThrow("browser screen track");
    await expect(
      room.localParticipant.publishTrack(browserCamera, { simulcast: false }),
    ).rejects.toThrow("browser camera track");
    const orphan = new NativeScreenAudioTrack(() => {});
    await expect(room.localParticipant.publishTrack(orphan, {})).rejects.toThrow(
      "screen share is not running",
    );
  });

  it("publishes a screen share as unmuted video", async () => {
    const room = await connected();
    const screen = await share(room);
    const publication = await room.localParticipant.publishTrack(screen, screenOptions);
    expect(publication).toMatchObject({
      trackSid: "TR_screen",
      source: "screen_share",
      kind: "video",
      isMuted: false,
      track: screen,
    });
  });

  it("keeps nothing when the room left while the host published the share", async () => {
    const room = await connected();
    const screen = await share(room);
    let finish!: () => void;
    vi.spyOn(nativeVoice, "publishScreen").mockImplementation(
      () => new Promise((r) => (finish = () => r("TR_late"))),
    );
    const publishing = room.localParticipant.publishTrack(screen, screenOptions);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await room.disconnect();
    finish();
    await expect(publishing).rejects.toThrow("native room disconnected during screen publish");
    expect(room.localParticipant.getTrackPublication("screen_share")).toBeUndefined();
  });

  it("turning the share off stops its capture and forgets the publication", async () => {
    const room = await connected();
    const screen = await share(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    host.calls.length = 0;
    await room.localParticipant.setScreenShareEnabled(false);
    expect(host.calls).toEqual([["stopScreen", [1, 4]]]);
    expect(host.renderers[0]!.disposed).toBe(true);
    expect(room.localParticipant.getTrackPublication("screen_share")).toBeUndefined();
  });

  it("drops a leftover publication of a replaced share when the room disconnects", async () => {
    const room = await connected();
    const old = await share(room);
    host.startScreen = () => Promise.resolve({ capture: 5, width: 800, height: 600 });
    await share(room);
    await room.localParticipant.publishTrack(old, screenOptions);
    expect(room.localParticipant.getTrackPublication("screen_share")!.track).toBe(old);
    await room.disconnect();
    expect(room.localParticipant.getTrackPublication("screen_share")).toBeUndefined();
  });

  it("drops a leftover publication of a replaced camera when the room disconnects", async () => {
    const room = await connected();
    const old = await startCamera(room);
    host.startCamera = () => Promise.resolve({ capture: 6, width: 1280, height: 720 });
    await startCamera(room);
    await room.localParticipant.publishTrack(old, cameraOptions);
    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(old);
    await room.disconnect();
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
  });

  it("logs a stop the host refused, for the capture it named", async () => {
    const room = await connected();
    const screen = await share(room);
    const err = new Error("gone");
    vi.spyOn(nativeVoice, "stopScreen").mockRejectedValue(err);
    screen.stop();
    await settle();
    expect(log.warn).toHaveBeenCalledWith("native stopScreen failed", { capture: 4, err });
  });
});

describe("NativeRoom screen capture", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts nothing when the room left during the pick", async () => {
    const room = await connected();
    let choose!: (pick: unknown) => void;
    host.pick = () => new Promise((r) => (choose = r));
    const sharing = share(room);
    await vi.waitFor(() => expect(choose).toBeDefined());
    await room.disconnect();
    choose({
      source: "screen:7",
      capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
      maxBitrate: 1_500_000,
      maxFramerate: 5,
    });
    await expect(sharing).rejects.toThrow("native room disconnected during screen pick");
    expect(names()).not.toContain("startScreen");
  });

  it("ends a share with audio whose capture ended before its start result, and only that one", async () => {
    (HTMLCanvasElement.prototype as unknown as { captureStream: () => unknown }).captureStream =
      () => ({ getVideoTracks: () => [{ stop() {} }] });
    try {
      const room = await connected();
      host.startScreen = () => {
        emit({ session: 1, event: { type: "screenCaptureEnded", capture: 4 } });
        return Promise.resolve({ capture: 4, width: 1280, height: 720 });
      };
      const { screen } = await shareWithAudio(room);
      expect(screen.mediaStreamTrack.readyState).toBe("ended");
      host.startScreen = () => Promise.resolve({ capture: 5, width: 1280, height: 720 });
      const next = await shareWithAudio(room);
      expect(next.screen.mediaStreamTrack.readyState).toBe("live");
    } finally {
      delete (HTMLCanvasElement.prototype as unknown as { captureStream?: unknown }).captureStream;
    }
  });

  it("refuses a Change source once the share was stopped", async () => {
    const room = await connected();
    const screen = await share(room);
    screen.stop();
    host.calls.length = 0;
    await expect(screen.changeSource()).rejects.toThrow("screen share is no longer live");
    expect(names()).toEqual([]);
  });

  it("drops a Change source whose share was stopped during the pick", async () => {
    const room = await connected();
    const screen = await share(room);
    let choose!: (source: string) => void;
    host.pickChange = () => new Promise((r) => (choose = r));
    const changing = screen.changeSource();
    await vi.waitFor(() => expect(choose).toBeDefined());
    screen.stop();
    host.calls.length = 0;
    choose("window:9");
    await expect(changing).rejects.toThrow("screen share ended during the pick");
    expect(names()).toEqual([]);
  });

  it("a capture that ends during Change source ends the track only when it is the new one", async () => {
    for (const ended of [99, 6]) {
      // oxlint-disable-next-line no-await-in-loop -- each round builds its own room
      const room = await connected();
      // oxlint-disable-next-line no-await-in-loop -- the room must be up first
      const screen = await share(room);
      let resolve!: (v: unknown) => void;
      host.changeScreen = () => new Promise((r) => (resolve = r));
      const changing = screen.changeSource();
      // oxlint-disable-next-line no-await-in-loop -- the host call must be pending first
      await vi.waitFor(() => expect(names()).toContain("changeScreen"));
      emit({ session: 1, event: { type: "screenCaptureEnded", capture: ended } });
      resolve({ capture: 6, width: 800, height: 600 });
      // oxlint-disable-next-line no-await-in-loop -- one share at a time
      await changing;
      expect(host.renderers.at(-1)!.mediaStreamTrack!.events).toEqual(ended === 6 ? ["ended"] : []);
      // oxlint-disable-next-line no-await-in-loop -- the next round needs the registry clear
      await room.disconnect();
    }
  });

  it("leaves a share that was stopped by a room leaving mid-change without a stop on the old session", async () => {
    const room = await connected();
    const screen = await share(room);
    let resolve!: (v: unknown) => void;
    host.changeScreen = () => new Promise((r) => (resolve = r));
    const changing = screen.changeSource();
    await vi.waitFor(() => expect(names()).toContain("changeScreen"));
    await room.disconnect();
    host.calls.length = 0;
    resolve({ capture: 6, width: 800, height: 600 });
    await changing;
    expect(host.calls).toEqual([]);
  });

  it("logs the stop of a swapped-in capture the host refused", async () => {
    const room = await connected();
    const screen = await share(room);
    let resolve!: (v: unknown) => void;
    host.changeScreen = () => new Promise((r) => (resolve = r));
    const changing = screen.changeSource();
    await vi.waitFor(() => expect(names()).toContain("changeScreen"));
    const err = new Error("gone");
    vi.spyOn(nativeVoice, "stopScreen").mockRejectedValue(err);
    screen.stop();
    resolve({ capture: 6, width: 800, height: 600 });
    await changing;
    await settle();
    expect(log.warn).toHaveBeenCalledWith("native stopScreen failed", { capture: 6, err });
  });

  it("explains a quality change refused after a Stop, or one a Stop overtook", async () => {
    const room = await connected();
    const stopped = await share(room);
    stopped.stop();
    await expect(stopped.setQuality("high", 30, "vp8")).rejects.toMatchObject({
      stage: "refused",
      message: "screen share is no longer live",
    });

    host.startScreen = () => Promise.resolve({ capture: 5, width: 800, height: 600 });
    const live = await share(room);
    let resolve!: (v: unknown) => void;
    host.setScreenQuality = () => new Promise((r) => (resolve = r));
    const changing = live.setQuality("high", 30, "vp8");
    await vi.waitFor(() => expect(names()).toContain("setScreenQuality"));
    live.stop();
    resolve({ ok: true, sid: "TR_screen2", width: 1920, height: 1080 });
    await expect(changing).rejects.toMatchObject({
      stage: "refused",
      message: "the share ended during the change",
    });
  });
});

describe("NativeRoom screen audio publication", () => {
  beforeEach(() => {
    (HTMLCanvasElement.prototype as unknown as { captureStream: () => unknown }).captureStream =
      () => ({ getVideoTracks: () => [{ stop() {} }] });
  });
  afterEach(() => {
    delete (HTMLCanvasElement.prototype as unknown as { captureStream?: unknown }).captureStream;
    vi.restoreAllMocks();
  });

  it("publishes the share's audio as unmuted audio", async () => {
    const room = await connected();
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    const publication = await room.localParticipant.publishTrack(audioTrack, audioOptions);
    expect(publication).toMatchObject({
      trackSid: "TR_audio",
      source: "screen_share_audio",
      kind: "audio",
      isMuted: false,
      track: audioTrack,
    });
  });

  it("refuses an audio track that never belonged to the running share", async () => {
    const room = await connected();
    await share(room);
    host.calls.length = 0;
    const stranger = new NativeScreenAudioTrack(() => {});
    await expect(room.localParticipant.publishTrack(stranger, audioOptions)).rejects.toThrow(
      "screen audio is stale",
    );
    expect(names()).toEqual([]);
  });

  it("logs a sid the host would not unpublish after a stop mid-publish", async () => {
    const room = await connected();
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    let land!: (sid: string) => void;
    host.publishScreenAudio = () => new Promise<string>((resolve) => (land = resolve));
    const publishing = room.localParticipant.publishTrack(audioTrack, audioOptions);
    await vi.waitFor(() => expect(names()).toContain("publishScreenAudio"));
    audioTrack.stop();
    const err = new Error("gone");
    vi.spyOn(nativeVoice, "unpublishScreenAudio").mockRejectedValue(err);
    land("TR_late");
    await publishing;
    expect(log.warn).toHaveBeenCalledWith("native unpublishScreenAudio failed", {
      sid: "TR_late",
      err,
    });
  });

  it("logs a stop of the audio track the host would not unpublish", async () => {
    const room = await connected();
    const { screen, audioTrack } = await shareWithAudio(room);
    await room.localParticipant.publishTrack(screen, screenOptions);
    await room.localParticipant.publishTrack(audioTrack, audioOptions);
    const err = new Error("gone");
    vi.spyOn(nativeVoice, "unpublishScreenAudio").mockRejectedValue(err);
    audioTrack.stop();
    await settle();
    expect(log.warn).toHaveBeenCalledWith("native unpublishScreenAudio failed", {
      sid: "TR_audio",
      err,
    });
  });
});

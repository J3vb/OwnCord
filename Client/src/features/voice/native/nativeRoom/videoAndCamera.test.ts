import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../../../../tests/helpers/nativeRoomMocks";
import { createNativeRoom } from "../nativeRoom";
import { savePref } from "../../../../lib/prefs/preferences";
import { nativeCounters } from "../counters";
import { CameraDeviceUnusable, CameraSwitchUnavailable } from "../../cameraSwitch";
import {
  setEncryptionDegraded,
  setLocalDeafened,
  voiceStore,
} from "../../../../stores/voice.store";
import {
  createRoomEventHandlers,
  type RoomEventDeps,
} from "../../../../lib/voice/roomEventHandlers";
import {
  audio,
  emit,
  video,
  views,
  settle,
  cameraOptions,
  startCamera,
  track2,
  publishedCamera,
  names,
  sample,
  getStatsCalls,
  transports,
  tile,
  remote,
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

describe("NativeRoom remote video", () => {
  it("raises a subscribed video track backed by a renderer on the frame socket", async () => {
    const room = createNativeRoom(audio);
    const subscribed = vi.fn();
    room.on("trackSubscribed", subscribed);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_v") },
    });
    expect(host.renderers).toHaveLength(0);
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    expect(host.renderers.map((r) => r.url)).toEqual(["ws://127.0.0.1:9/tok/remote/TR_v"]);
    const [raised, pub, participant] = subscribed.mock.calls[0]!;
    expect(raised).toMatchObject({
      kind: "video",
      sid: "TR_v",
      mediaStreamTrack: { id: "canvas-0" },
    });
    expect(pub).toMatchObject({ source: "camera", track: raised });
    expect(participant).toBe(room.remoteParticipants.get("user-2"));
    expect(room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!.track).toBe(
      raised,
    );
    // Audio still raises nothing: its playout is native.
    emit({ session: 1, event: { type: "trackSubscribed", identity: "user-2", track: track2() } });
    expect(subscribed).toHaveBeenCalledTimes(1);
  });

  it("disposes the renderer and raises TrackUnsubscribed when the track goes away", async () => {
    const room = createNativeRoom(audio);
    const unsubscribed = vi.fn();
    room.on("trackUnsubscribed", unsubscribed);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    emit({ session: 1, event: { type: "trackUnsubscribed", identity: "user-2", sid: "TR_v" } });
    expect(host.renderers[0]!.disposed).toBe(true);
    expect(unsubscribed).toHaveBeenCalledTimes(1);
    expect(unsubscribed.mock.calls[0]![0]).toMatchObject({ kind: "video", sid: "TR_v" });
    // A resubscribe gets a fresh renderer; an unpublish disposes it too.
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    emit({ session: 1, event: { type: "trackUnpublished", identity: "user-2", sid: "TR_v" } });
    expect(host.renderers.map((r) => r.disposed)).toEqual([true, true]);
    expect(unsubscribed).toHaveBeenCalledTimes(2);
    expect(room.remoteParticipants.get("user-2")!.trackPublications.size).toBe(0);
  });

  it("replaces the renderer when a subscribed track is subscribed again", async () => {
    const room = createNativeRoom(audio);
    const unsubscribed = vi.fn();
    room.on("trackUnsubscribed", unsubscribed);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    expect(host.renderers.map((r) => r.disposed)).toEqual([true, false]);
    expect(unsubscribed).toHaveBeenCalledTimes(1);
  });

  it("forwards the layer controls RemoteTracks drives to the native session", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    const pub = room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!;
    expect(pub.isEnabled).toBe(true);

    // Hidden: the stream stops.
    pub.setEnabled(false);
    expect(pub.isEnabled).toBe(false);
    // Shown in a 160-px tile: the layer waits for the enable, one update.
    pub.setVideoDimensions({ width: 160, height: 90 });
    pub.setEnabled(true);
    expect(pub.isEnabled).toBe(true);
    // Resized to 480 px, then focused (the top layer); a repeat sends nothing.
    pub.setVideoDimensions({ width: 480, height: 270 });
    pub.setEnabled(true);
    pub.setVideoQuality(2);
    pub.setEnabled(true);
    await settle();
    expect(views()).toEqual([
      [1, "user-2", "TR_v", false, "high"],
      [1, "user-2", "TR_v", true, "low"],
      [1, "user-2", "TR_v", true, "medium"],
      [1, "user-2", "TR_v", true, "high"],
    ]);

    // A resubscribe comes enabled at the top layer, so hiding it is sent again.
    pub.setEnabled(false);
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    expect(pub.isEnabled).toBe(true);
    pub.setEnabled(false);
    await settle();
    expect(views().slice(-2)).toEqual([
      [1, "user-2", "TR_v", false, "high"],
      [1, "user-2", "TR_v", false, "high"],
    ]);
  });

  it("sends a publication's next view only once the host has applied the previous one", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    const pub = room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!;
    let applied!: () => void;
    host.setVideoView = () => new Promise<void>((r) => (applied = r));

    // Hidden, then shown again before the host finished hiding it.
    pub.setEnabled(false);
    pub.setEnabled(true);
    await settle();
    expect(views()).toEqual([[1, "user-2", "TR_v", false, "high"]]);
    applied();
    await settle();
    expect(views()).toEqual([
      [1, "user-2", "TR_v", false, "high"],
      [1, "user-2", "TR_v", true, "high"],
    ]);
  });

  it("raises the unsubscriptions before the participant leaves", async () => {
    const room = createNativeRoom(audio);
    const order: string[] = [];
    room.on("trackUnsubscribed", () => order.push("trackUnsubscribed"));
    room.on("participantDisconnected", () => order.push("participantDisconnected"));
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    emit({ session: 1, event: { type: "participantDisconnected", identity: "user-2" } });
    expect(order).toEqual(["trackUnsubscribed", "participantDisconnected"]);
    expect(host.renderers[0]!.disposed).toBe(true);
  });

  it("raises TrackPublished for a new publication and TrackUnpublished when it goes", async () => {
    const room = createNativeRoom(audio);
    const order: string[] = [];
    room.on("trackPublished", (pub) =>
      order.push(`published ${(pub as { trackSid: string }).trackSid}`),
    );
    room.on("trackUnsubscribed", () => order.push("trackUnsubscribed"));
    room.on("trackUnpublished", (pub) =>
      order.push(`unpublished ${(pub as { trackSid: string }).trackSid}`),
    );
    room.on("participantDisconnected", () => order.push("participantDisconnected"));
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_v") },
    });
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_s", "screen_share") },
    });
    emit({ session: 1, event: { type: "trackUnpublished", identity: "user-2", sid: "TR_s" } });
    emit({ session: 1, event: { type: "participantDisconnected", identity: "user-2" } });
    // livekit-client's order: unsubscribed, then unpublished, then the leave.
    expect(order).toEqual([
      "published TR_v",
      "published TR_s",
      "unpublished TR_s",
      "trackUnsubscribed",
      "unpublished TR_v",
      "participantDisconnected",
    ]);
  });

  it("opt-in watching: the backend's auto-subscription of an unwatched stream raises no track", async () => {
    const room = createNativeRoom(audio);
    const watched = new Set<string>();
    const onRemoteVideo = vi.fn();
    const handlers = createRoomEventHandlers({
      isWatched: (uid: number, screen: boolean) => watched.has(`${uid}:${String(screen)}`),
      getOnRemoteVideoCallback: () => onRemoteVideo,
    } as unknown as RoomEventDeps);
    room.on("trackPublished", (pub, p) => handlers.handleTrackPublished(pub as never, p as never));
    room.on("trackSubscribed", (t, pub, p) =>
      handlers.handleTrackSubscribed(t as never, pub as never, p as never),
    );
    await room.connect("u", "t");
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: unknown[]) {}
      },
    );

    // The backend subscribes every track as it is published; the shared
    // handler unsubscribes the camera at once, and the late subscription
    // that was already on its way is dropped.
    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_v") },
    });
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    expect(host.calls).toContainEqual(["setSubscribed", [1, "user-2", "TR_v", false]]);
    expect(host.renderers).toHaveLength(0);
    expect(onRemoteVideo).toHaveBeenCalledTimes(1);
    expect(onRemoteVideo).toHaveBeenCalledWith(2, null, false);

    // Watch: subscribed again, and the stream arrives.
    watched.add("2:false");
    room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!.setSubscribed(true);
    expect(host.calls).toContainEqual(["setSubscribed", [1, "user-2", "TR_v", true]]);
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    expect(host.renderers).toHaveLength(1);
    expect(onRemoteVideo).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("auto-played cameras: the backend's subscription is kept, and Stop watching drops it", async () => {
    const room = createNativeRoom(audio);
    // RemoteTracks' rule with auto-play on: a camera is watched unless stopped.
    const stopped = new Set<number>();
    const onRemoteVideo = vi.fn();
    const handlers = createRoomEventHandlers({
      isWatched: (uid: number, screen: boolean) => !screen && !stopped.has(uid),
      getOnRemoteVideoCallback: () => onRemoteVideo,
    } as unknown as RoomEventDeps);
    room.on("trackPublished", (pub, p) => handlers.handleTrackPublished(pub as never, p as never));
    room.on("trackSubscribed", (t, pub, p) =>
      handlers.handleTrackSubscribed(t as never, pub as never, p as never),
    );
    await room.connect("u", "t");
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: unknown[]) {}
      },
    );

    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_v") },
    });
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    expect(host.calls).not.toContainEqual(["setSubscribed", [1, "user-2", "TR_v", false]]);
    expect(host.renderers).toHaveLength(1);
    expect(onRemoteVideo).toHaveBeenCalledTimes(1);
    expect(onRemoteVideo.mock.calls[0]![1]).not.toBeNull();

    stopped.add(2);
    room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!.setSubscribed(false);
    expect(host.calls).toContainEqual(["setSubscribed", [1, "user-2", "TR_v", false]]);
    vi.unstubAllGlobals();
  });

  it("carries the backend's encryption report, so the shared handler unsubscribes an unencrypted track", async () => {
    const room = createNativeRoom(audio);
    const onRemoteVideo = vi.fn();
    const handlers = createRoomEventHandlers({
      isWatched: () => true,
      getOnRemoteVideoCallback: () => onRemoteVideo,
    } as unknown as RoomEventDeps);
    room.on("trackPublished", (pub, p) => handlers.handleTrackPublished(pub as never, p as never));
    await room.connect("u", "t");

    emit({
      session: 1,
      event: { type: "trackPublished", identity: "user-2", track: video("TR_v") },
    });
    const encrypted = room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!;
    expect((encrypted as unknown as { trackInfo: unknown }).trackInfo).toEqual({ encryption: 1 });
    expect(host.calls).not.toContainEqual(["setSubscribed", [1, "user-2", "TR_v", false]]);
    expect(voiceStore.getState().encryptionDegraded).toBe(false);

    emit({
      session: 1,
      event: {
        type: "trackPublished",
        identity: "user-3",
        track: { ...video("TR_plain"), encrypted: false },
      },
    });
    expect(host.calls).toContainEqual(["setSubscribed", [1, "user-3", "TR_plain", false]]);
    expect(voiceStore.getState().encryptionDegraded).toBe(true);
    setEncryptionDegraded(false);
  });

  it("disposes every renderer on disconnect", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
    });
    emit({
      session: 1,
      event: { type: "trackSubscribed", identity: "user-3", track: video("TR_s", "screen_share") },
    });
    await room.disconnect();
    expect(host.renderers.map((r) => r.disposed)).toEqual([true, true]);
  });
});

describe("NativeRoom camera", () => {
  it("captures in the host and publishes it natively", async () => {
    let capture = 0;
    host.startCamera = () => Promise.resolve({ capture: ++capture, width: 1280, height: 720 });
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const cam = await startCamera(room);
    await room.localParticipant.publishTrack(cam, cameraOptions);
    expect(host.calls.filter(([n]) => n === "startCamera")).toEqual([
      ["startCamera", [1, "", { fps: 30, maxWidth: 0, maxHeight: 0 }]],
    ]);
    expect(host.calls.filter(([n]) => n === "publishCamera")).toEqual([
      [
        "publishCamera",
        [
          1,
          1,
          {
            width: 1280,
            height: 720,
            maxBitrate: 1_700_000,
            maxFramerate: 30,
            simulcast: true,
            codec: "vp8",
          },
        ],
      ],
    ]);
    // The self-view preview reads the host capture back over the socket.
    expect(host.renderers[0]!.url).toBe("ws://127.0.0.1:9/tok/camera");
    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(cam);
  });

  it("publishCamera passes the codec", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const cam = await startCamera(room);
    for (const [videoCodec, codec] of [
      ["h264", "h264"],
      ["vp8", "vp8"],
      ["vp9", "vp9"],
      // The native engine has no H.265: anything else is VP8.
      ["h265", "vp8"],
    ] as const) {
      host.calls.length = 0;
      // oxlint-disable-next-line no-await-in-loop -- one publish at a time
      await room.localParticipant.publishTrack(cam, { ...cameraOptions, videoCodec });
      const call = host.calls.find(([n]) => n === "publishCamera")!;
      expect(call[1][2]).toMatchObject({ codec });
    }
  });

  it("a codec republish keeps the capture and publishes with the new codec", async () => {
    const { room, cam } = await publishedCamera();
    const capture = cam.capture;
    await room.localParticipant.publishTrack(cam, { ...cameraOptions, videoCodec: "h264" });
    host.calls.length = 0;
    // The shared republish: unpublish without stopping the track, then publish.
    await room.localParticipant.unpublishTrack(cam.mediaStreamTrack, false);
    expect(host.calls.map(([n]) => n)).toEqual(["unpublishCamera"]);
    expect(host.renderers[0]!.disposed).toBe(false);
    await room.localParticipant.publishTrack(cam, { ...cameraOptions, videoCodec: "vp8" });
    expect(host.calls.map(([n]) => n)).toEqual(["unpublishCamera", "publishCamera"]);
    expect(host.calls.filter(([n]) => n === "stopCamera")).toHaveLength(0);
    expect(host.calls.at(-1)).toEqual([
      "publishCamera",
      [1, capture, expect.objectContaining({ codec: "vp8" })],
    ]);
    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(cam);
  });

  it("unpublishes by its mediaStreamTrack and ignores other tracks", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const cam = await startCamera(room);
    await room.localParticipant.publishTrack(cam, cameraOptions);
    await room.localParticipant.unpublishTrack({} as MediaStreamTrack);
    expect(host.renderers[0]!.disposed).toBe(false);
    expect(host.calls.filter(([n]) => n === "stopCamera")).toHaveLength(0);
    await room.localParticipant.unpublishTrack(cam.mediaStreamTrack);
    // Stopping the track stops the host capture and unpublishes it.
    expect(host.calls.filter(([n]) => n === "stopCamera")).toEqual([
      ["stopCamera", [1, cam.capture]],
    ]);
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
  });

  it("caps the host capture at the selected preset's resolution", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    await room.localParticipant.createCameraTracks({
      ...cameraOptions,
      resolution: { width: 1280, height: 720 },
    });
    expect(host.calls.filter(([n]) => n === "startCamera")).toEqual([
      ["startCamera", [1, "", { fps: 30, maxWidth: 1280, maxHeight: 720 }]],
    ]);
  });

  it("refuses a browser camera track and a capture without a session", async () => {
    const room = createNativeRoom(audio);
    await expect(room.localParticipant.createCameraTracks(cameraOptions)).rejects.toThrow(
      /not connected/,
    );
    await room.connect("u", "t");
    await expect(
      room.localParticipant.publishTrack(
        { kind: "video", source: "camera", mediaStreamTrack: {} } as never,
        cameraOptions,
      ),
    ).rejects.toThrow(/Linux/);
    expect(host.calls.filter(([n]) => n === "publishCamera")).toHaveLength(0);
  });

  it("starts no capture when the room disconnected during the start", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    let finish!: () => void;
    host.startCamera = () =>
      new Promise((r) => (finish = () => r({ capture: 5, width: 1280, height: 720 })));
    const starting = room.localParticipant.createCameraTracks(cameraOptions);
    await Promise.resolve();
    await room.disconnect();
    finish();
    await expect(starting).rejects.toThrow(/disconnected/);
    expect(host.renderers).toHaveLength(0);
  });

  it("refuses a publish that names no encoding rather than inventing one", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const cam = await startCamera(room);
    await expect(room.localParticipant.publishTrack(cam, { source: "camera" })).rejects.toThrow(
      /videoEncoding/,
    );
    await expect(
      room.localParticipant.publishTrack(cam, {
        source: "camera",
        videoEncoding: { maxBitrate: 1_700_000 },
      }),
    ).rejects.toThrow(/maxFramerate/);
    expect(host.calls.filter(([n]) => n === "publishCamera")).toHaveLength(0);
  });

  it("scopes a stale unpublish to its own publication, not the camera replacing it", async () => {
    let capture = 0;
    host.startCamera = () => Promise.resolve({ capture: ++capture, width: 1280, height: 720 });
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const first = await startCamera(room);
    await room.localParticipant.publishTrack(first, cameraOptions);
    const second = await startCamera(room);
    await room.localParticipant.publishTrack(second, cameraOptions);
    // A late unpublish of the replaced camera must leave the new one
    // published and its capture running.
    await room.localParticipant.unpublishTrack(first.mediaStreamTrack);
    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(second);
    expect(host.calls.filter(([n]) => n === "stopCamera")).toEqual([["stopCamera", [1, 1]]]);
    expect(host.renderers.map((r) => r.disposed)).toEqual([true, false]);
  });

  it("stops the host capture and disposes the preview on disconnect", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const cam = await startCamera(room);
    await room.localParticipant.publishTrack(cam, cameraOptions);
    await room.disconnect();
    expect(host.calls.some(([n, a]) => n === "stopCamera" && a[1] === cam.capture)).toBe(true);
    expect(host.renderers[0]!.disposed).toBe(true);
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
  });

  it("ends the camera track when the host reports the device gone", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const cam = await startCamera(room);
    await room.localParticipant.publishTrack(cam, cameraOptions);
    emit({ session: 1, event: { type: "cameraCaptureEnded", capture: cam.capture } });
    expect(host.renderers[0]!.mediaStreamTrack!.events).toContain("ended");
  });
});

describe("NativeRoom camera switch", () => {
  it("switches the camera in place: same sid, same preview track, new capture id", async () => {
    const { room, cam } = await publishedCamera();
    const preview = cam.mediaStreamTrack;
    await expect(cam.setDeviceId("/dev/video2")).resolves.toBe(true);
    expect(host.calls).toEqual([
      ["changeCamera", [1, "/dev/video2", { fps: 30, maxWidth: 0, maxHeight: 0 }]],
    ]);
    expect(names()).not.toContain("stopCamera");
    expect(names()).not.toContain("startCamera");
    expect(names()).not.toContain("publishCamera");
    expect(cam).toMatchObject({ capture: 7, width: 960, height: 720, device: "/dev/video2" });
    expect(cam.mediaStreamTrack).toBe(preview);
    expect(host.renderers).toHaveLength(1);
    expect(host.renderers[0]!.disposed).toBe(false);
    const publication = room.localParticipant.getTrackPublication("camera")!;
    expect(publication.track).toBe(cam);
    expect(publication.trackSid).toBe("TR_cam");
    // Stop now names the new capture.
    cam.stop();
    expect(host.calls.at(-1)).toEqual(["stopCamera", [1, 7]]);
  });

  it("a failed in-place switch throws CameraSwitchUnavailable and stops nothing", async () => {
    const { room, cam } = await publishedCamera();
    host.changeCamera = () => Promise.reject("busy");
    await expect(cam.setDeviceId("/dev/video2")).rejects.toBeInstanceOf(CameraSwitchUnavailable);
    expect(names()).toEqual(["changeCamera"]);
    expect(cam).toMatchObject({ capture: 5, device: "" });
    expect(host.renderers[0]!.disposed).toBe(false);
    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(cam);
  });

  it("a picked device that opens but gives no frame is unusable, not a cue to restart", async () => {
    const { room, cam } = await publishedCamera();
    host.changeCamera = () => Promise.reject(new Error("camera capture produced no frame in time"));
    const err = await cam.setDeviceId("/dev/video2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraDeviceUnusable);
    expect(err).not.toBeInstanceOf(CameraSwitchUnavailable);
    expect(names()).toEqual(["changeCamera"]);
    expect(cam).toMatchObject({ capture: 5, device: "" });
    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(cam);
  });

  it("a stop during the switch neither retargets nor falls back", async () => {
    const { cam } = await publishedCamera();
    let resolve!: (v: unknown) => void;
    host.changeCamera = () => new Promise((r) => (resolve = r));
    const switching = cam.setDeviceId("/dev/video2");
    await vi.waitFor(() => expect(names()).toContain("changeCamera"));
    cam.stop();
    expect(host.calls.at(-1)).toEqual(["stopCamera", [1, 5]]);
    resolve({ capture: 7, width: 960, height: 720 });
    const err = await switching.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CameraSwitchUnavailable);
    expect(cam.capture).toBe(5);
    // The swap landed after the stop named the old capture: the new one stops too.
    expect(host.calls.at(-1)).toEqual(["stopCamera", [1, 7]]);
  });

  it("a stop during a failing switch is not reported as unavailable", async () => {
    const { cam } = await publishedCamera();
    let reject!: (e: unknown) => void;
    host.changeCamera = () => new Promise((_, r) => (reject = r));
    const switching = cam.setDeviceId("/dev/video2");
    await vi.waitFor(() => expect(names()).toContain("changeCamera"));
    cam.stop();
    reject("camera stopped during the change");
    const err = await switching.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CameraSwitchUnavailable);
  });

  it("a capture-ended event that beats the switch reply ends the track", async () => {
    const { cam } = await publishedCamera();
    let resolve!: (v: unknown) => void;
    host.changeCamera = () => new Promise((r) => (resolve = r));
    const switching = cam.setDeviceId("/dev/video2");
    await vi.waitFor(() => expect(names()).toContain("changeCamera"));
    emit({ session: 1, event: { type: "cameraCaptureEnded", capture: 7 } });
    expect(host.renderers[0]!.mediaStreamTrack!.events).toEqual([]);
    resolve({ capture: 7, width: 960, height: 720 });
    await expect(switching).resolves.toBe(true);
    expect(host.renderers[0]!.mediaStreamTrack!.events).toContain("ended");
  });

  it("picking the current device is a no-op", async () => {
    const { cam } = await publishedCamera();
    await expect(cam.setDeviceId("")).resolves.toBe(true);
    expect(host.calls).toEqual([]);
  });
});

describe("NativeRoom remote video bitrate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("derives the bitrate from the byte deltas of distinct, advancing samples only", async () => {
    const room = await connected();
    const tileTrack = await tile(room);
    const read = async (atMs: number, bytes: number) => {
      host.getStats = () => Promise.resolve(sample({ atMs, remoteVideo: { TR_v: remote(bytes) } }));
      await vi.advanceTimersByTimeAsync(2000);
      await tileTrack.getReceiverStats();
      return tileTrack.currentBitrate;
    };

    expect(await read(1000, 100_000)).toBeUndefined();
    expect(await read(3000, 350_000)).toBe(1_000_000);
    // The same tick served again, even with other numbers, changes nothing.
    expect(await read(3000, 999_999)).toBe(1_000_000);
    // A reply older than the last sample is ignored, not read as a negative span.
    expect(await read(2500, 400_000)).toBe(1_000_000);
    // The next delta is against the last accepted sample (3000 ms, 350000 B).
    expect(await read(5000, 475_000)).toBe(500_000);
    // A byte counter that went backwards (a restarted stream) has no rate.
    expect(await read(7000, 100)).toBeUndefined();
    // No new bytes over a later tick is a rate of zero, not an unknown one.
    expect(await read(9000, 100)).toBe(0);
  });

  it("shares a host reply read within 1.5 s of the first, wherever the clock stands", async () => {
    host.getStats = () => Promise.resolve(sample());
    const room = await connected();
    await vi.advanceTimersByTimeAsync(1000);
    await transports(room).publisher.getStats();
    await vi.advanceTimersByTimeAsync(1499);
    await transports(room).subscriber.getStats();
    expect(getStatsCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await transports(room).subscriber.getStats();
    expect(getStatsCalls()).toHaveLength(2);
  });
});

describe("NativeRoom camera capture", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("starts the saved camera device and treats picking it again as a no-op", async () => {
    savePref("videoInputDevice", "/dev/video4");
    const room = await connected();
    const cam = await startCamera(room);
    expect(host.calls.filter(([n]) => n === "startCamera")).toEqual([
      ["startCamera", [1, "/dev/video4", { fps: 30, maxWidth: 0, maxHeight: 0 }]],
    ]);
    expect(cam.device).toBe("/dev/video4");
  });

  it("ends a track whose capture ended before its start result arrived, and only that one", async () => {
    const room = await connected();
    host.startCamera = () => {
      emit({ session: 1, event: { type: "cameraCaptureEnded", capture: 5 } });
      return Promise.resolve({ capture: 5, width: 1280, height: 720 });
    };
    const first = await startCamera(room);
    expect(first.mediaStreamTrack.readyState).toBe("ended");
    expect(host.renderers[0]!.mediaStreamTrack!.events).toEqual(["ended"]);
    host.startCamera = () => Promise.resolve({ capture: 6, width: 1280, height: 720 });
    const next = await startCamera(room);
    expect(next.mediaStreamTrack.readyState).toBe("live");
  });

  it("a capture that ended elsewhere does not end the camera switched onto a new one", async () => {
    const { cam } = await publishedCamera();
    let resolve!: (v: unknown) => void;
    host.changeCamera = () => new Promise((r) => (resolve = r));
    const switching = cam.setDeviceId("/dev/video2");
    await vi.waitFor(() => expect(names()).toContain("changeCamera"));
    emit({ session: 1, event: { type: "cameraCaptureEnded", capture: 99 } });
    resolve({ capture: 7, width: 960, height: 720 });
    await expect(switching).resolves.toBe(true);
    expect(host.renderers[0]!.mediaStreamTrack!.events).toEqual([]);
  });

  it("refuses a device change once the camera was stopped", async () => {
    const { cam } = await publishedCamera();
    cam.stop();
    host.calls.length = 0;
    await expect(cam.setDeviceId("/dev/video2")).rejects.toThrow("camera is no longer live");
    expect(names()).not.toContain("changeCamera");
  });

  it("says the camera ended when a stop lands during a failing or succeeding switch", async () => {
    for (const outcome of ["fail", "succeed"]) {
      // oxlint-disable-next-line no-await-in-loop -- each round builds its own room
      const { room, cam } = await publishedCamera();
      let settleSwitch!: () => void;
      host.changeCamera = () =>
        new Promise((resolve, reject) => {
          settleSwitch = () =>
            outcome === "fail"
              ? reject(new Error("busy"))
              : resolve({ capture: 7, width: 960, height: 720 });
        });
      const switching = cam.setDeviceId("/dev/video2");
      // oxlint-disable-next-line no-await-in-loop -- the host call must be pending first
      await vi.waitFor(() => expect(names()).toContain("changeCamera"));
      cam.stop();
      settleSwitch();
      // oxlint-disable-next-line no-await-in-loop -- one outcome at a time
      await expect(switching).rejects.toThrow("camera ended during the device change");
      // oxlint-disable-next-line no-await-in-loop -- the next round needs the registry clear
      await room.disconnect();
    }
  });

  it("a room that left mid-switch does not stop the new capture on a session that is gone", async () => {
    const { room, cam } = await publishedCamera();
    let resolve!: (v: unknown) => void;
    host.changeCamera = () => new Promise((r) => (resolve = r));
    const switching = cam.setDeviceId("/dev/video2");
    await vi.waitFor(() => expect(names()).toContain("changeCamera"));
    await room.disconnect();
    host.calls.length = 0;
    resolve({ capture: 7, width: 960, height: 720 });
    await expect(switching).rejects.toThrow("camera ended during the device change");
    expect(host.calls).toEqual([]);
  });

  it("logs a stop the host refused, for the capture it named", async () => {
    const { cam } = await publishedCamera();
    const err = new Error("gone");
    vi.spyOn(nativeVoice, "stopCamera").mockRejectedValue(err);
    cam.stop();
    await settle();
    expect(log.warn).toHaveBeenCalledWith("native stopCamera failed", { capture: 5, err });
  });

  it("logs the stop of a capture that finished switching after the camera was stopped", async () => {
    const { cam } = await publishedCamera();
    let resolve!: (v: unknown) => void;
    host.changeCamera = () => new Promise((r) => (resolve = r));
    const switching = cam.setDeviceId("/dev/video2");
    await vi.waitFor(() => expect(names()).toContain("changeCamera"));
    const err = new Error("gone");
    vi.spyOn(nativeVoice, "stopCamera").mockRejectedValue(err);
    cam.stop();
    resolve({ capture: 7, width: 960, height: 720 });
    await switching.catch(() => undefined);
    await settle();
    expect(log.warn).toHaveBeenCalledWith("native stopCamera failed", { capture: 7, err });
  });
});

describe("NativeRoom camera publication", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names the refusals it makes", async () => {
    const room = createNativeRoom(audio);
    const browserTrack = { kind: "video", source: "camera", mediaStreamTrack: {} } as never;
    await expect(room.localParticipant.publishTrack(browserTrack, cameraOptions)).rejects.toThrow(
      "native room is not connected",
    );
    await room.connect("u", "t");
    await expect(room.localParticipant.publishTrack(browserTrack, cameraOptions)).rejects.toThrow(
      "publishing a browser camera track is not available on Linux yet",
    );
    await expect(room.localParticipant.setCameraEnabled(true)).rejects.toThrow(
      "setCameraEnabled(true) is not available on Linux yet",
    );
  });

  it("publishes a camera as unmuted video and defaults to a single layer", async () => {
    const room = await connected();
    const cam = await startCamera(room);
    const publication = await room.localParticipant.publishTrack(cam, {
      source: "camera",
      videoEncoding: { maxBitrate: 1_700_000, maxFramerate: 30 },
    });
    expect(publication).toMatchObject({
      trackSid: "TR_cam",
      source: "camera",
      kind: "video",
      isMuted: false,
      track: cam,
    });
    expect(host.calls.find(([n]) => n === "publishCamera")![1][2]).toMatchObject({
      simulcast: false,
    });
  });

  it("stops the capture and the preview when the host refuses the publish", async () => {
    const room = await connected();
    const cam = await startCamera(room);
    host.calls.length = 0;
    host.publishCamera = () => Promise.reject(new Error("no encoder"));
    await expect(room.localParticipant.publishTrack(cam, cameraOptions)).rejects.toThrow(
      "no encoder",
    );
    // The failure path stops the capture itself, then the track's own stop reports it too.
    expect(names()).toEqual(["publishCamera", "stopCamera", "stopCamera"]);
    expect(host.renderers[0]!.disposed).toBe(true);
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
  });

  it("keeps nothing when the room left while the host published", async () => {
    const room = await connected();
    const cam = await startCamera(room);
    let finish!: () => void;
    host.publishCamera = () => new Promise((r) => (finish = () => r("TR_late")));
    const publishing = room.localParticipant.publishTrack(cam, cameraOptions);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await room.disconnect();
    finish();
    await expect(publishing).rejects.toThrow("native room disconnected during camera publish");
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
  });

  it("turning the camera off stops the capture and forgets the publication", async () => {
    const { room } = await publishedCamera();
    await room.localParticipant.setCameraEnabled(false);
    expect(names()).toEqual(["stopCamera"]);
    expect(host.renderers[0]!.disposed).toBe(true);
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
  });

  it("a stopped camera drops its publication and its host capture", async () => {
    const { room, cam } = await publishedCamera();
    cam.stop();
    expect(room.localParticipant.getTrackPublication("camera")).toBeUndefined();
    expect(host.calls).toEqual([["stopCamera", [1, 5]]]);
  });

  it("a late stop of a camera from an earlier session leaves the current one alone", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    const stale = await startCamera(room);
    await room.disconnect();
    host.connectResult = Promise.resolve({ session: 2, identity: "user-1", frames: "ws://h/tok" });
    await room.connect("u", "t");
    host.startCamera = () => Promise.resolve({ capture: 8, width: 1280, height: 720 });
    const current = await startCamera(room);
    await room.localParticipant.publishTrack(current, cameraOptions);
    host.calls.length = 0;

    stale.stop();

    expect(room.localParticipant.getTrackPublication("camera")!.track).toBe(current);
    expect(host.calls).toEqual([]);
    // The room still treats the current camera as live.
    await expect(current.setDeviceId("/dev/video2")).resolves.toBe(true);
  });
});

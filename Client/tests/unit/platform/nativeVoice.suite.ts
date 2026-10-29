// Behaviour suite for the `NativeVoice` contract
// (`src/platform/contracts/nativeVoice.ts`): the Linux native LiveKit
// backend's command surface and its one event subscription. There is no
// legacy binding — the capability is new with the Linux voice work.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  NativeMicTestEnvelope,
  NativeVoice,
  NativeVoiceCameraDevice,
  NativeVoiceCameraPreview,
  NativeVoiceCameraStarted,
  NativeVoiceDevices,
  NativeVoiceEnvelope,
  NativeVoiceScreenSources,
  NativeVoiceScreenStarted,
  NativeVoiceStats,
} from "../../../src/platform/contracts/nativeVoice";
import { expectConsole } from "../../helpers/console";
import { NATIVE_MIC_TEST_IN_CALL } from "../../../src/platform/contracts/nativeVoice";

export interface NativeControl {
  /** The host answers the next connect with this session, identity and
   *  frame-socket URL. */
  connectsAs(session: number, identity: string, frames: string): void;
  /** The host answers the next camera publish with this publication sid. */
  publishesCameraAs(sid: string): void;
  /** The host reports these cameras on the next enumeration, then answers the
   *  next camera start and the next camera preview with these. */
  hasCameras(
    devices: NativeVoiceCameraDevice[],
    started: NativeVoiceCameraStarted,
    preview: NativeVoiceCameraPreview,
  ): void;
  /** The host reports these devices on the next enumeration. */
  hasDevices(devices: NativeVoiceDevices): void;
  /** The host reports these shareable sources, then answers the next
   *  screen capture start and publish with these. */
  sharesScreenAs(
    sources: NativeVoiceScreenSources,
    started: NativeVoiceScreenStarted,
    sid: string,
  ): void;
  /** The host answers the next video-codec probe with this H.264 answer. */
  reportsVideoCodecs(codecs: { h264: boolean; vp9: boolean; decode: string[] }): void;
  /** The host rejects the next video-codec probe. */
  failsVideoCodecs(): void;
  /** The host refuses the next camera change with this reason. */
  refusesCameraChange(reason: string): void;
  /** The host refuses the next screen source change with this reason. */
  refusesScreenChange(reason: string): void;
  /** The host answers the next live quality change with this publication. */
  setsScreenQualityAs(set: { sid: string; width: number; height: number }): void;
  /** The host rejects the next live quality change with this value. */
  rejectsScreenQuality(rejection: unknown): void;
  /** The host refuses the next screen audio publish with this reason. */
  refusesScreenAudio(reason: string): void;
  /** The host answers the next mic test start with this test id. */
  startsMicTestAs(test: number): void;
  /** The host refuses the next mic test start with this reason. */
  refusesMicTest(reason: string): void;
  /** The host answers the next stats read with this sample. */
  reportsStats(reply: NativeVoiceStats): void;
  /** The host fails the next stats read (stale session, timeout). */
  failsStats(): void;
  /** Every host command issued so far, as `[name, payload]`. */
  commands(): Array<[string, unknown]>;
  /** The host delivers a room event. Resolves once it has been delivered. */
  emits(envelope: NativeVoiceEnvelope): Promise<void>;
  /** The host answers the next app-sound play with this id. */
  startsSoundAs(id: number): void;
  /** The host refuses app-sound commands (no device, the stream failed). */
  failsSound(): void;
  /** The host delivers a device change. Resolves once it has been delivered. */
  emitsDevices(devices: NativeVoiceDevices): Promise<void>;
  /** The host refuses the next device watch start. */
  refusesDeviceWatch(): void;
  /** The host delivers a mic test event. Resolves once it has been delivered. */
  emitsMicTest(envelope: NativeMicTestEnvelope): Promise<void>;
}

export interface NativeVoiceSubject {
  readonly subject: NativeVoice;
  readonly native: NativeControl;
}

const audio = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: true,
  enhancedNoiseSuppression: true,
};

export function describeNativeVoiceSuite(
  makeSubject: () => Promise<NativeVoiceSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("NativeVoice", () => {
    let ctx: NativeVoiceSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("hands the room key to the host as the exact text it was given", async () => {
      await ctx.subject.setRoomKey("bW9jay1yb29tLWtleQ==");
      expect(ctx.native.commands()).toEqual([
        ["native_voice_set_key", { key: "bW9jay1yb29tLWtleQ==" }],
      ]);
    });

    check("connect resolves the host's session id, identity and frame socket", async () => {
      ctx.native.connectsAs(7, "user-42", "ws://127.0.0.1:9/token");
      await expect(ctx.subject.connect("ws://127.0.0.1:7881/lk", "tok", audio)).resolves.toEqual({
        session: 7,
        identity: "user-42",
        frames: "ws://127.0.0.1:9/token",
      });
      expect(ctx.native.commands()).toEqual([
        ["native_voice_connect", { url: "ws://127.0.0.1:7881/lk", token: "tok", audio }],
      ]);
    });

    check("scopes microphone, subscription, volume and disconnect to a session id", async () => {
      await ctx.subject.setMicrophone(7, true);
      await ctx.subject.setPttGated(7, true);
      await ctx.subject.setVoiceGate(7, 0.05);
      await ctx.subject.setVoiceGate(7, 0.01, true);
      await ctx.subject.setInputGain(7, 150);
      await ctx.subject.setAudioProcessing(7, audio);
      await ctx.subject.setSubscribed(7, "user-9", "TR_1", false);
      await ctx.subject.setVideoView(7, "user-9", "TR_2", true, "low");
      await ctx.subject.setVolume(7, "user-9", 0.5);
      await ctx.subject.setScreenshareVolume(7, "user-9", 0.25);
      await ctx.subject.disconnect(7);
      await ctx.subject.clearRoomKey();
      expect(ctx.native.commands()).toEqual([
        ["native_voice_set_microphone", { session: 7, enabled: true }],
        ["native_voice_set_ptt_gated", { session: 7, gated: true }],
        ["native_voice_set_voice_gate", { session: 7, threshold: 0.05 }],
        ["native_voice_set_voice_gate", { session: 7, threshold: 0.01, retune: true }],
        ["native_voice_set_input_gain", { session: 7, percent: 150 }],
        ["native_voice_set_audio_processing", { session: 7, audio }],
        [
          "native_voice_set_subscribed",
          { session: 7, identity: "user-9", sid: "TR_1", subscribed: false },
        ],
        [
          "native_voice_set_video_view",
          { session: 7, identity: "user-9", sid: "TR_2", enabled: true, quality: "low" },
        ],
        ["native_voice_set_volume", { session: 7, identity: "user-9", volume: 0.5 }],
        ["native_voice_set_screenshare_volume", { session: 7, identity: "user-9", volume: 0.25 }],
        ["native_voice_disconnect", { session: 7 }],
        ["native_voice_clear_key", undefined],
      ]);
    });

    check("lists the host's cameras and starts, publishes and stops one", async () => {
      const cameras: NativeVoiceCameraDevice[] = [
        { id: "/dev/video0", name: "HD Webcam", infrared: false },
      ];
      const capture = { fps: 30, maxWidth: 0, maxHeight: 0 };
      const publish = {
        width: 1280,
        height: 720,
        maxBitrate: 1_700_000,
        maxFramerate: 30,
        simulcast: true,
        codec: "h264" as const,
      };
      ctx.native.hasCameras(
        cameras,
        { capture: 4, width: 1280, height: 720 },
        { width: 640, height: 360, frames: "ws://127.0.0.1:9/tok" },
      );
      ctx.native.publishesCameraAs("TR_cam");
      await expect(ctx.subject.listCameras()).resolves.toEqual(cameras);
      await expect(ctx.subject.startCamera(7, "/dev/video0", capture)).resolves.toEqual({
        capture: 4,
        width: 1280,
        height: 720,
      });
      await expect(ctx.subject.publishCamera(7, 4, publish)).resolves.toBe("TR_cam");
      await ctx.subject.stopCamera(7, 4);
      expect(ctx.native.commands()).toEqual([
        ["native_voice_list_cameras", undefined],
        ["native_voice_start_camera", { session: 7, source: "/dev/video0", capture }],
        ["native_voice_publish_camera", { session: 7, capture: 4, options: publish }],
        ["native_voice_stop_camera", { session: 7, capture: 4 }],
      ]);
    });

    check("reports whether the host can capture cameras at all", async () => {
      await expect(ctx.subject.cameraSupport()).resolves.toEqual({ available: true, missing: [] });
      expect(ctx.native.commands()).toEqual([["native_voice_camera_support", undefined]]);
    });

    check(
      "reports whether the engine can encode H.264 and VP9 and decode, and nothing when the probe fails",
      async () => {
        ctx.native.reportsVideoCodecs({ h264: true, vp9: true, decode: ["vp8", "vp9"] });
        await expect(ctx.subject.videoCodecs()).resolves.toEqual({
          h264: true,
          vp9: true,
          decode: ["vp8", "vp9"],
        });
        ctx.native.failsVideoCodecs();
        await expect(ctx.subject.videoCodecs()).resolves.toEqual({
          h264: false,
          vp9: false,
          decode: [],
        });
        expect(ctx.native.commands()).toEqual([
          ["native_voice_video_codecs", undefined],
          ["native_voice_video_codecs", undefined],
        ]);
      },
    );

    check("starts and stops the out-of-call camera preview", async () => {
      const capture = { fps: 30, maxWidth: 320, maxHeight: 180 };
      ctx.native.hasCameras(
        [],
        { capture: 0, width: 0, height: 0 },
        { width: 640, height: 360, frames: "ws://127.0.0.1:9/tok" },
      );
      await expect(ctx.subject.startCameraPreview("/dev/video0", capture)).resolves.toEqual({
        width: 640,
        height: 360,
        frames: "ws://127.0.0.1:9/tok",
      });
      await ctx.subject.stopCameraPreview();
      expect(ctx.native.commands()).toEqual([
        ["native_voice_start_camera_preview", { source: "/dev/video0", capture }],
        ["native_voice_stop_camera_preview", undefined],
      ]);
    });

    check("lists shareable sources, and starts, publishes and stops a capture", async () => {
      const sources: NativeVoiceScreenSources = {
        portal: false,
        sources: [{ id: "screen:1", kind: "screen", title: "DP-1", thumbnail: null }],
        audio: true,
      };
      const capture = { fps: 30, maxWidth: 1920, maxHeight: 1080 };
      const publish = {
        width: 1920,
        height: 1080,
        maxBitrate: 6_000_000,
        maxFramerate: 30,
        simulcast: true,
        codec: "vp8" as const,
      };
      ctx.native.sharesScreenAs(sources, { capture: 2, width: 1920, height: 1080 }, "TR_screen");
      await expect(ctx.subject.screenSources()).resolves.toEqual(sources);
      await expect(ctx.subject.startScreen(7, "screen:1", capture)).resolves.toEqual({
        capture: 2,
        width: 1920,
        height: 1080,
      });
      await expect(ctx.subject.publishScreen(7, 2, publish)).resolves.toBe("TR_screen");
      await ctx.subject.unpublishScreen(7, 2);
      await ctx.subject.stopScreen(7, 2);
      expect(ctx.native.commands()).toEqual([
        ["native_voice_screen_sources", undefined],
        ["native_voice_start_screen", { session: 7, source: "screen:1", capture }],
        ["native_voice_publish_screen", { session: 7, capture: 2, options: publish }],
        ["native_voice_unpublish_screen", { session: 7, capture: 2 }],
        ["native_voice_stop_screen", { session: 7, capture: 2 }],
      ]);
    });

    check("changes the live camera's device and reports a refusal as an Error", async () => {
      const capture = { fps: 30, maxWidth: 1280, maxHeight: 720 };
      const started = { capture: 3, width: 960, height: 720 };
      ctx.native.hasCameras([], started, { width: 0, height: 0, frames: "" });
      await expect(ctx.subject.changeCamera(7, "/dev/video2", capture)).resolves.toEqual(started);
      ctx.native.refusesCameraChange("camera busy");
      const refused = ctx.subject.changeCamera(7, "/dev/video4", capture);
      await expect(refused).rejects.toBeInstanceOf(Error);
      await expect(refused).rejects.toThrow("camera busy");
      expect(ctx.native.commands()).toEqual([
        ["native_voice_change_camera", { session: 7, source: "/dev/video2", capture }],
        ["native_voice_change_camera", { session: 7, source: "/dev/video4", capture }],
      ]);
    });

    check(
      "publishes and unpublishes the share's audio and reports a refusal as an Error",
      async () => {
        ctx.native.sharesScreenAs(
          { portal: false, sources: [], audio: true },
          { capture: 2, width: 1920, height: 1080 },
          "TR_screen_audio",
        );
        await expect(ctx.subject.publishScreenAudio(7, 2)).resolves.toBe("TR_screen_audio");
        await ctx.subject.unpublishScreenAudio(7, "TR_screen_audio");
        ctx.native.refusesScreenAudio("screen capture 9 is not running");
        const refused = ctx.subject.publishScreenAudio(7, 9);
        await expect(refused).rejects.toBeInstanceOf(Error);
        await expect(refused).rejects.toThrow("screen capture 9 is not running");
        expect(ctx.native.commands()).toEqual([
          ["native_voice_publish_screen_audio", { session: 7, capture: 2 }],
          ["native_voice_unpublish_screen_audio", { session: 7, sid: "TR_screen_audio" }],
          ["native_voice_publish_screen_audio", { session: 7, capture: 9 }],
        ]);
      },
    );

    check("changes a live share's source and reports a refusal as an Error", async () => {
      const capture = { fps: 30, maxWidth: 0, maxHeight: 0 };
      ctx.native.sharesScreenAs(
        { portal: true, sources: [], audio: false },
        { capture: 3, width: 1280, height: 720 },
        "TR_screen",
      );
      await expect(ctx.subject.changeScreen(7, "window:9", capture)).resolves.toEqual({
        capture: 3,
        width: 1280,
        height: 720,
      });
      ctx.native.refusesScreenChange("screen capture portal did not start");
      const refused = ctx.subject.changeScreen(7, "portal", capture);
      await expect(refused).rejects.toBeInstanceOf(Error);
      await expect(refused).rejects.toThrow("screen capture portal did not start");
      expect(ctx.native.commands()).toEqual([
        ["native_voice_change_screen", { session: 7, source: "window:9", capture }],
        ["native_voice_change_screen", { session: 7, source: "portal", capture }],
      ]);
    });

    check("changes a live share's quality and types a refusal or a failed republish", async () => {
      const capture = { fps: 15, maxWidth: 1280, maxHeight: 720 };
      const publish = {
        width: 1280,
        height: 720,
        maxBitrate: 1_500_000,
        maxFramerate: 15,
        simulcast: false,
        codec: "vp8" as const,
      };
      ctx.native.setsScreenQualityAs({ sid: "TR_new", width: 1280, height: 720 });
      await expect(ctx.subject.setScreenQuality(7, 3, capture, publish)).resolves.toEqual({
        ok: true,
        sid: "TR_new",
        width: 1280,
        height: 720,
      });
      ctx.native.rejectsScreenQuality({ stage: "refused", message: "not published" });
      await expect(ctx.subject.setScreenQuality(7, 3, capture, publish)).resolves.toEqual({
        ok: false,
        stage: "refused",
        message: "not published",
      });
      ctx.native.rejectsScreenQuality({ stage: "publish", message: "the server said no" });
      await expect(ctx.subject.setScreenQuality(7, 3, capture, publish)).resolves.toEqual({
        ok: false,
        stage: "publish",
        message: "the server said no",
      });
      // A rejection without a stage (an older host) changed nothing.
      ctx.native.rejectsScreenQuality("unknown command");
      await expect(ctx.subject.setScreenQuality(7, 3, capture, publish)).resolves.toEqual({
        ok: false,
        stage: "refused",
        message: "unknown command",
      });
      const call = [
        "native_voice_set_screen_quality",
        { session: 7, capture: 3, options: capture, publish },
      ];
      expect(ctx.native.commands()).toEqual([call, call, call, call]);
    });

    check("lists the host's devices and switches by their ids", async () => {
      const devices = {
        inputs: [{ id: "guid-mic", name: "USB Mic" }],
        outputs: [{ id: "guid-spk", name: "Speakers" }],
      };
      ctx.native.hasDevices(devices);
      await expect(ctx.subject.listDevices()).resolves.toEqual(devices);
      await ctx.subject.setDevice(7, "audioinput", "guid-mic");
      await ctx.subject.setDevice(7, "audiooutput", "");
      expect(ctx.native.commands()).toEqual([
        ["native_voice_list_devices", undefined],
        ["native_voice_set_device", { session: 7, kind: "audioinput", deviceId: "guid-mic" }],
        ["native_voice_set_device", { session: 7, kind: "audiooutput", deviceId: "" }],
      ]);
    });

    check("getStats forwards the host's sample for the session", async () => {
      const reply: NativeVoiceStats = {
        atMs: 1_700_000_000_000,
        publisher: [
          {
            type: "candidate-pair",
            id: "CP1",
            currentRoundTripTime: 0.042,
            bytesSent: 1,
            bytesReceived: 2,
          },
        ],
        subscriber: [],
        remoteVideo: {
          TR_1: {
            frameWidth: 1280,
            frameHeight: 720,
            framesDecoded: 90,
            bytesReceived: 1000,
            packetsLost: 0,
            packetsReceived: 50,
            mimeType: "video/VP8",
          },
        },
        localVideo: {
          screen_share: [
            {
              framesPerSecond: 30,
              frameWidth: 1920,
              frameHeight: 1080,
              qualityLimitationReason: "none",
              active: true,
            },
          ],
        },
      };
      ctx.native.reportsStats(reply);
      await expect(ctx.subject.getStats(7)).resolves.toEqual(reply);
      expect(ctx.native.commands()).toEqual([["native_voice_get_stats", { session: 7 }]]);
    });

    check("playSound resolves the host's id and stopSound cuts it by id", async () => {
      ctx.native.startsSoundAs(11);
      const notes = [
        { at: 0, duration: 0.2, gain: 0.3, endGain: 0.01, freqs: [[0, 800]] },
      ] as const;
      await expect(ctx.subject.playSound(notes, "guid-spk", 0.5)).resolves.toBe(11);
      await expect(ctx.subject.stopSound(11)).resolves.toBeUndefined();
      expect(ctx.native.commands()).toEqual([
        ["native_voice_play_sound", { notes, deviceId: "guid-spk", gain: 0.5 }],
        ["native_voice_stop_sound", { id: 11 }],
      ]);
    });

    check("playSound reads a host failure as null and stopSound never rejects", async () => {
      ctx.native.failsSound();
      await expect(ctx.subject.playSound([], "", 1)).resolves.toBeNull();
      await expect(ctx.subject.stopSound(3)).resolves.toBeUndefined();
    });

    check("getStats reads a host failure as null", async () => {
      ctx.native.failsStats();
      await expect(ctx.subject.getStats(7)).resolves.toBeNull();
    });

    check("starts, updates and stops a mic test by id", async () => {
      const options = {
        input: "guid-mic",
        output: "",
        audio,
        inputGain: 120,
        outputGain: 0.5,
        threshold: 0.03,
      };
      ctx.native.startsMicTestAs(5);
      await expect(ctx.subject.startMicTest(options)).resolves.toBe(5);
      await ctx.subject.updateMicTest(5, { kind: "inputGain", percent: 80 });
      await ctx.subject.updateMicTest(5, { kind: "voiceGate", threshold: 0.02, retune: true });
      await ctx.subject.stopMicTest(5);
      expect(ctx.native.commands()).toEqual([
        ["native_voice_start_mic_test", { options }],
        ["native_voice_update_mic_test", { test: 5, update: { kind: "inputGain", percent: 80 } }],
        [
          "native_voice_update_mic_test",
          { test: 5, update: { kind: "voiceGate", threshold: 0.02, retune: true } },
        ],
        ["native_voice_stop_mic_test", { test: 5 }],
      ]);
    });

    check("a refused mic test start rejects with an Error carrying the host's reason", async () => {
      ctx.native.refusesMicTest(NATIVE_MIC_TEST_IN_CALL);
      const refused = ctx.subject.startMicTest({
        input: "",
        output: "",
        audio,
        inputGain: 100,
        outputGain: 1,
        threshold: 0,
      });
      await expect(refused).rejects.toBeInstanceOf(Error);
      await expect(refused).rejects.toThrow(NATIVE_MIC_TEST_IN_CALL);
    });

    check(
      "delivers mic-test events and releases a subscription that ends before it registers",
      async () => {
        const handler = vi.fn();
        const stop = ctx.subject.onMicTestEvent(handler);
        await ctx.native.emitsMicTest({
          test: 5,
          event: { type: "inputLevel", rms: 0.2, open: true },
        });
        await ctx.native.emitsMicTest({ test: 5, event: { type: "ended" } });
        expect(handler.mock.calls).toEqual([
          [{ test: 5, event: { type: "inputLevel", rms: 0.2, open: true } }],
          [{ test: 5, event: { type: "ended" } }],
        ]);
        stop();
        await ctx.native.emitsMicTest({ test: 5, event: { type: "ended" } });
        expect(handler).toHaveBeenCalledTimes(2);
        const early = vi.fn();
        ctx.subject.onMicTestEvent(early)();
        await ctx.native.emitsMicTest({ test: 6, event: { type: "ended" } });
        expect(early).not.toHaveBeenCalled();
        const fresh = vi.fn();
        ctx.subject.onMicTestEvent(fresh);
        await ctx.native.emitsMicTest({ test: 7, event: { type: "ended" } });
        expect(fresh).toHaveBeenCalledTimes(1);
      },
    );

    check("watchDevices starts the host watch and delivers each device change", async () => {
      const handler = vi.fn();
      ctx.subject.watchDevices(handler);
      const devices: NativeVoiceDevices = {
        inputs: [{ id: "guid-mic", name: "Headset mic" }],
        outputs: [{ id: "guid-spk", name: "Headset" }],
      };
      await ctx.native.emitsDevices(devices);
      expect(handler.mock.calls).toEqual([[devices]]);
      expect(ctx.native.commands()).toEqual([["native_voice_watch_devices", undefined]]);
    });

    check("an unsubscribe from watchDevices stops delivery, even before it settled", async () => {
      const handler = vi.fn();
      const stop = ctx.subject.watchDevices(handler);
      await ctx.native.emitsDevices({ inputs: [], outputs: [] });
      stop();
      await ctx.native.emitsDevices({ inputs: [], outputs: [] });
      expect(handler).toHaveBeenCalledTimes(1);
      const early = vi.fn();
      ctx.subject.watchDevices(early)();
      await ctx.native.emitsDevices({ inputs: [], outputs: [] });
      expect(early).not.toHaveBeenCalled();
      const fresh = vi.fn();
      ctx.subject.watchDevices(fresh);
      await ctx.native.emitsDevices({ inputs: [], outputs: [] });
      expect(fresh).toHaveBeenCalledTimes(1);
      expect(early).not.toHaveBeenCalled();
    });

    check("a refused device watch start does not throw and keeps the subscription", async () => {
      ctx.native.refusesDeviceWatch();
      const handler = vi.fn();
      expect(() => ctx.subject.watchDevices(handler)).not.toThrow();
      await ctx.native.emitsDevices({ inputs: [], outputs: [] });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(ctx.native.commands()).toEqual([["native_voice_watch_devices", undefined]]);
      // The rejection is logged, not thrown. A subject that never rejects
      // logs nothing, and the host binding does.
      expectConsole("warn", "native device watch did not start");
    });

    check("delivers each room event to the handler as the host sent it", async () => {
      const handler = vi.fn();
      ctx.subject.onEvent(handler);
      await ctx.native.emits({ session: 1, event: { type: "reconnecting" } });
      await ctx.native.emits({
        session: 1,
        event: { type: "activeSpeakers", identities: ["user-1"] },
      });
      expect(handler.mock.calls).toEqual([
        [{ session: 1, event: { type: "reconnecting" } }],
        [{ session: 1, event: { type: "activeSpeakers", identities: ["user-1"] } }],
      ]);
    });

    // Paired with a delivery first: "nothing arrives after unsubscribing" is
    // also what a subject that never delivers anything does.
    check("stops delivering once unsubscribed", async () => {
      const handler = vi.fn();
      const unsubscribe = ctx.subject.onEvent(handler);
      await ctx.native.emits({ session: 1, event: { type: "reconnected" } });
      unsubscribe();
      await ctx.native.emits({ session: 1, event: { type: "disconnected", reason: "x" } });
      expect(handler.mock.calls).toEqual([[{ session: 1, event: { type: "reconnected" } }]]);
    });

    check("an unsubscribe issued before the subscription settled still releases it", async () => {
      const handler = vi.fn();
      const unsubscribe = ctx.subject.onEvent(handler);
      unsubscribe();
      await ctx.native.emits({ session: 1, event: { type: "reconnected" } });
      expect(handler).not.toHaveBeenCalled();
      // The late-resolving host handle was released, not leaked: a fresh
      // subscription is the only one that receives.
      const fresh = vi.fn();
      ctx.subject.onEvent(fresh);
      await ctx.native.emits({ session: 2, event: { type: "reconnected" } });
      expect(fresh).toHaveBeenCalledTimes(1);
      expect(handler).not.toHaveBeenCalled();
    });
  });
}

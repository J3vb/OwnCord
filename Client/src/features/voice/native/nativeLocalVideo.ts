// The Linux native room's local video: the camera and screen-share captures
// the host runs, their preview tracks and their publications. NativeRoom owns
// one and hands it the session it is connected to; disconnect() releases it.
import { createLogger } from "../../../lib/logger";
import { loadPref } from "../../../lib/prefs/preferences";
import { desktop } from "../../../platform/desktop";
import type { NativeVoiceStats } from "../../../platform/contracts/nativeVoice";
import { NativeCameraTrack } from "./nativeCameraTrack";
import { CameraDeviceUnusable, CameraSwitchUnavailable } from "../cameraSwitch";
import { NativeScreenAudioTrack } from "./screenAudioTrack";
import { NativeScreenTrack, ScreenQualityError, startError, pickerDismissed } from "./screenTrack";
import {
  noteChangedQuality,
  noteChangedSource,
  pickChangeSource,
  pickScreenSource,
  shareSettings,
} from "./screenPicker";
import type { StreamQuality } from "@lib/voice/screenShare";
import type { PublishCodec } from "../videoCodec";

const log = createLogger("nativeRoom");

/** The host's reason for a camera that opened but produced no first frame
 *  (`TIMED_OUT` in `src-tauri/src/native_voice/camera.rs`). */
// i18n-exempt: the host's error text matched, never rendered
const CAMERA_NO_FRAME = "camera capture produced no frame in time";

/** The slice of livekit-client's `LocalVideoTrack` the camera path hands
 *  `publishTrack`. */
export interface PublishableTrack {
  kind: string;
  source: string;
  mediaStreamTrack: MediaStreamTrack;
}

export interface PublishOptions {
  source?: string;
  simulcast?: boolean;
  /** The selected preset's capture size; the host downscales a larger source. */
  resolution?: { width: number; height: number };
  videoEncoding?: { maxBitrate: number; maxFramerate?: number };
  /** The codec `resolveVideoCodec` chose; the native engine publishes VP8
   *  unless this is `h264` or `vp9`. */
  videoCodec?: string;
}

/** The native publish's codec for the shared path's `videoCodec` option:
 *  H.264 or VP9 when asked for, VP8 for everything else (the native engine has
 *  no H.265). */
export function nativeCodec(options: PublishOptions): "vp8" | "h264" | "vp9" {
  return options.videoCodec === "h264" || options.videoCodec === "vp9" ? options.videoCodec : "vp8";
}

/** A local camera or screen publication, as `getLocalCameraStream`,
 *  `getLocalScreenshareStream` and the diagnostics read it. */
export interface NativeLocalPublication {
  readonly trackSid: string;
  readonly source: string;
  readonly kind: string;
  readonly isMuted: boolean;
  /** The camera track is a `NativeCameraTrack`, the screen share a
   *  `NativeScreenTrack`; both stand in for `LocalVideoTrack`. */
  readonly track: PublishableTrack | NativeCameraTrack | NativeScreenTrack | NativeScreenAudioTrack;
}

export function unsupported(what: string): Error {
  // i18n-exempt: internal Linux unsupported-path guard, caught and mapped by the caller
  return new Error(`${what} is not available on Linux yet`);
}

/** What the local video reads from its room: the live session, the frame
 *  socket and the local publications map. */
export interface NativeVideoHost {
  sessionId(): number | null;
  frames(): string;
  readonly publications: Map<string, NativeLocalPublication>;
  readStats(): Promise<NativeVoiceStats | null>;
}

export class NativeLocalVideo {
  /** The live screen capture's track; null when not capturing. */
  private screen: NativeScreenTrack | null = null;
  /** The share's audio track while one exists; it follows `screen`. */
  private screenAudio: NativeScreenAudioTrack | null = null;
  /** The live camera capture's track; null when off. Its preview is the
   *  self-view and settings preview source. */
  private camera: NativeCameraTrack | null = null;
  /** The last capture the host ended, in case it ended before its track
   *  existed (the event and the start result travel separately). */
  private endedCapture: number | null = null;
  /** The last camera capture the host ended, as `endedCapture` for screens. */
  private endedCamera: number | null = null;

  constructor(private readonly host: NativeVideoHost) {}

  /** Drops the camera and screen tracks on disconnect; the session close
   *  releases the host captures. */
  release(): void {
    this.camera = null;
    this.endedCamera = null;
    // The session close releases the host capture; this is the preview.
    this.screen?.stop();
    this.screen = null;
    this.screenAudio?.stop();
    this.screenAudio = null;
    this.endedCapture = null;
  }

  /** The host ended a screen capture, perhaps before its track existed. */
  screenEnded(capture: number): void {
    this.endedCapture = capture;
    if (this.screen?.capture === capture) this.screen.end();
  }

  /** The host ended a camera capture, as `screenEnded` for screens. */
  cameraEnded(capture: number): void {
    this.endedCamera = capture;
    if (this.camera?.capture === capture) this.camera.end();
  }

  /** Start native camera capture: the shared `enableCamera` calls this in
   *  place of `createLocalVideoTrack`, then publishes the returned track. The
   *  capture runs in the host and keeps running while the window is hidden;
   *  the self-view preview reads it back over the frame socket's `camera`
   *  route. */
  async createCameraTracks(options: PublishOptions): Promise<NativeCameraTrack[]> {
    const session = this.host.sessionId();
    // i18n-exempt: internal native-room state guard, never rendered
    if (session === null) throw new Error("native room is not connected");
    const savedDevice = loadPref<string>("videoInputDevice", "");
    const captureRequest = {
      fps: options.videoEncoding?.maxFramerate ?? 30,
      maxWidth: options.resolution?.width ?? 0,
      maxHeight: options.resolution?.height ?? 0,
    };
    const started = await desktop.nativeVoice
      .startCamera(session, savedDevice, captureRequest)
      .catch((err: unknown) => {
        throw startError(err);
      });
    if (this.host.sessionId() !== session) {
      // Disconnected meanwhile: the session (and its capture) is gone.
      // i18n-exempt: internal native-room state guard, never rendered
      throw new Error("native room disconnected during camera start");
    }
    const track = new NativeCameraTrack(
      started,
      `${this.host.frames()}/camera`,
      (t) => this.stopCamera(session, t),
      savedDevice,
      captureRequest,
      (t, deviceId) => this.changeCameraDevice(session, t, deviceId),
    );
    this.camera?.stop();
    this.camera = track;
    if (this.endedCamera === track.capture) track.end();
    return [track];
  }

  /** Move the live camera `track` onto `deviceId`: the host starts the new
   *  capture beside the old one and swaps the publication's source once it
   *  has a frame (same sid, same preview socket). A host refusal leaves the
   *  old capture running and rejects `CameraSwitchUnavailable`, the cue for
   *  the restart path, or `CameraDeviceUnusable` when the new device opened
   *  but gave no frame, where a restart would not help; a stop or leave
   *  meanwhile is a plain error, which the caller drops because the camera it
   *  was switching is gone. */
  private async changeCameraDevice(
    session: number,
    track: NativeCameraTrack,
    deviceId: string,
  ): Promise<boolean> {
    const live = (): boolean => this.host.sessionId() === session && this.camera === track;
    // i18n-exempt: internal native-room state guard, never rendered
    if (!live()) throw new Error("camera is no longer live");
    if (deviceId === track.device) return true;
    const started = await desktop.nativeVoice
      .changeCamera(session, deviceId, track.captureRequest)
      .catch((err: unknown) => {
        // A stop or leave meanwhile is not an unavailable switch: no restart.
        // i18n-exempt: internal native-room state guard, never rendered
        if (!live()) throw new Error("camera ended during the device change");
        if (String(err).includes(CAMERA_NO_FRAME)) throw new CameraDeviceUnusable(err);
        throw new CameraSwitchUnavailable(err);
      });
    if (!live()) {
      // Stopped while the host swapped it in: a stop that reached the host
      // after the swap named the old capture, so stop the new one too (a
      // no-op when the stop came first).
      if (this.host.sessionId() === session)
        desktop.nativeVoice
          .stopCamera(session, started.capture)
          .catch((err) => log.warn("native stopCamera failed", { capture: started.capture, err }));
      // i18n-exempt: internal native-room state guard, never rendered
      throw new Error("camera ended during the device change");
    }
    track.retarget(started);
    track.device = deviceId;
    if (this.endedCamera === started.capture) track.end();
    return true;
  }

  /** Publish the already-started native camera capture: E2EE like the
   *  microphone. The capture keeps running for the self-view. */
  async publishCamera(
    track: NativeCameraTrack,
    options: PublishOptions,
  ): Promise<NativeLocalPublication> {
    const session = this.host.sessionId();
    // i18n-exempt: internal native-room state guard, never rendered
    if (session === null) throw new Error("native room is not connected");
    if (!(track instanceof NativeCameraTrack))
      // i18n-exempt: internal unsupported-path guard, never rendered
      throw unsupported("publishing a browser camera track");
    const encoding = options.videoEncoding;
    if (encoding?.maxFramerate === undefined)
      // i18n-exempt: internal publish-config guard, never rendered
      throw new Error("native camera publish needs videoEncoding.maxBitrate and maxFramerate");
    const sid = await desktop.nativeVoice
      .publishCamera(session, track.capture, {
        width: track.width,
        height: track.height,
        maxBitrate: encoding.maxBitrate,
        maxFramerate: encoding.maxFramerate,
        simulcast: options.simulcast ?? false,
        codec: nativeCodec(options),
      })
      .catch(async (err: unknown) => {
        await desktop.nativeVoice.stopCamera(session, track.capture).catch(() => {});
        track.stop();
        throw err;
      });
    if (this.host.sessionId() !== session) {
      // i18n-exempt: internal native-room state guard, never rendered
      throw new Error("native room disconnected during camera publish");
    }
    const publication: NativeLocalPublication = {
      trackSid: sid,
      source: "camera",
      kind: "video",
      isMuted: false,
      track,
    };
    this.host.publications.set("camera", publication);
    return publication;
  }

  /** A stopped camera track: forget its publication, then stop its host
   *  capture (a no-op for a capture a newer one replaced). */
  private stopCamera(session: number, track: NativeCameraTrack): void {
    if (this.camera === track) this.camera = null;
    const pubs = this.host.publications;
    if (pubs.get("camera")?.track === track) pubs.delete("camera");
    if (this.host.sessionId() !== session) return;
    desktop.nativeVoice
      .stopCamera(session, track.capture)
      .catch((err) => log.warn("native stopCamera failed", { capture: track.capture, err }));
  }

  /** `stopCapture` false unpublishes alone and leaves the capture, and the
   *  track that owns it, running (a codec republish publishes it again). */
  async unpublishCamera(stopCapture = true): Promise<void> {
    const camera = this.host.publications.get("camera");
    if (camera === undefined) return;
    this.host.publications.delete("camera");
    if (!stopCapture) {
      const id = this.host.sessionId();
      if (id !== null) await desktop.nativeVoice.unpublishCamera(id, camera.trackSid);
      return;
    }
    if (camera.track instanceof NativeCameraTrack) {
      // Stops the host capture (and, if still current, unpublishes).
      camera.track.stop();
      return;
    }
    const id = this.host.sessionId();
    if (id !== null) await desktop.nativeVoice.unpublishCamera(id, camera.trackSid);
  }

  async createScreenTracks(): Promise<Array<NativeScreenTrack | NativeScreenAudioTrack>> {
    const session = this.host.sessionId();
    // i18n-exempt: internal native-room state guard, never rendered
    if (session === null) throw new Error("native room is not connected");
    const pick = await pickScreenSource();
    if (pick === null) throw pickerDismissed();
    if (this.host.sessionId() !== session) {
      // i18n-exempt: internal native-room state guard, never rendered
      throw new Error("native room disconnected during screen pick");
    }
    // The picker resolved the capture pacing and size from the quality and fps
    // chosen in the dialog (defaulted from the saved prefs).
    const started = await desktop.nativeVoice
      .startScreen(session, pick.source, pick.capture)
      .catch((err: unknown) => {
        throw startError(err);
      });
    if (this.host.sessionId() !== session) {
      // Disconnected meanwhile: the session (and its capture) is gone.
      // i18n-exempt: internal native-room state guard, never rendered
      throw new Error("native room disconnected during screen capture");
    }
    const track = new NativeScreenTrack(
      started,
      `${this.host.frames()}/screen`,
      (t) => this.stopScreen(session, t),
      { maxBitrate: pick.maxBitrate, maxFramerate: pick.maxFramerate, simulcast: pick.simulcast },
      pick.capture,
      pick.quality,
      pick.fps,
      (t) => this.changeScreenSource(session, t),
      (t, q, fps, published) => this.changeScreenQuality(session, t, q, fps, published),
      () => this.host.readStats(),
    );
    // The old share goes first (its stop also ends its audio), then both of
    // the new one are in place.
    this.screen?.stop();
    this.screen = track;
    if (pick.audio !== true) {
      if (this.endedCapture === track.capture) track.end();
      return [track];
    }
    const audioTrack = new NativeScreenAudioTrack((t) => this.stopScreenAudio(session, t));
    this.screenAudio = audioTrack;
    if (this.endedCapture === track.capture) track.end();
    return [track, audioTrack];
  }

  /** Change source for the live share `track`: pick a source, then let the
   *  host move the publication onto a new capture of it, at the share's own
   *  capture settings and encoding. */
  private async changeScreenSource(session: number, track: NativeScreenTrack): Promise<void> {
    const live = (): boolean => this.host.sessionId() === session && this.screen === track;
    // i18n-exempt: internal native-room state guard, never rendered
    if (!live()) throw new Error("screen share is no longer live");
    const source = await pickChangeSource();
    if (source === null) throw pickerDismissed();
    // i18n-exempt: internal native-room state guard, never rendered
    if (!live()) throw new Error("screen share ended during the pick");
    const started = await desktop.nativeVoice
      .changeScreen(session, source, track.captureRequest)
      .catch((err: unknown) => {
        throw startError(err);
      });
    if (!live()) {
      // The share was stopped or ended while the host swapped it in: a stop
      // that reached the host after the swap named the old capture, so stop
      // the new one too (a no-op when the stop came first).
      if (this.host.sessionId() === session)
        desktop.nativeVoice
          .stopScreen(session, started.capture)
          .catch((err) => log.warn("native stopScreen failed", { capture: started.capture, err }));
      return;
    }
    track.retarget(started);
    noteChangedSource(source);
    if (this.endedCapture === track.capture) track.end();
  }

  /** Run the live share `track` at `quality` and `fps`: the host re-sizes the
   *  running capture and republishes it with the new encoding (the SDK cannot
   *  change a sender's parameters), at `published`, the codec the share goes
   *  out with now (the room cannot read the share state). Viewers get a new
   *  publication, so its sid replaces the old one. Throws a
   *  `ScreenQualityError`: "refused" when nothing changed, "publish" when the
   *  republish failed and the share's video is gone. */
  private async changeScreenQuality(
    session: number,
    track: NativeScreenTrack,
    quality: StreamQuality,
    fps: number,
    published: PublishCodec,
  ): Promise<void> {
    const live = (): boolean => this.host.sessionId() === session && this.screen === track;
    // i18n-exempt: internal native-room state guard, never rendered
    if (!live()) throw new ScreenQualityError("refused", "screen share is no longer live");
    const settings = shareSettings(quality, fps);
    const result = await desktop.nativeVoice.setScreenQuality(
      session,
      track.capture,
      settings.capture,
      {
        width: track.width,
        height: track.height,
        maxBitrate: settings.maxBitrate,
        maxFramerate: settings.maxFramerate,
        simulcast: settings.simulcast,
        codec: nativeCodec({ videoCodec: published }),
      },
    );
    if (!result.ok) throw new ScreenQualityError(result.stage, result.message);
    // A stop or leave that came meanwhile released the share (a stop queued
    // behind the command released the new publication), so the change did
    // not take: report it as refused rather than leave the caller's state
    // ahead of the track's.
    if (!live()) {
      // i18n-exempt: internal native-room state guard, never rendered
      throw new ScreenQualityError("refused", "the share ended during the change");
    }
    track.retargetQuality(
      { width: result.width, height: result.height },
      {
        quality,
        fps,
        capture: settings.capture,
        encoding: {
          maxBitrate: settings.maxBitrate,
          maxFramerate: settings.maxFramerate,
          simulcast: settings.simulcast,
        },
      },
    );
    noteChangedQuality(quality, fps);
    const pubs = this.host.publications;
    const old = pubs.get("screen_share");
    if (old?.track === track) pubs.set("screen_share", { ...old, trackSid: result.sid });
    if (this.endedCapture === track.capture) track.end();
  }

  /** A stopped screen track: stop its host capture (a no-op for a capture a
   *  newer one replaced) and forget its publication. */
  private stopScreen(session: number, track: NativeScreenTrack): void {
    const current = this.screen === track;
    if (current) this.screen = null;
    const pubs = this.host.publications;
    if (pubs.get("screen_share")?.track === track) pubs.delete("screen_share");
    // The host ends the audio with its capture: the track follows, but only
    // when the live share stops, never a stale track's late stop.
    if (current) this.screenAudio?.stop();
    if (this.host.sessionId() !== session) return;
    desktop.nativeVoice
      .stopScreen(session, track.capture)
      .catch((err) => log.warn("native stopScreen failed", { capture: track.capture, err }));
  }

  async publishScreen(
    track: PublishableTrack,
    options: PublishOptions,
  ): Promise<NativeLocalPublication> {
    const session = this.host.sessionId();
    // i18n-exempt: internal native-room state guard, never rendered
    if (session === null) throw new Error("native room is not connected");
    if (!(track instanceof NativeScreenTrack))
      // i18n-exempt: internal unsupported-path guard, never rendered
      throw unsupported("publishing a browser screen track");
    // The picker's per-share quality, not the shared path's saved-quality
    // publish options, sets the encoding.
    const encoding = track.publishEncoding;
    const sid = await desktop.nativeVoice.publishScreen(session, track.capture, {
      width: track.width,
      height: track.height,
      maxBitrate: encoding.maxBitrate,
      maxFramerate: encoding.maxFramerate,
      simulcast: encoding.simulcast,
      codec: nativeCodec(options),
    });
    if (this.host.sessionId() !== session)
      // i18n-exempt: internal native-room state guard, never rendered
      throw new Error("native room disconnected during screen publish");
    const publication: NativeLocalPublication = {
      trackSid: sid,
      source: "screen_share",
      kind: "video",
      isMuted: false,
      track,
    };
    this.host.publications.set("screen_share", publication);
    return publication;
  }

  /** Publish the share's audio on the running capture. A stop that lands
   *  while the host publishes (the track is stopped, so its sid has no owner)
   *  unpublishes the sid when it arrives, and nothing is stored. */
  async publishScreenAudio(track: PublishableTrack): Promise<NativeLocalPublication> {
    const session = this.host.sessionId();
    // i18n-exempt: internal native-room state guard, never rendered
    if (session === null) throw new Error("native room is not connected");
    if (!(track instanceof NativeScreenAudioTrack))
      // i18n-exempt: internal unsupported-path guard, never rendered
      throw unsupported("publishing a browser screen audio track");
    const capture = this.screen?.capture;
    // i18n-exempt: internal native-room state guard, never rendered
    if (capture === undefined) throw new Error("screen share is not running");
    // A stale track must not replace a newer share's audio on the host.
    // i18n-exempt: internal native-room state guard, never rendered
    if (track.isStopped || this.screenAudio !== track) throw new Error("screen audio is stale");
    const sid = await desktop.nativeVoice.publishScreenAudio(session, capture);
    if (this.host.sessionId() !== session)
      // i18n-exempt: internal native-room state guard, never rendered
      throw new Error("native room disconnected during screen audio publish");
    const publication: NativeLocalPublication = {
      trackSid: sid,
      source: "screen_share_audio",
      kind: "audio",
      isMuted: false,
      track,
    };
    if (track.isStopped || this.screenAudio !== track) {
      await desktop.nativeVoice
        .unpublishScreenAudio(session, sid)
        .catch((err: unknown) => log.warn("native unpublishScreenAudio failed", { sid, err }));
      return publication;
    }
    this.host.publications.set("screen_share_audio", publication);
    return publication;
  }

  /** Unpublish the share's audio alone; the track is stopped next by the
   *  shared code, and stop() is idempotent. */
  async unpublishScreenAudio(): Promise<void> {
    const pubs = this.host.publications;
    const audio = pubs.get("screen_share_audio");
    if (audio === undefined) return;
    pubs.delete("screen_share_audio");
    const id = this.host.sessionId();
    if (id !== null) await desktop.nativeVoice.unpublishScreenAudio(id, audio.trackSid);
  }

  /** A stopped audio track: unpublish its sid and forget it. Fire and forget
   *  (stop() is synchronous); a stale sid is a no-op in the host. */
  private stopScreenAudio(session: number, track: NativeScreenAudioTrack): void {
    if (this.screenAudio === track) this.screenAudio = null;
    const pubs = this.host.publications;
    const pub = pubs.get("screen_share_audio");
    if (pub?.track !== track) return;
    pubs.delete("screen_share_audio");
    if (this.host.sessionId() !== session) return;
    desktop.nativeVoice
      .unpublishScreenAudio(session, pub.trackSid)
      .catch((err) => log.warn("native unpublishScreenAudio failed", { sid: pub.trackSid, err }));
  }

  /** Unpublishing a screen share stops its track, and with it the host
   *  capture (which unpublishes): the shared code stops the track next
   *  anyway, and stop() is idempotent. With `stopCapture` false (a codec
   *  republish) it unpublishes alone and the capture keeps running. */
  async unpublishScreen(stopCapture = true): Promise<void> {
    const screen = this.host.publications.get("screen_share");
    if (screen === undefined) return;
    this.host.publications.delete("screen_share");
    if (!stopCapture) {
      // A codec republish: unpublish alone, the capture publishes again next.
      const id = this.host.sessionId();
      if (id !== null && screen.track instanceof NativeScreenTrack)
        await desktop.nativeVoice.unpublishScreen(id, screen.track.capture);
      return;
    }
    if (screen.track instanceof NativeScreenTrack) screen.track.stop();
  }
}

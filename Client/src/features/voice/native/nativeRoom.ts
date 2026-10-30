// NativeRoom — the Linux stand-in for livekit-client's `Room`.
//
// The voice state machine (joinOrchestration, roomLifecycle, mediaControl,
// roomEventHandlers, the reconnect loop) only ever touches a small slice of
// `Room`: connect/disconnect, the event emitter, `state`, the local
// participant's microphone toggle, and the remote participants' audio
// publications (deafen), the camera publish and the remote video tracks.
// This class implements exactly that slice over the Rust backend's commands
// and its single `native-voice` Tauri event, so the shared modules run
// unchanged on Linux. Media never crosses IPC: audio capture (the session's
// own input stream, APM then RNNoise) and playout (its own mixer) happen in the
// Rust process, so no `TrackSubscribed` is raised for audio — there is no
// MediaStreamTrack to attach, and per-user volume is a command
// (`NativeRemoteParticipant.setVolume`) instead of a gain node. Video does reach the webview, over the session's loopback frame
// socket: a subscribed remote video track is raised as `TrackSubscribed`
// with a `NativeVideoRenderer`'s canvas track as its `mediaStreamTrack`, and
// a published camera is a `NativeCameraTrack` whose preview reads the host
// capture back over the same socket. Camera and screen share both capture in
// the backend (`createCameraTracks`/`createScreenTracks`; on Wayland the
// screen picker's desktop portal dialog), so they keep working while the
// window is hidden, and the track each returns is the local preview.
//
// Lifecycle: the Tauri subscription is registered per connect() and
// released in disconnect() with the late-resolve guard, and disconnect() is
// scoped to this room's own native session id, so a superseded attempt tears
// down only its own room. Every renderer, the camera track and the screen
// track are disposed when their track goes away and, at the latest, in
// disconnect().
import { DisconnectReason, RoomEvent, type VideoQuality } from "livekit-client";
import { createLogger } from "../../../lib/logger";
import { loadPref } from "../../../lib/prefs/preferences";
import { NoiseFloorTracker } from "../../../lib/noiseFloor";
import { voiceStore } from "../../../stores/voice.store";
import { desktop } from "../../../platform/desktop";
import type {
  NativeVoiceAudioOptions,
  NativeVoiceEnvelope,
  NativeVoiceEvent,
  NativeVoiceStats,
  NativeVoiceStatsEntry,
  NativeVoiceTrack,
  NativeVideoQuality,
} from "../../../platform/contracts/nativeVoice";
import { nativeCounters } from "./counters";

/** How often a remote participant whose frames stopped decrypting
 *  is re-reported — the web E2EE worker's cadence, so the shared streak grace
 *  in `lib/roomEventHandlers.ts` applies to the native path
 *  unchanged. Unlike the web worker's, these reports are not rate-limited, so
 *  the native room recovers after the short quiet gap (`isNativeRoom`). */
const DECRYPT_REPORT_MS = 1000;
import { NativeVideoRenderer } from "./videoRenderer";
import { NativeCameraTrack } from "./nativeCameraTrack";
import { CameraDeviceUnusable, CameraSwitchUnavailable } from "../cameraSwitch";
import { NativeScreenAudioTrack } from "./screenAudioTrack";
import {
  NativeScreenTrack,
  ScreenQualityError,
  startError,
  isDeviceFallback,
  pickerDismissed,
} from "./screenTrack";
import {
  noteChangedQuality,
  noteChangedSource,
  pickChangeSource,
  pickScreenSource,
  shareSettings,
} from "./screenPicker";
import type { StreamQuality } from "@lib/screenShare";
import type { PublishCodec } from "../videoCodec";

const log = createLogger("nativeRoom");

/** The host's reason for a camera that opened but produced no first frame
 *  (`TIMED_OUT` in `src-tauri/src/native_voice/camera.rs`). */
// i18n-exempt: the host's error text matched, never rendered
const CAMERA_NO_FRAME = "camera capture produced no frame in time";

type Listener = (...args: unknown[]) => void;

// --- Participant model: the members audioElements/livekitDiagnostics read ---

/** A remote video track as the shared handlers read it: the renderer's
 *  canvas track stands in for the browser's decoded track. */
export class NativeRemoteVideoTrack {
  readonly kind = "video";
  private disposed = false;
  private last: { bytes: number; atMs: number } | null = null;
  /** bits/s from the last two distinct samples' byte deltas; undefined until
   *  two exist (what the tile chip reads on the web path). */
  currentBitrate: number | undefined = undefined;
  constructor(
    readonly sid: string,
    readonly source: string,
    private readonly renderer: NativeVideoRenderer,
    private readonly stats: () => Promise<NativeVoiceStats | null> = () => Promise.resolve(null),
  ) {}
  /** The tile chip's receiver sample (`remoteTracks.getRemoteVideoStats`),
   *  from the host's shared stats tick. Undefined when the host has no sample
   *  for this track, so the chip falls back to the element's size. */
  async getReceiverStats(): Promise<
    | {
        frameWidth: number;
        frameHeight: number;
        framesDecoded: number;
        timestamp: number;
        mimeType?: string;
        packetsLost: number;
        packetsReceived: number;
      }
    | undefined
  > {
    const reply = await this.stats();
    const s = this.disposed ? undefined : reply?.remoteVideo[this.sid];
    if (reply == null || s === undefined) return undefined;
    if (this.last !== null && reply.atMs > this.last.atMs) {
      this.currentBitrate =
        s.bytesReceived >= this.last.bytes
          ? ((s.bytesReceived - this.last.bytes) * 8 * 1000) / (reply.atMs - this.last.atMs)
          : undefined;
    }
    if (this.last === null || reply.atMs > this.last.atMs) {
      this.last = { bytes: s.bytesReceived, atMs: reply.atMs };
    }
    return {
      frameWidth: s.frameWidth,
      frameHeight: s.frameHeight,
      framesDecoded: s.framesDecoded,
      timestamp: reply.atMs,
      mimeType: s.mimeType,
      packetsLost: s.packetsLost,
      packetsReceived: s.packetsReceived,
    };
  }
  get mediaStreamTrack(): MediaStreamTrack {
    return this.renderer.mediaStreamTrack;
  }
  /** The tiles own their elements; nothing is attached here. */
  detach(): HTMLMediaElement[] {
    return [];
  }
  dispose(): void {
    this.disposed = true;
    this.renderer.dispose();
  }
}

export class NativeRemotePublication {
  readonly trackSid: string;
  readonly kind: string;
  readonly source: string;
  isSubscribed = true;
  /** Video: whether the SFU sends it, and at which layer. A fresh
   *  subscription comes at the top one. */
  isEnabled = true;
  private quality: NativeVideoQuality = "high";
  /** The host's last view update: the next one waits for it. */
  private viewSent: Promise<void> = Promise.resolve();
  isMuted: boolean;
  /** livekit-client's shape for the server's encryption report (`Encryption_Type`:
   *  0 none, 1 GCM), so the web path's refusal of unencrypted media applies here. */
  readonly trackInfo: { encryption: number };
  /** Video only, while subscribed. Audio has none: playout is native. */
  track: NativeRemoteVideoTrack | undefined = undefined;
  constructor(
    private readonly room: NativeRoom,
    private readonly identity: string,
    info: NativeVoiceTrack,
  ) {
    this.trackSid = info.sid;
    this.kind = info.kind;
    this.source = info.source;
    this.isMuted = info.muted;
    this.trackInfo = { encryption: info.encrypted ? 1 : 0 };
  }
  setSubscribed(subscribed: boolean): void {
    if (this.isSubscribed === subscribed) return;
    this.isSubscribed = subscribed;
    this.room.setSubscribed(this.identity, this.trackSid, subscribed);
  }
  /** livekit-client's layer controls, which RemoteTracks drives: the layer
   *  first, then whether it is sent. */
  setEnabled(enabled: boolean): void {
    this.setVideoView(enabled, this.quality);
  }
  setVideoQuality(quality: VideoQuality): void {
    this.setVideoView(this.isEnabled, (["low", "medium", "high"] as const)[quality] ?? "high");
  }
  /** Maps the size to a quality by choice (livekit 0.9.5's
   *  update_video_dimensions exists but is not used): the smallest of the
   *  usual 180p/360p/720p layers that covers the tile. */
  setVideoDimensions({ width, height }: { width: number; height: number }): void {
    const side = Math.max(width, height);
    this.setVideoView(this.isEnabled, side <= 320 ? "low" : side <= 640 ? "medium" : "high");
  }
  /** A new subscription starts enabled at the top layer again. */
  resetVideoView(): void {
    this.isEnabled = true;
    this.quality = "high";
  }
  /** A layer asked for while hidden goes out with the enable. */
  private setVideoView(enabled: boolean, quality: NativeVideoQuality): void {
    if (enabled === this.isEnabled && quality === this.quality) return;
    const send = enabled || this.isEnabled;
    this.isEnabled = enabled;
    this.quality = quality;
    if (!send) return;
    this.viewSent = this.viewSent.then(() =>
      this.room.setVideoView(this.identity, this.trackSid, enabled, quality),
    );
  }
}

export class NativeRemoteParticipant {
  readonly trackPublications = new Map<string, NativeRemotePublication>();
  private volume = 1;
  constructor(
    readonly identity: string,
    private readonly room: NativeRoom,
  ) {}
  get audioTrackPublications(): Map<string, NativeRemotePublication> {
    const audio = new Map<string, NativeRemotePublication>();
    for (const [sid, pub] of this.trackPublications) if (pub.kind === "audio") audio.set(sid, pub);
    return audio;
  }
  getTrackPublication(source: string): NativeRemotePublication | undefined {
    for (const pub of this.trackPublications.values()) if (pub.source === source) return pub;
    return undefined;
  }
  /** The microphone's playout gain, as livekit-client's (1 is unity). */
  getVolume(): number {
    return this.volume;
  }
  setVolume(volume: number): void {
    this.volume = volume;
    this.room.setVolume(this.identity, volume);
  }
}

/** The slice of livekit-client's `LocalVideoTrack` the camera path hands
 *  `publishTrack`. */
interface PublishableTrack {
  kind: string;
  source: string;
  mediaStreamTrack: MediaStreamTrack;
}

interface PublishOptions {
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
function nativeCodec(options: PublishOptions): "vp8" | "h264" | "vp9" {
  return options.videoCodec === "h264" || options.videoCodec === "vp9" ? options.videoCodec : "vp8";
}

/** A local camera or screen publication, as `getLocalCameraStream`,
 *  `getLocalScreenshareStream` and the diagnostics read it. */
interface NativeLocalPublication {
  readonly trackSid: string;
  readonly source: string;
  readonly kind: string;
  readonly isMuted: boolean;
  /** The camera track is a `NativeCameraTrack`, the screen share a
   *  `NativeScreenTrack`; both stand in for `LocalVideoTrack`. */
  readonly track: PublishableTrack | NativeCameraTrack | NativeScreenTrack | NativeScreenAudioTrack;
}

/** How long callers share one host stats reply: the poller, a watched tile
 *  and your own share all poll every 2 s, so their ticks collapse into one
 *  IPC; the poller alone always gets a fresh one. */
const STATS_SHARE_MS = 1500;

/** Stands in for livekit-client's `PCTransport` where connectionStats and
 *  livekitDiagnostics read it. */
class NativeStatsTransport {
  constructor(
    private readonly room: NativeRoom,
    private readonly side: "publisher" | "subscriber",
  ) {}
  /** undefined (not an empty report) when there is nothing: the poller must
   *  see "no transports" and keep reading unavailable, never a 4-bar
   *  "excellent" with rtt 0. */
  async getStats(): Promise<ReadonlyMap<string, NativeVoiceStatsEntry> | undefined> {
    const entries = (await this.room.readStats())?.[this.side];
    return entries === undefined || entries.length === 0
      ? undefined
      : new Map(entries.map((e) => [e.id, e]));
  }
  /** The backend does not report ICE state to the webview; livekitDiagnostics
   *  logs these. */
  getICEConnectionState(): string {
    return "unknown";
  }
  getConnectionState(): string {
    return "unknown";
  }
  getSignallingState(): string {
    return "unknown";
  }
}

export class NativeRoom {
  state: "disconnected" | "connecting" | "connected" | "reconnecting" = "disconnected";
  readonly name = "";
  readonly canPlaybackAudio = true;
  /** Voice plays in the session's own mixer, so per-user gains above 1 are
   *  fine here (audioElements checks for this marker). */
  readonly nativePlayout = true;
  /** connectionStats/livekitDiagnostics read `engine.pcManager`; native has
   *  no browser peer connection, so these stand-ins serve the host's filtered
   *  W3C-shaped stats (`native_voice_get_stats`) and nothing while the room
   *  is not connected. */
  readonly engine = {
    pcManager: {
      publisher: new NativeStatsTransport(this, "publisher"),
      subscriber: new NativeStatsTransport(this, "subscriber"),
    },
    client: { ws: undefined },
  };
  private statsTick: {
    session: number;
    at: number;
    reply: Promise<NativeVoiceStats | null>;
  } | null = null;
  /** @internal The adapter's own readers only: the stats transports, the
   *  remote video tracks and the screen track. One host call per tick. */
  readStats(): Promise<NativeVoiceStats | null> {
    const session = this.sessionId;
    if (session === null || this.state !== "connected") return Promise.resolve(null);
    const now = performance.now();
    const tick = this.statsTick;
    if (tick !== null && tick.session === session && now - tick.at < STATS_SHARE_MS) {
      return tick.reply;
    }
    const reply = desktop.nativeVoice
      .getStats(session)
      .catch(() => null)
      .then((r) => (this.sessionId === session ? r : null));
    this.statsTick = { session, at: now, reply };
    return reply;
  }
  /** connectionDiagnostics asks this instead of `engine.client.ws`: the
   *  backend's signaling is up exactly while the room reads "connected"
   *  (it reports "reconnecting" and "disconnected" as they happen). */
  isSignalingConnected(): boolean {
    return this.state === "connected";
  }
  readonly remoteParticipants = new Map<string, NativeRemoteParticipant>();
  /** One re-report per remote identity whose frames stopped
   *  decrypting; cleared when they decrypt again or the peer leaves. */
  private readonly decryptTimers = new Map<string, ReturnType<typeof setInterval>>();
  readonly localParticipant = {
    identity: "",
    permissions: undefined as { canPublish: boolean; canPublishSources: number[] } | undefined,
    trackPublications: new Map<string, NativeLocalPublication>(),
    getTrackPublication: (source: string): NativeLocalPublication | undefined =>
      this.localParticipant.trackPublications.get(source),
    /** An enable sends the push-to-talk and sensitivity gates first, so the
     *  capture opens behind them: with the key up it sends silence, never the room. A
     *  disable (mute, deafen) stops the capture whatever the gate. */
    setMicrophoneEnabled: async (
      enabled: boolean,
      _captureOptions?: unknown,
      publishOptions?: { audioPreset?: { maxBitrate: number } },
    ): Promise<void> => {
      // i18n-exempt: internal native-room state guard, consumed by joinOrchestration's catalog toast
      if (this.sessionId === null) throw new Error("native room is not connected");
      if (enabled) {
        await desktop.nativeVoice.setPttGated(this.sessionId, this.pttGated);
        // A new session starts with no sensitivity gate and at 100 %.
        if (this.voiceThreshold > 0)
          await desktop.nativeVoice.setVoiceGate(this.sessionId, this.voiceThreshold);
        if (this.inputGainPercent !== 100)
          await desktop.nativeVoice.setInputGain(this.sessionId, this.inputGainPercent);
      }
      // A device-switch re-enable passes no options: keep the last bitrate
      // so a first publish after a failed one is not left at the default.
      const bitrate = publishOptions?.audioPreset?.maxBitrate ?? this.micBitrate;
      this.micBitrate = bitrate;
      if (enabled) this.capturing = true;
      else this.stopInputLevels();
      if (bitrate === undefined) await desktop.nativeVoice.setMicrophone(this.sessionId, enabled);
      else await desktop.nativeVoice.setMicrophone(this.sessionId, enabled, bitrate);
    },
    /** Only the disable is reachable: the camera path publishes its own
     *  track (`publishTrack`), as on the web path. */
    setCameraEnabled: async (enabled: boolean): Promise<void> => {
      if (enabled) throw unsupported("setCameraEnabled(true)");
      await this.unpublishCamera();
    },
    /** Only the disable is reachable, as for the camera. */
    setScreenShareEnabled: async (enabled: boolean): Promise<void> => {
      if (enabled) throw unsupported("setScreenShareEnabled(true)");
      await this.unpublishScreen();
    },
    /** The native stand-in for `createLocalScreenTracks`: pick, then capture
     *  in the host. Resolves once the capture delivers its first frame. */
    createScreenTracks: () => this.createScreenTracks(),
    /** The native stand-in for `createLocalVideoTrack`: capture in the host.
     *  Resolves once the capture delivers its first frame. The camera is not
     *  published until `publishTrack`; capture keeps running while the window
     *  is hidden. */
    createCameraTracks: (options: PublishOptions) => this.createCameraTracks(options),
    publishTrack: (
      track: PublishableTrack | NativeCameraTrack | NativeScreenTrack | NativeScreenAudioTrack,
      options: PublishOptions,
    ) => {
      const source = options.source ?? (track as PublishableTrack).source;
      if (source === "screen_share_audio") return this.publishScreenAudio(track);
      return source === "screen_share"
        ? this.publishScreen(track, options)
        : this.publishCamera(track as NativeCameraTrack, options);
    },
    /** Takes the `mediaStreamTrack`, as the shared camera and screen-share
     *  paths pass it. `stopOnUnpublish` false (a codec republish) unpublishes
     *  only: the host capture and its preview keep running for the publish
     *  that follows. */
    unpublishTrack: async (track: MediaStreamTrack, stopOnUnpublish = true): Promise<void> => {
      const pubs = this.localParticipant.trackPublications;
      if (pubs.get("camera")?.track.mediaStreamTrack === track)
        await this.unpublishCamera(stopOnUnpublish);
      if (pubs.get("screen_share")?.track.mediaStreamTrack === track)
        await this.unpublishScreen(stopOnUnpublish);
      const audio = pubs.get("screen_share_audio");
      if (audio?.track instanceof NativeScreenAudioTrack && audio.track.mediaStreamTrack === track)
        await this.unpublishScreenAudio();
    },
  };

  private sessionId: number | null = null;
  /** The last audio bitrate the voice config set; reused by option-less enables. */
  private micBitrate: number | undefined;
  /** Push-to-talk's key is up: the session's open capture sends silence. */
  private pttGated = false;
  /** The input-sensitivity gate's threshold (0: none) and who hears its
   *  verdicts. */
  private voiceThreshold = 0;
  private onVoiceGate: (speaking: boolean | null) => void = () => {};
  /** Automatic sensitivity's noise-floor estimate over the capture's level
   *  reports, as the web detector runs it; null on a fixed threshold. */
  private autoFloor: NoiseFloorTracker | null = null;
  private onAutoThreshold: (threshold: number) => void = () => {};
  /** The input volume (0-200 %); a new session starts at 100. */
  private inputGainPercent = 100;
  /** Who hears the capture's level reports (the settings meter); null as
   *  the level means the capture stopped. */
  private onInputLevel: ((rms: number | null, open: boolean) => void) | null = null;
  /** Whether the session's capture runs, so a report still in flight after a
   *  mute or leave cannot repaint the meter. */
  private capturing = false;
  /** The session's frame-socket base URL (token included); never logged. */
  private frames = "";
  /** Whether this room is counted in `nativeCounters.openRooms`. */
  private counted = false;
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Releases this connect attempt's event subscription; null when none. */
  private unsubscribe: (() => void) | null = null;
  /** Events that arrived before connect() resolved with this room's id. */
  private pending: NativeVoiceEnvelope[] | null = null;
  private announcing = false;
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

  /** `volumeOf` is the saved volume a participant starts at: the web path
   *  applies it on the audio `TrackSubscribed`, which native never raises.
   *  `screenshareVolumeOf` is their screen-share audio's, which the web path
   *  sets on its audio element; `applyScreenshareVolumes` re-reads it. */
  constructor(
    private audio: NativeVoiceAudioOptions,
    private readonly volumeOf: (identity: string) => number = () => 1,
    private readonly screenshareVolumeOf: (identity: string) => number = () => 1,
  ) {}

  // --- Emitter (the livekit Room surface roomLifecycle wires) ---

  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (set === undefined) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return this;
  }
  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }
  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  // --- Room surface ---

  /** E2EE is enabled at connect in the backend; the key arrived earlier via
   *  `native_voice_set_key`. Kept so roomLifecycle's call site is shared. */
  setE2EEEnabled(_enabled: boolean): Promise<void> {
    return Promise.resolve();
  }
  /** Push-to-talk for the native room, which has no web mic processor to
   *  gate (AudioPipeline.setPttGated): the key flips the session's gate,
   *  which zeroes the open capture's frames. It never opens or
   *  closes the capture, so a press is not clipped by a device reopen and
   *  never opens a microphone the user muted. */
  setPttGated(gated: boolean): void {
    if (this.pttGated === gated) return;
    this.pttGated = gated;
    if (this.sessionId === null) return;
    desktop.nativeVoice
      .setPttGated(this.sessionId, gated)
      .catch((err) => log.warn("Push-to-talk could not switch the native gate", err));
  }
  /** The input-sensitivity gate for the native room, which has no web mic
   *  processor to run the detector (AudioPipeline.startVadPolling): the
   *  session's capture gates on `gate`, a threshold on the web path's scale,
   *  and its verdicts go to `onSpeaking` — open at the start, as the web
   *  detector starts, and null when 0 runs no gate. "auto" runs the web
   *  path's noise-floor estimate over the capture's level reports, starting
   *  at `auto.seed` and telling `auto.onThreshold` each step. */
  setVoiceGate(
    gate: number | "auto",
    onSpeaking: (speaking: boolean | null) => void,
    auto?: { seed?: number; onThreshold?: (threshold: number) => void },
  ): void {
    this.autoFloor = gate === "auto" ? new NoiseFloorTracker(auto?.seed) : null;
    this.onAutoThreshold = auto?.onThreshold ?? (() => {});
    const threshold = this.autoFloor?.threshold ?? (gate === "auto" ? 0 : gate);
    this.voiceThreshold = threshold;
    this.onVoiceGate = onSpeaking;
    onSpeaking(threshold > 0 ? true : null);
    if (this.sessionId === null) return;
    desktop.nativeVoice
      .setVoiceGate(this.sessionId, threshold)
      .catch((err) => log.warn("Voice sensitivity could not reach the native gate", err));
  }
  /** Automatic sensitivity moved: the gate takes the new level without
   *  restarting, as the web detector's worklet does. */
  private retuneVoiceGate(threshold: number): void {
    this.voiceThreshold = threshold;
    this.onAutoThreshold(threshold);
    if (this.sessionId === null) return;
    desktop.nativeVoice
      .setVoiceGate(this.sessionId, threshold, true)
      .catch((err) => log.warn("Automatic sensitivity could not reach the native gate", err));
  }
  /** The input volume (0-200 %, the `inputVolume` pref) for the session's
   *  capture, as AudioPipeline.setInputVolume sets the web processor's gain.
   *  The noise floor learned behind the old gain is dropped, as the web
   *  detector's resetFloor does. */
  setInputGain(percent: number): void {
    this.inputGainPercent = Math.max(0, Math.min(200, percent));
    this.autoFloor?.reset(performance.now());
    if (this.sessionId === null) return;
    desktop.nativeVoice
      .setInputGain(this.sessionId, this.inputGainPercent)
      .catch((err) => log.warn("Input volume could not reach the native capture", err));
  }
  /** The mic processing toggles (echo cancellation, noise suppression,
   *  automatic gain control, Enhanced Noise Suppression): kept for a
   *  reconnect and, in a call, applied by the session's capture and echo
   *  canceller within a few frames, as AudioPipeline.reapplyAudioProcessing
   *  restarts the web mic track for them. */
  setAudioProcessing(audio: NativeVoiceAudioOptions): void {
    this.audio = audio;
    if (this.sessionId === null) return;
    desktop.nativeVoice
      .setAudioProcessing(this.sessionId, audio)
      .catch((err) => log.warn("Audio processing could not reach the native capture", err));
  }
  /** Hear the capture's level reports (null to stop): the settings meter's
   *  feed while the native capture runs. */
  setInputLevelListener(listener: ((rms: number | null, open: boolean) => void) | null): void {
    this.onInputLevel = listener;
  }
  /** The capture stopped (mute, deafen, leave): no more reports will come. */
  private stopInputLevels(): void {
    if (!this.capturing) return;
    this.capturing = false;
    this.onInputLevel?.(null, false);
  }
  /** Native playout needs no autoplay gesture. */
  startAudio(): Promise<void> {
    return Promise.resolve();
  }
  /** Same contract as livekit-client's: `deviceId` is one of the ids the
   *  device list reported (`listAudioDevices`), "" or "default" is the host
   *  default. The camera is switched through
   *  `NativeCameraTrack.setDeviceId`, so this returns false for `videoinput`. */
  async switchActiveDevice(kind: string, deviceId: string): Promise<boolean> {
    if (kind !== "audioinput" && kind !== "audiooutput") return false;
    // i18n-exempt: internal native-room state guard, consumed by joinOrchestration's catalog toast
    if (this.sessionId === null) throw new Error("native room is not connected");
    try {
      await desktop.nativeVoice.setDevice(
        this.sessionId,
        kind,
        deviceId === "default" ? "" : deviceId,
      );
    } catch (err) {
      // The host reports "device not found; switched to the default" as a
      // rejection, but the switch itself succeeded — surface it as success,
      // not "mic failed" (voice #19). A real failure still rejects.
      if (isDeviceFallback(err)) return true;
      throw err;
    }
    return true;
  }

  async connect(url: string, token: string): Promise<void> {
    // i18n-exempt: internal native-room state guard, never rendered
    if (this.sessionId !== null) throw new Error("native room already connected");
    this.state = "connecting";
    this.pending = [];
    // Subscribe before the connect command so the backend's first events
    // (the participant snapshot) cannot slip past. The registry's unsubscribe
    // is late-resolve safe, so releasing it early is always correct.
    nativeCounters.listeners++;
    this.unsubscribe = desktop.nativeVoice.onEvent((envelope) => this.onEnvelope(envelope));
    try {
      const connected = await desktop.nativeVoice.connect(url, token, this.audio);
      this.sessionId = connected.session;
      this.localParticipant.identity = connected.identity;
      this.frames = connected.frames;
    } catch (err) {
      this.state = "disconnected";
      this.pending = null;
      this.releaseSubscription();
      throw err;
    }
    this.state = "connected";
    nativeCounters.openRooms++;
    this.counted = true;
    const queued = this.pending;
    this.pending = null;
    for (const envelope of queued ?? []) this.onEnvelope(envelope);
    this.announcing = true;
  }

  async disconnect(): Promise<void> {
    const id = this.sessionId;
    this.announcing = false;
    this.releaseSubscription();
    this.pending = null;
    this.releaseVideo();
    this.clearDecryptTimers();
    this.stopInputLevels();
    if (id === null) return;
    this.sessionId = null;
    this.statsTick = null;
    if (this.counted) nativeCounters.openRooms--;
    this.counted = false;
    this.state = "disconnected";
    // Scoped to this room's own session: the backend ignores a stale id.
    nativeCounters.rust = await desktop.nativeVoice.disconnect(id);
  }

  /** Start native camera capture: the shared `enableCamera` calls this in
   *  place of `createLocalVideoTrack`, then publishes the returned track. The
   *  capture runs in the host and keeps running while the window is hidden;
   *  the self-view preview reads it back over the frame socket's `camera`
   *  route. */
  private async createCameraTracks(options: PublishOptions): Promise<NativeCameraTrack[]> {
    // i18n-exempt: internal native-room state guard, never rendered
    if (this.sessionId === null) throw new Error("native room is not connected");
    const session = this.sessionId;
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
    if (this.sessionId !== session) {
      // Disconnected meanwhile: the session (and its capture) is gone.
      // i18n-exempt: internal native-room state guard, never rendered
      throw new Error("native room disconnected during camera start");
    }
    const track = new NativeCameraTrack(
      started,
      `${this.frames}/camera`,
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
    const live = (): boolean => this.sessionId === session && this.camera === track;
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
      if (this.sessionId === session)
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
  private async publishCamera(
    track: NativeCameraTrack,
    options: PublishOptions,
  ): Promise<NativeLocalPublication> {
    // i18n-exempt: internal native-room state guard, never rendered
    if (this.sessionId === null) throw new Error("native room is not connected");
    if (!(track instanceof NativeCameraTrack))
      // i18n-exempt: internal unsupported-path guard, never rendered
      throw unsupported("publishing a browser camera track");
    const encoding = options.videoEncoding;
    if (encoding?.maxFramerate === undefined)
      // i18n-exempt: internal publish-config guard, never rendered
      throw new Error("native camera publish needs videoEncoding.maxBitrate and maxFramerate");
    const session = this.sessionId;
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
    if (this.sessionId !== session) {
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
    this.localParticipant.trackPublications.set("camera", publication);
    return publication;
  }

  /** A stopped camera track: forget its publication, then stop its host
   *  capture (a no-op for a capture a newer one replaced). */
  private stopCamera(session: number, track: NativeCameraTrack): void {
    if (this.camera === track) this.camera = null;
    const pubs = this.localParticipant.trackPublications;
    if (pubs.get("camera")?.track === track) pubs.delete("camera");
    if (this.sessionId !== session) return;
    desktop.nativeVoice
      .stopCamera(session, track.capture)
      .catch((err) => log.warn("native stopCamera failed", { capture: track.capture, err }));
  }

  /** `stopCapture` false unpublishes alone and leaves the capture, and the
   *  track that owns it, running (a codec republish publishes it again). */
  private async unpublishCamera(stopCapture = true): Promise<void> {
    const camera = this.localParticipant.trackPublications.get("camera");
    if (camera === undefined) return;
    this.localParticipant.trackPublications.delete("camera");
    if (!stopCapture) {
      if (this.sessionId !== null)
        await desktop.nativeVoice.unpublishCamera(this.sessionId, camera.trackSid);
      return;
    }
    if (camera.track instanceof NativeCameraTrack) {
      // Stops the host capture (and, if still current, unpublishes).
      camera.track.stop();
      return;
    }
    if (this.sessionId !== null)
      await desktop.nativeVoice.unpublishCamera(this.sessionId, camera.trackSid);
  }

  private async createScreenTracks(): Promise<Array<NativeScreenTrack | NativeScreenAudioTrack>> {
    // i18n-exempt: internal native-room state guard, never rendered
    if (this.sessionId === null) throw new Error("native room is not connected");
    const session = this.sessionId;
    const pick = await pickScreenSource();
    if (pick === null) throw pickerDismissed();
    // i18n-exempt: internal native-room state guard, never rendered
    if (this.sessionId !== session) throw new Error("native room disconnected during screen pick");
    // The picker resolved the capture pacing and size from the quality and fps
    // chosen in the dialog (defaulted from the saved prefs).
    const started = await desktop.nativeVoice
      .startScreen(session, pick.source, pick.capture)
      .catch((err: unknown) => {
        throw startError(err);
      });
    if (this.sessionId !== session) {
      // Disconnected meanwhile: the session (and its capture) is gone.
      // i18n-exempt: internal native-room state guard, never rendered
      throw new Error("native room disconnected during screen capture");
    }
    const track = new NativeScreenTrack(
      started,
      `${this.frames}/screen`,
      (t) => this.stopScreen(session, t),
      { maxBitrate: pick.maxBitrate, maxFramerate: pick.maxFramerate, simulcast: pick.simulcast },
      pick.capture,
      pick.quality,
      pick.fps,
      (t) => this.changeScreenSource(session, t),
      (t, q, fps, published) => this.changeScreenQuality(session, t, q, fps, published),
      () => this.readStats(),
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
    const live = (): boolean => this.sessionId === session && this.screen === track;
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
      if (this.sessionId === session)
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
    const live = (): boolean => this.sessionId === session && this.screen === track;
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
    const pubs = this.localParticipant.trackPublications;
    const old = pubs.get("screen_share");
    if (old?.track === track) pubs.set("screen_share", { ...old, trackSid: result.sid });
    if (this.endedCapture === track.capture) track.end();
  }

  /** A stopped screen track: stop its host capture (a no-op for a capture a
   *  newer one replaced) and forget its publication. */
  private stopScreen(session: number, track: NativeScreenTrack): void {
    const current = this.screen === track;
    if (current) this.screen = null;
    const pubs = this.localParticipant.trackPublications;
    if (pubs.get("screen_share")?.track === track) pubs.delete("screen_share");
    // The host ends the audio with its capture: the track follows, but only
    // when the live share stops, never a stale track's late stop.
    if (current) this.screenAudio?.stop();
    if (this.sessionId !== session) return;
    desktop.nativeVoice
      .stopScreen(session, track.capture)
      .catch((err) => log.warn("native stopScreen failed", { capture: track.capture, err }));
  }

  private async publishScreen(
    track: PublishableTrack,
    options: PublishOptions,
  ): Promise<NativeLocalPublication> {
    // i18n-exempt: internal native-room state guard, never rendered
    if (this.sessionId === null) throw new Error("native room is not connected");
    if (!(track instanceof NativeScreenTrack))
      // i18n-exempt: internal unsupported-path guard, never rendered
      throw unsupported("publishing a browser screen track");
    // The picker's per-share quality, not the shared path's saved-quality
    // publish options, sets the encoding.
    const encoding = track.publishEncoding;
    const session = this.sessionId;
    const sid = await desktop.nativeVoice.publishScreen(session, track.capture, {
      width: track.width,
      height: track.height,
      maxBitrate: encoding.maxBitrate,
      maxFramerate: encoding.maxFramerate,
      simulcast: encoding.simulcast,
      codec: nativeCodec(options),
    });
    if (this.sessionId !== session)
      // i18n-exempt: internal native-room state guard, never rendered
      throw new Error("native room disconnected during screen publish");
    const publication: NativeLocalPublication = {
      trackSid: sid,
      source: "screen_share",
      kind: "video",
      isMuted: false,
      track,
    };
    this.localParticipant.trackPublications.set("screen_share", publication);
    return publication;
  }

  /** Publish the share's audio on the running capture. A stop that lands
   *  while the host publishes (the track is stopped, so its sid has no owner)
   *  unpublishes the sid when it arrives, and nothing is stored. */
  private async publishScreenAudio(track: PublishableTrack): Promise<NativeLocalPublication> {
    // i18n-exempt: internal native-room state guard, never rendered
    if (this.sessionId === null) throw new Error("native room is not connected");
    if (!(track instanceof NativeScreenAudioTrack))
      // i18n-exempt: internal unsupported-path guard, never rendered
      throw unsupported("publishing a browser screen audio track");
    const session = this.sessionId;
    const capture = this.screen?.capture;
    // i18n-exempt: internal native-room state guard, never rendered
    if (capture === undefined) throw new Error("screen share is not running");
    // A stale track must not replace a newer share's audio on the host.
    // i18n-exempt: internal native-room state guard, never rendered
    if (track.isStopped || this.screenAudio !== track) throw new Error("screen audio is stale");
    const sid = await desktop.nativeVoice.publishScreenAudio(session, capture);
    if (this.sessionId !== session)
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
    this.localParticipant.trackPublications.set("screen_share_audio", publication);
    return publication;
  }

  /** Unpublish the share's audio alone; the track is stopped next by the
   *  shared code, and stop() is idempotent. */
  private async unpublishScreenAudio(): Promise<void> {
    const pubs = this.localParticipant.trackPublications;
    const audio = pubs.get("screen_share_audio");
    if (audio === undefined) return;
    pubs.delete("screen_share_audio");
    if (this.sessionId !== null)
      await desktop.nativeVoice.unpublishScreenAudio(this.sessionId, audio.trackSid);
  }

  /** A stopped audio track: unpublish its sid and forget it. Fire and forget
   *  (stop() is synchronous); a stale sid is a no-op in the host. */
  private stopScreenAudio(session: number, track: NativeScreenAudioTrack): void {
    if (this.screenAudio === track) this.screenAudio = null;
    const pubs = this.localParticipant.trackPublications;
    const pub = pubs.get("screen_share_audio");
    if (pub?.track !== track) return;
    pubs.delete("screen_share_audio");
    if (this.sessionId !== session) return;
    desktop.nativeVoice
      .unpublishScreenAudio(session, pub.trackSid)
      .catch((err) => log.warn("native unpublishScreenAudio failed", { sid: pub.trackSid, err }));
  }

  /** Unpublishing a screen share stops its track, and with it the host
   *  capture (which unpublishes): the shared code stops the track next
   *  anyway, and stop() is idempotent. With `stopCapture` false (a codec
   *  republish) it unpublishes alone and the capture keeps running. */
  private async unpublishScreen(stopCapture = true): Promise<void> {
    const screen = this.localParticipant.trackPublications.get("screen_share");
    if (screen === undefined) return;
    this.localParticipant.trackPublications.delete("screen_share");
    if (!stopCapture) {
      // A codec republish: unpublish alone, the capture publishes again next.
      if (this.sessionId !== null && screen.track instanceof NativeScreenTrack)
        await desktop.nativeVoice.unpublishScreen(this.sessionId, screen.track.capture);
      return;
    }
    if (screen.track instanceof NativeScreenTrack) screen.track.stop();
  }

  /** Dispose every renderer and the local camera track without raising events:
   *  the session teardown that calls this clears the tiles itself. */
  private releaseVideo(): void {
    for (const p of this.remoteParticipants.values())
      for (const pub of p.trackPublications.values()) {
        pub.track?.dispose();
        pub.track = undefined;
      }
    const camera = this.localParticipant.trackPublications.get("camera");
    this.localParticipant.trackPublications.delete("camera");
    // Stops the host camera capture; the session close releases it too.
    if (camera?.track instanceof NativeCameraTrack) camera.track.stop();
    this.camera = null;
    this.endedCamera = null;
    // The session close releases the host capture; this is the preview.
    this.screen?.stop();
    this.screen = null;
    this.screenAudio?.stop();
    this.screenAudio = null;
    this.endedCapture = null;
    this.localParticipant.trackPublications.delete("screen_share");
    this.localParticipant.trackPublications.delete("screen_share_audio");
  }

  /** A subscribed remote video track: open its renderer and raise it the way
   *  livekit-client does. A resubscribe replaces the old renderer. */
  private subscribeVideo(identity: string, pub: NativeRemotePublication): void {
    this.unsubscribeVideo(identity, pub);
    const renderer = new NativeVideoRenderer(`${this.frames}/remote/${pub.trackSid}`);
    pub.resetVideoView();
    pub.track = new NativeRemoteVideoTrack(pub.trackSid, pub.source, renderer, () =>
      this.readStats(),
    );
    this.emit(RoomEvent.TrackSubscribed, pub.track, pub, this.participant(identity));
  }

  private unsubscribeVideo(identity: string, pub: NativeRemotePublication | undefined): void {
    const track = pub?.track;
    if (pub === undefined || track === undefined) return;
    pub.track = undefined;
    track.dispose();
    this.emit(RoomEvent.TrackUnsubscribed, track, pub, this.participant(identity));
  }

  /** Deafen: forwarded from the publication model. */
  setSubscribed(identity: string, sid: string, subscribed: boolean): void {
    if (this.sessionId === null) return;
    desktop.nativeVoice
      .setSubscribed(this.sessionId, identity, sid, subscribed)
      .catch((err) => log.warn("native setSubscribed failed", { identity, sid, subscribed, err }));
  }

  /** Video layer control: forwarded from the publication model. */
  async setVideoView(
    identity: string,
    sid: string,
    enabled: boolean,
    quality: NativeVideoQuality,
  ): Promise<void> {
    if (this.sessionId === null) return;
    await desktop.nativeVoice
      .setVideoView(this.sessionId, identity, sid, enabled, quality)
      .catch((err) => log.warn("native setVideoView failed", { identity, sid, enabled, err }));
  }

  /** Per-user volume: forwarded from the participant model. */
  setVolume(identity: string, volume: number): void {
    if (this.sessionId === null) return;
    desktop.nativeVoice
      .setVolume(this.sessionId, identity, volume)
      .catch((err) => log.warn("native setVolume failed", { identity, volume, err }));
  }

  /** Screen-share audio volume (0 when muted). */
  private setScreenshareVolume(identity: string, volume: number): void {
    if (this.sessionId === null) return;
    desktop.nativeVoice
      .setScreenshareVolume(this.sessionId, identity, volume)
      .catch((err) => log.warn("native setScreenshareVolume failed", { identity, volume, err }));
  }

  /** Re-read every participant's screen-share audio volume after a change
   *  to it, its mute or the output volume. */
  applyScreenshareVolumes(): void {
    for (const identity of this.remoteParticipants.keys())
      this.setScreenshareVolume(identity, this.screenshareVolumeOf(identity));
  }

  private releaseSubscription(): void {
    const stop = this.unsubscribe;
    this.unsubscribe = null;
    if (stop === null) return;
    nativeCounters.listeners--;
    stop();
  }

  private onEnvelope(envelope: NativeVoiceEnvelope): void {
    if (this.pending !== null) {
      this.pending.push(envelope);
      return;
    }
    if (envelope.session !== this.sessionId) return;
    this.apply(envelope.event);
  }

  private participant(identity: string): NativeRemoteParticipant {
    let p = this.remoteParticipants.get(identity);
    if (p === undefined) {
      this.remoteParticipants.set(identity, (p = new NativeRemoteParticipant(identity, this)));
      p.setVolume(this.volumeOf(identity));
      this.setScreenshareVolume(identity, this.screenshareVolumeOf(identity));
    }
    return p;
  }

  /** The backend auto-subscribes every track, so a voice track that appears
   *  while deafened is unsubscribed here — the native counterpart of
   *  AudioElements.handleTrackSubscribedAudio's guard, which never runs on
   *  Linux because no TrackSubscribed is raised. Stream audio stays
   *  subscribed; deafen silences it through its gain instead. */
  private addPublication(identity: string, track: NativeVoiceTrack): void {
    const p = this.participant(identity);
    if (p.trackPublications.has(track.sid)) return;
    const pub = new NativeRemotePublication(this, identity, track);
    p.trackPublications.set(track.sid, pub);
    if (
      pub.kind === "audio" &&
      pub.source !== "screen_share_audio" &&
      voiceStore.getState().localDeafened
    )
      pub.setSubscribed(false);
    // shortcut: the backend auto-subscribes, so an unwatched stream flows until
    // this event's handler unsubscribes it (opt-in watching); connect the native
    // session with auto_subscribe off if that first moment of video matters.
    if (this.announcing) this.emit(RoomEvent.TrackPublished, pub, p);
  }

  private clearDecryptTimer(identity: string): void {
    clearInterval(this.decryptTimers.get(identity));
    this.decryptTimers.delete(identity);
  }

  private clearDecryptTimers(): void {
    for (const timer of this.decryptTimers.values()) clearInterval(timer);
    this.decryptTimers.clear();
  }

  private apply(event: NativeVoiceEvent): void {
    switch (event.type) {
      case "connected":
        this.releaseVideo();
        this.clearDecryptTimers();
        this.remoteParticipants.clear();
        for (const info of event.participants) {
          this.participant(info.identity);
          for (const t of info.tracks) this.addPublication(info.identity, t);
        }
        this.emit(RoomEvent.Connected);
        break;
      case "participantConnected":
        this.emit(RoomEvent.ParticipantConnected, this.participant(event.identity));
        break;
      case "participantDisconnected": {
        const p = this.remoteParticipants.get(event.identity);
        // livekit-client raises the track unsubscriptions before the leave.
        for (const pub of p?.trackPublications.values() ?? []) {
          this.unsubscribeVideo(event.identity, pub);
          this.emit(RoomEvent.TrackUnpublished, pub, p);
        }
        this.remoteParticipants.delete(event.identity);
        this.clearDecryptTimer(event.identity);
        if (p !== undefined) this.emit(RoomEvent.ParticipantDisconnected, p);
        break;
      }
      case "trackPublished":
        this.addPublication(event.identity, event.track);
        break;
      case "trackSubscribed": {
        this.addPublication(event.identity, event.track);
        const pub = this.participant(event.identity).trackPublications.get(event.track.sid)!;
        // The backend auto-subscribes: one already unsubscribed (not watched)
        // was on its way, and raises nothing.
        if (pub.kind === "video" && pub.isSubscribed) this.subscribeVideo(event.identity, pub);
        break;
      }
      case "trackUnpublished": {
        const p = this.remoteParticipants.get(event.identity);
        const pub = p?.trackPublications.get(event.sid);
        this.unsubscribeVideo(event.identity, pub);
        p?.trackPublications.delete(event.sid);
        if (pub !== undefined) this.emit(RoomEvent.TrackUnpublished, pub, p);
        break;
      }
      case "trackUnsubscribed":
        this.unsubscribeVideo(
          event.identity,
          this.remoteParticipants.get(event.identity)?.trackPublications.get(event.sid),
        );
        break;
      case "trackMuted": {
        const p = this.remoteParticipants.get(event.identity);
        const pub = p?.trackPublications.get(event.sid);
        if (pub === undefined) break;
        pub.isMuted = event.muted;
        if (event.muted) this.emit(RoomEvent.TrackMuted, pub, p);
        break;
      }
      case "permission":
        // The shape `publishAllowed` reads, as livekit-client keeps it.
        this.localParticipant.permissions = {
          canPublish: event.canPublish,
          canPublishSources: event.canPublishSources,
        };
        this.emit(RoomEvent.ParticipantPermissionsChanged, undefined, this.localParticipant);
        break;
      case "voiceGate":
        if (this.voiceThreshold > 0) this.onVoiceGate(event.open);
        break;
      case "inputLevel": {
        if (!this.capturing) break;
        this.onInputLevel?.(event.rms, event.open);
        const next = this.autoFloor?.push(event.rms, performance.now()) ?? null;
        if (next !== null) this.retuneVoiceGate(next);
        break;
      }
      case "activeSpeakers":
        this.emit(
          RoomEvent.ActiveSpeakersChanged,
          event.identities.map((identity) => ({ identity })),
        );
        break;
      case "screenCaptureEnded":
        this.endedCapture = event.capture;
        if (this.screen?.capture === event.capture) this.screen.end();
        break;
      case "cameraCaptureEnded":
        this.endedCamera = event.capture;
        if (this.camera?.capture === event.capture) this.camera.end();
        break;
      case "encryptionStatus":
        if (event.identity === this.localParticipant.identity) {
          // The backend's only signal that frames are not being protected —
          // surface it the way the web path surfaces a dead E2EE worker.
          if (!event.encrypted)
            // i18n-exempt: internal E2EE state guard, never rendered
            this.emit(RoomEvent.EncryptionError, new Error("native E2EE not active"));
          break;
        }
        // A remote peer's frames stopped (or resumed) decrypting.
        // The backend reports each transition once; re-report the failure the
        // way the web worker does (an InvalidKey decrypt error once a second)
        // until the peer decrypts again, so the shared streak grace degrades
        // a failure that persists and the quiet gap after `encrypted` clears
        // it. Tracked per identity, so a peer whose audio decrypts while its
        // camera does not reads as decrypting.
        this.clearDecryptTimer(event.identity);
        if (!event.encrypted) {
          const identity = event.identity;
          const report = (): void => {
            const p = this.remoteParticipants.get(identity);
            // i18n-exempt: the web worker's decrypt error, matched by prefix, never rendered
            const error = new Error("InvalidKey: native decrypt failure");
            if (p !== undefined) this.emit(RoomEvent.EncryptionError, error, p);
          };
          report();
          this.decryptTimers.set(identity, setInterval(report, DECRYPT_REPORT_MS));
        }
        break;
      case "reconnecting":
        this.state = "reconnecting";
        this.statsTick = null;
        this.emit(RoomEvent.Reconnecting);
        break;
      case "reconnected":
        this.state = "connected";
        this.emit(RoomEvent.Reconnected);
        break;
      case "disconnected":
        this.state = "disconnected";
        this.statsTick = null;
        this.clearDecryptTimers();
        this.emit(
          RoomEvent.Disconnected,
          event.reason === "ClientInitiated"
            ? DisconnectReason.CLIENT_INITIATED
            : DisconnectReason.UNKNOWN_REASON,
        );
        break;
    }
  }
}

function unsupported(what: string): Error {
  // i18n-exempt: internal Linux unsupported-path guard, caught and mapped by the caller
  return new Error(`${what} is not available on Linux yet`);
}

export function createNativeRoom(
  audio: NativeVoiceAudioOptions,
  volumeOf?: (identity: string) => number,
  screenshareVolumeOf?: (identity: string) => number,
): NativeRoom {
  return new NativeRoom(audio, volumeOf, screenshareVolumeOf);
}

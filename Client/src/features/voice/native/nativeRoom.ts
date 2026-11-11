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
//
// The remote roster, emitter and stats reply live in `nativeRoomRemote.ts` and
// the participant model in `nativeRoomModel.ts`; NativeRoom extends the former.
import { DisconnectReason, RoomEvent } from "livekit-client";
import { createLogger } from "../../../lib/logger";
import { NoiseFloorTracker } from "../../../lib/voice/noiseFloor";
import { desktop } from "../../../platform/desktop";
import type {
  NativeVoiceAudioOptions,
  NativeVoiceEnvelope,
  NativeVoiceEvent,
} from "../../../platform/contracts/nativeVoice";
import { nativeCounters } from "./counters";
import {
  NativeLocalVideo,
  unsupported,
  type NativeLocalPublication,
  type PublishOptions,
  type PublishableTrack,
} from "./nativeLocalVideo";
import { switchNativeDevice } from "./nativeDevice";
import { NativeStatsTransport } from "./nativeRoomModel";
import { NativeRoomRemote } from "./nativeRoomRemote";
import { NativeCameraTrack } from "./nativeCameraTrack";
import { NativeScreenAudioTrack } from "./screenAudioTrack";
import { NativeScreenTrack } from "./screenTrack";

const log = createLogger("nativeRoom");

export class NativeRoom extends NativeRoomRemote {
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
        if (this.voiceThreshold > 0) {
          await desktop.nativeVoice.setVoiceGate(this.sessionId, this.voiceThreshold, false, true);
        }
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
      await this.video.unpublishCamera();
    },
    /** Only the disable is reachable, as for the camera. */
    setScreenShareEnabled: async (enabled: boolean): Promise<void> => {
      if (enabled) throw unsupported("setScreenShareEnabled(true)");
      await this.video.unpublishScreen();
    },
    /** The native stand-in for `createLocalScreenTracks`: pick, then capture
     *  in the host. Resolves once the capture delivers its first frame. */
    createScreenTracks: () => this.video.createScreenTracks(),
    /** The native stand-in for `createLocalVideoTrack`: capture in the host.
     *  Resolves once the capture delivers its first frame. The camera is not
     *  published until `publishTrack`; capture keeps running while the window
     *  is hidden. */
    createCameraTracks: (options: PublishOptions) => this.video.createCameraTracks(options),
    publishTrack: (
      track: PublishableTrack | NativeCameraTrack | NativeScreenTrack | NativeScreenAudioTrack,
      options: PublishOptions,
    ) => {
      const source = options.source ?? (track as PublishableTrack).source;
      if (source === "screen_share_audio") return this.video.publishScreenAudio(track);
      return source === "screen_share"
        ? this.video.publishScreen(track, options)
        : this.video.publishCamera(track as NativeCameraTrack, options);
    },
    /** Takes the `mediaStreamTrack`, as the shared camera and screen-share
     *  paths pass it. `stopOnUnpublish` false (a codec republish) unpublishes
     *  only: the host capture and its preview keep running for the publish
     *  that follows. */
    unpublishTrack: async (track: MediaStreamTrack, stopOnUnpublish = true): Promise<void> => {
      const pubs = this.localParticipant.trackPublications;
      if (pubs.get("camera")?.track.mediaStreamTrack === track)
        await this.video.unpublishCamera(stopOnUnpublish);
      if (pubs.get("screen_share")?.track.mediaStreamTrack === track)
        await this.video.unpublishScreen(stopOnUnpublish);
      const audio = pubs.get("screen_share_audio");
      if (audio?.track instanceof NativeScreenAudioTrack && audio.track.mediaStreamTrack === track)
        await this.video.unpublishScreenAudio();
    },
  };

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
  /** Whether this room is counted in `nativeCounters.openRooms`. */
  private counted = false;
  /** Hold the published camera or share `track` under `maxBitrate` bits per
   *  second without republishing it (`NativeBitrateRoom`). Dropped when the
   *  track is not the live publication or the room has no session. */
  async setVideoBitrate(
    kind: "camera" | "screen",
    track: object,
    maxBitrate: number,
  ): Promise<void> {
    const session = this.sessionId;
    const pub = this.localParticipant.trackPublications.get(
      kind === "camera" ? "camera" : "screen_share",
    );
    if (session === null || pub?.track !== track) return;
    await desktop.nativeVoice.setVideoBitrate(session, kind, pub.trackSid, maxBitrate);
  }

  /** Releases this connect attempt's event subscription; null when none. */
  private unsubscribe: (() => void) | null = null;

  /** Events that arrived before connect() resolved with this room's id. */
  private pending: NativeVoiceEnvelope[] | null = null;
  /** The local camera and screen share: their host captures and publications. */
  private readonly video = new NativeLocalVideo({
    sessionId: () => this.sessionId,
    frames: () => this.frames,
    publications: this.localParticipant.trackPublications,
    readStats: () => this.readStats(),
  });

  /** `volumeOf` and `screenshareVolumeOf` are read by NativeRoomRemote. */
  constructor(
    private audio: NativeVoiceAudioOptions,
    volumeOf?: (identity: string) => number,
    screenshareVolumeOf?: (identity: string) => number,
  ) {
    super(volumeOf, screenshareVolumeOf);
  }

  // --- Emitter (the livekit Room surface roomLifecycle wires) ---

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
   *  at `auto.seed` and telling `auto.onThreshold` each step. The
   *  capture's gate also asks RNNoise's verdict at either threshold, as the
   *  web detector's speech gate does. */
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
      .setVoiceGate(this.sessionId, threshold, false, true)
      .catch((err) => log.warn("Voice sensitivity could not reach the native gate", err));
  }

  /** Automatic sensitivity moved: the gate takes the new level without
   *  restarting, as the web detector's worklet does. */
  private retuneVoiceGate(threshold: number): void {
    this.voiceThreshold = threshold;
    this.onAutoThreshold(threshold);
    if (this.sessionId === null) return;
    desktop.nativeVoice
      .setVoiceGate(this.sessionId, threshold, true, true)
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
    return switchNativeDevice(this.sessionId, kind, deviceId);
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

  /** Dispose every renderer and the local camera track without raising events:
   *  the session teardown that calls this clears the tiles itself. */
  protected releaseVideo(): void {
    for (const p of this.remoteParticipants.values())
      for (const pub of p.trackPublications.values()) {
        pub.track?.dispose();
        pub.track = undefined;
      }
    const camera = this.localParticipant.trackPublications.get("camera");
    this.localParticipant.trackPublications.delete("camera");
    // Stops the host camera capture; the session close releases it too.
    if (camera?.track instanceof NativeCameraTrack) camera.track.stop();
    this.video.release();
    this.localParticipant.trackPublications.delete("screen_share");
    this.localParticipant.trackPublications.delete("screen_share_audio");
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

  private apply(event: NativeVoiceEvent): void {
    if (!this.applyRosterEvent(event)) this.applySessionEvent(event);
  }

  /** The local session: permissions, the mic gate and level, speakers,
   *  captures ending, encryption and the connection state. */
  private applySessionEvent(event: NativeVoiceEvent): void {
    switch (event.type) {
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
      case "inputLevel":
        this.onCaptureLevel(event.rms, event.open);
        break;
      case "activeSpeakers":
        this.emit(
          RoomEvent.ActiveSpeakersChanged,
          event.identities.map((identity) => ({ identity })),
        );
        break;
      case "screenCaptureEnded":
        this.video.screenEnded(event.capture);
        break;
      case "cameraCaptureEnded":
        this.video.cameraEnded(event.capture);
        break;
      case "encryptionStatus":
        this.onEncryptionStatus(event.identity, event.encrypted);
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
        this.onDisconnected(event.reason);
        break;
      default:
        break;
    }
  }

  private onCaptureLevel(rms: number, open: boolean): void {
    if (!this.capturing) return;
    this.onInputLevel?.(rms, open);
    const next = this.autoFloor?.push(rms, performance.now()) ?? null;
    if (next !== null) this.retuneVoiceGate(next);
  }

  private onDisconnected(reason: string): void {
    this.state = "disconnected";
    this.statsTick = null;
    this.clearDecryptTimers();
    this.emit(
      RoomEvent.Disconnected,
      reason === "ClientInitiated"
        ? DisconnectReason.CLIENT_INITIATED
        : DisconnectReason.UNKNOWN_REASON,
    );
  }
}

export function createNativeRoom(
  audio: NativeVoiceAudioOptions,
  volumeOf?: (identity: string) => number,
  screenshareVolumeOf?: (identity: string) => number,
): NativeRoom {
  return new NativeRoom(audio, volumeOf, screenshareVolumeOf);
}

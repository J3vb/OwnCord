// NativeRoom — the Linux stand-in for livekit-client's `Room`.
//
// The voice state machine (joinOrchestration, roomLifecycle, mediaControl,
// roomEventHandlers, the reconnect loop) only ever touches a small slice of
// `Room`: connect/disconnect, the event emitter, `state`, the local
// participant's microphone toggle, and the remote participants' audio
// publications (deafen), the camera publish and the remote video tracks.
// This class implements exactly that slice over the Rust backend's commands
// and its single `native-voice` Tauri event, so the shared modules run
// unchanged on Linux. Media never crosses IPC: audio capture and playout
// happen in libwebrtc's audio device module in the Rust process, so no
// `TrackSubscribed` is raised for audio — there is no MediaStreamTrack to
// attach. Video does reach the webview, over the session's loopback frame
// socket: a subscribed remote video track is raised as `TrackSubscribed`
// with a `NativeVideoRenderer`'s canvas track as its `mediaStreamTrack`, and
// a published camera is the webview's own `LocalVideoTrack` (its preview)
// pumped up the socket by a `CameraUplink`. Screen share captures in the
// backend: `createScreenTracks` picks a source (`screenPicker.ts`; on
// Wayland the desktop portal's dialog) and starts the host capture, and the
// `NativeScreenTrack` it returns is the local preview.
//
// Lifecycle (B7-11): the Tauri subscription is registered per connect() and
// released in disconnect() with the late-resolve guard, and disconnect() is
// scoped to this room's own native session id, so a superseded attempt tears
// down only its own room. Every renderer, the camera pump and the screen
// track are disposed when their track goes away and, at the latest, in
// disconnect().
import { DisconnectReason, RoomEvent } from "livekit-client";
import { createLogger } from "../../../lib/logger";
import { voiceStore } from "../../../stores/voice.store";
import { desktop } from "../../../platform/desktop";
import type {
  NativeVoiceAudioOptions,
  NativeVoiceCameraOptions,
  NativeVoiceEnvelope,
  NativeVoiceEvent,
  NativeVoiceTrack,
} from "../../../platform/contracts/nativeVoice";
import { nativeCounters } from "./counters";
import { NativeVideoRenderer } from "./videoRenderer";
import { CameraUplink } from "./cameraUplink";
import {
  NativeScreenTrack,
  captureOptions,
  startError,
  type ScreenCaptureRequest,
} from "./screenTrack";
import { pickScreenSource } from "./screenPicker";

const log = createLogger("nativeRoom");

type Listener = (...args: unknown[]) => void;

// --- Participant model: the members audioElements/livekitDiagnostics read ---

/** A remote video track as the shared handlers read it: the renderer's
 *  canvas track stands in for the browser's decoded track. */
export class NativeRemoteVideoTrack {
  readonly kind = "video";
  constructor(
    readonly sid: string,
    readonly source: string,
    private readonly renderer: NativeVideoRenderer,
  ) {}
  get mediaStreamTrack(): MediaStreamTrack {
    return this.renderer.mediaStreamTrack;
  }
  /** The tiles own their elements; nothing is attached here. */
  detach(): HTMLMediaElement[] {
    return [];
  }
  dispose(): void {
    this.renderer.dispose();
  }
}

export class NativeRemotePublication {
  readonly trackSid: string;
  readonly kind: string;
  readonly source: string;
  isSubscribed = true;
  readonly isEnabled = true;
  isMuted: boolean;
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
  }
  setSubscribed(subscribed: boolean): void {
    if (this.isSubscribed === subscribed) return;
    this.isSubscribed = subscribed;
    this.room.setSubscribed(this.identity, this.trackSid, subscribed);
  }
}

export class NativeRemoteParticipant {
  readonly trackPublications = new Map<string, NativeRemotePublication>();
  constructor(readonly identity: string) {}
  get audioTrackPublications(): Map<string, NativeRemotePublication> {
    const audio = new Map<string, NativeRemotePublication>();
    for (const [sid, pub] of this.trackPublications) if (pub.kind === "audio") audio.set(sid, pub);
    return audio;
  }
  getTrackPublication(source: string): NativeRemotePublication | undefined {
    for (const pub of this.trackPublications.values()) if (pub.source === source) return pub;
    return undefined;
  }
  // ponytail: per-user volume is a later phase (the ADM mixes all remote tracks
  // with no per-track gain in the SDK); the store keeps the preference.
  getVolume(): number {
    return 1;
  }
  setVolume(_volume: number): void {}
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
  videoEncoding?: { maxBitrate: number; maxFramerate?: number };
}

/** A local camera or screen publication, as `getLocalCameraStream`,
 *  `getLocalScreenshareStream` and the diagnostics read it. */
interface NativeLocalPublication {
  readonly trackSid: string;
  readonly source: string;
  readonly kind: string;
  readonly isMuted: boolean;
  readonly track: PublishableTrack;
  /** The camera's frame pump; a screen share has none. */
  readonly uplink?: CameraUplink;
}

export class NativeRoom {
  state: "disconnected" | "connecting" | "connected" | "reconnecting" = "disconnected";
  readonly name = "";
  readonly canPlaybackAudio = true;
  /** connectionStats/connectionDiagnostics read `engine.pcManager`; native
   *  has no browser peer connection, so they see "no transports". */
  readonly engine = { pcManager: undefined, client: { ws: undefined } };
  readonly remoteParticipants = new Map<string, NativeRemoteParticipant>();
  readonly localParticipant = {
    identity: "",
    permissions: undefined,
    trackPublications: new Map<string, NativeLocalPublication>(),
    getTrackPublication: (source: string): NativeLocalPublication | undefined =>
      this.localParticipant.trackPublications.get(source),
    setMicrophoneEnabled: async (enabled: boolean): Promise<void> => {
      if (this.sessionId === null) throw new Error("native room is not connected");
      await desktop.nativeVoice.setMicrophone(this.sessionId, enabled);
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
    createScreenTracks: (options?: ScreenCaptureRequest) => this.createScreenTracks(options),
    publishTrack: (track: PublishableTrack, options: PublishOptions) =>
      (options.source ?? track.source) === "screen_share"
        ? this.publishScreen(track, options)
        : this.publishCamera(track, options),
    /** Takes the `mediaStreamTrack`, as the shared camera and screen-share
     *  paths pass it. */
    unpublishTrack: async (track: MediaStreamTrack): Promise<void> => {
      const pubs = this.localParticipant.trackPublications;
      if (pubs.get("camera")?.track.mediaStreamTrack === track) await this.unpublishCamera();
      if (pubs.get("screen_share")?.track.mediaStreamTrack === track) await this.unpublishScreen();
    },
  };

  private sessionId: number | null = null;
  /** The session's frame-socket base URL (token included); never logged. */
  private frames = "";
  /** Whether this room is counted in `nativeCounters.openRooms`. */
  private counted = false;
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Releases this connect attempt's event subscription; null when none. */
  private unsubscribe: (() => void) | null = null;
  /** Events that arrived before connect() resolved with this room's id. */
  private pending: NativeVoiceEnvelope[] | null = null;
  /** The live screen capture's track; null when not capturing. */
  private screen: NativeScreenTrack | null = null;
  /** The last capture the host ended, in case it ended before its track
   *  existed (the event and the start result travel separately). */
  private endedCapture: number | null = null;

  constructor(private readonly audio: NativeVoiceAudioOptions) {}

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
  /** Native playout needs no autoplay gesture. */
  startAudio(): Promise<void> {
    return Promise.resolve();
  }
  /** Same contract as livekit-client's: `deviceId` is one of the ids the
   *  device list reported (`listAudioDevices`), "" or "default" is the host
   *  default. Camera switching has no native counterpart yet. */
  async switchActiveDevice(kind: string, deviceId: string): Promise<boolean> {
    if (kind !== "audioinput" && kind !== "audiooutput") return false;
    if (this.sessionId === null) throw new Error("native room is not connected");
    await desktop.nativeVoice.setDevice(
      this.sessionId,
      kind,
      deviceId === "default" ? "" : deviceId,
    );
    return true;
  }

  async connect(url: string, token: string): Promise<void> {
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
  }

  async disconnect(): Promise<void> {
    const id = this.sessionId;
    this.releaseSubscription();
    this.pending = null;
    this.releaseVideo();
    if (id === null) return;
    this.sessionId = null;
    if (this.counted) nativeCounters.openRooms--;
    this.counted = false;
    this.state = "disconnected";
    // Scoped to this room's own session: the backend ignores a stale id.
    nativeCounters.rust = await desktop.nativeVoice.disconnect(id);
  }

  /** Publish the webview's camera track: the backend publishes a native
   *  source (E2EE like the microphone) that this pump feeds. */
  private async publishCamera(
    track: PublishableTrack,
    options: PublishOptions,
  ): Promise<NativeLocalPublication> {
    if (this.sessionId === null) throw new Error("native room is not connected");
    if (track.kind !== "video" || (options.source ?? track.source) !== "camera")
      throw unsupported(`publishing ${options.source ?? track.source}`);
    const encoding = options.videoEncoding;
    if (encoding?.maxFramerate === undefined)
      throw new Error("native camera publish needs videoEncoding.maxBitrate and maxFramerate");
    const session = this.sessionId;
    const settings = track.mediaStreamTrack.getSettings();
    const camera: NativeVoiceCameraOptions = {
      width: settings.width ?? 1280,
      height: settings.height ?? 720,
      maxBitrate: encoding.maxBitrate,
      maxFramerate: encoding.maxFramerate,
      simulcast: options.simulcast ?? false,
    };
    await this.unpublishCamera();
    const sid = await desktop.nativeVoice.publishCamera(session, camera);
    if (this.sessionId !== session) {
      // Disconnected meanwhile: the session (and its publish) is gone.
      throw new Error("native room disconnected during camera publish");
    }
    this.localParticipant.trackPublications.get("camera")?.uplink?.dispose();
    const publication: NativeLocalPublication = {
      trackSid: sid,
      source: "camera",
      kind: "video",
      isMuted: false,
      track,
      uplink: new CameraUplink(
        `${this.frames}/camera`,
        track.mediaStreamTrack,
        camera.maxFramerate,
      ),
    };
    this.localParticipant.trackPublications.set("camera", publication);
    return publication;
  }

  private async unpublishCamera(): Promise<void> {
    const camera = this.localParticipant.trackPublications.get("camera");
    if (camera === undefined) return;
    this.localParticipant.trackPublications.delete("camera");
    camera.uplink?.dispose();
    if (this.sessionId !== null)
      await desktop.nativeVoice.unpublishCamera(this.sessionId, camera.trackSid);
  }

  private async createScreenTracks(options?: ScreenCaptureRequest): Promise<NativeScreenTrack[]> {
    if (this.sessionId === null) throw new Error("native room is not connected");
    const session = this.sessionId;
    const source = await pickScreenSource();
    if (source === null) throw new DOMException("Screen share cancelled", "NotAllowedError");
    if (this.sessionId !== session) throw new Error("native room disconnected during screen pick");
    const started = await desktop.nativeVoice
      .startScreen(session, source, captureOptions(options))
      .catch((err: unknown) => {
        throw startError(err);
      });
    if (this.sessionId !== session) {
      // Disconnected meanwhile: the session (and its capture) is gone.
      throw new Error("native room disconnected during screen capture");
    }
    const track = new NativeScreenTrack(started, `${this.frames}/screen`, (t) =>
      this.stopScreen(session, t),
    );
    this.screen?.stop();
    this.screen = track;
    if (this.endedCapture === track.capture) track.end();
    return [track];
  }

  /** A stopped screen track: stop its host capture (a no-op for a capture a
   *  newer one replaced) and forget its publication. */
  private stopScreen(session: number, track: NativeScreenTrack): void {
    if (this.screen === track) this.screen = null;
    const pubs = this.localParticipant.trackPublications;
    if (pubs.get("screen_share")?.track === track) pubs.delete("screen_share");
    if (this.sessionId !== session) return;
    desktop.nativeVoice
      .stopScreen(session, track.capture)
      .catch((err) => log.warn("native stopScreen failed", { capture: track.capture, err }));
  }

  private async publishScreen(
    track: PublishableTrack,
    options: PublishOptions,
  ): Promise<NativeLocalPublication> {
    if (this.sessionId === null) throw new Error("native room is not connected");
    if (!(track instanceof NativeScreenTrack))
      throw unsupported("publishing a browser screen track");
    const encoding = options.videoEncoding;
    if (encoding?.maxFramerate === undefined)
      throw new Error("native screen publish needs videoEncoding.maxBitrate and maxFramerate");
    const session = this.sessionId;
    const sid = await desktop.nativeVoice.publishScreen(session, track.capture, {
      width: track.width,
      height: track.height,
      maxBitrate: encoding.maxBitrate,
      maxFramerate: encoding.maxFramerate,
    });
    if (this.sessionId !== session)
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

  /** Unpublishing a screen share stops its track, and with it the host
   *  capture (which unpublishes): the shared code stops the track next
   *  anyway, and stop() is idempotent. */
  private async unpublishScreen(): Promise<void> {
    const screen = this.localParticipant.trackPublications.get("screen_share");
    if (screen === undefined) return;
    this.localParticipant.trackPublications.delete("screen_share");
    if (screen.track instanceof NativeScreenTrack) screen.track.stop();
  }

  /** Dispose every renderer and the camera pump without raising events: the
   *  session teardown that calls this clears the tiles itself. */
  private releaseVideo(): void {
    for (const p of this.remoteParticipants.values())
      for (const pub of p.trackPublications.values()) {
        pub.track?.dispose();
        pub.track = undefined;
      }
    const camera = this.localParticipant.trackPublications.get("camera");
    this.localParticipant.trackPublications.delete("camera");
    camera?.uplink?.dispose();
    // The session close releases the host capture; this is the preview.
    this.screen?.stop();
    this.screen = null;
    this.endedCapture = null;
    this.localParticipant.trackPublications.delete("screen_share");
  }

  /** A subscribed remote video track: open its renderer and raise it the way
   *  livekit-client does. A resubscribe replaces the old renderer. */
  private subscribeVideo(identity: string, pub: NativeRemotePublication): void {
    this.unsubscribeVideo(identity, pub);
    const renderer = new NativeVideoRenderer(`${this.frames}/remote/${pub.trackSid}`);
    pub.track = new NativeRemoteVideoTrack(pub.trackSid, pub.source, renderer);
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
    if (p === undefined)
      this.remoteParticipants.set(identity, (p = new NativeRemoteParticipant(identity)));
    return p;
  }

  /** The backend auto-subscribes every track, so a voice track that appears
   *  while deafened is unsubscribed here — the native counterpart of
   *  AudioElements.handleTrackSubscribedAudio's guard, which never runs on
   *  Linux because no TrackSubscribed is raised. Stream audio is exempt. */
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
  }

  private apply(event: NativeVoiceEvent): void {
    switch (event.type) {
      case "connected":
        this.releaseVideo();
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
        for (const pub of p?.trackPublications.values() ?? [])
          this.unsubscribeVideo(event.identity, pub);
        this.remoteParticipants.delete(event.identity);
        if (p !== undefined) this.emit(RoomEvent.ParticipantDisconnected, p);
        break;
      }
      case "trackPublished":
        this.addPublication(event.identity, event.track);
        break;
      case "trackSubscribed": {
        this.addPublication(event.identity, event.track);
        const pub = this.participant(event.identity).trackPublications.get(event.track.sid)!;
        if (pub.kind === "video") this.subscribeVideo(event.identity, pub);
        break;
      }
      case "trackUnpublished": {
        const pubs = this.remoteParticipants.get(event.identity)?.trackPublications;
        this.unsubscribeVideo(event.identity, pubs?.get(event.sid));
        pubs?.delete(event.sid);
        break;
      }
      case "trackUnsubscribed":
        this.unsubscribeVideo(
          event.identity,
          this.remoteParticipants.get(event.identity)?.trackPublications.get(event.sid),
        );
        break;
      case "trackMuted": {
        const pub = this.remoteParticipants.get(event.identity)?.trackPublications.get(event.sid);
        if (pub !== undefined) pub.isMuted = event.muted;
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
      case "encryptionStatus":
        // The backend's only signal that frames are not being protected —
        // surface it the way the web path surfaces a dead E2EE worker.
        if (!event.encrypted && event.identity === this.localParticipant.identity)
          this.emit(RoomEvent.EncryptionError, new Error("native E2EE not active"));
        break;
      case "reconnecting":
        this.state = "reconnecting";
        this.emit(RoomEvent.Reconnecting);
        break;
      case "reconnected":
        this.state = "connected";
        this.emit(RoomEvent.Reconnected);
        break;
      case "disconnected":
        this.state = "disconnected";
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
  return new Error(`${what} is not available on Linux yet`);
}

export function createNativeRoom(audio: NativeVoiceAudioOptions): NativeRoom {
  return new NativeRoom(audio);
}

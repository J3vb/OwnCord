// NativeRoom — the Linux stand-in for livekit-client's `Room`.
//
// The voice state machine (joinOrchestration, roomLifecycle, mediaControl,
// roomEventHandlers, the reconnect loop) only ever touches a small slice of
// `Room`: connect/disconnect, the event emitter, `state`, the local
// participant's microphone toggle, and the remote participants' audio
// publications (deafen). This class implements exactly that slice over the
// Rust backend's commands and its single `native-voice` Tauri event, so the
// shared modules run unchanged on Linux. Media never crosses IPC: capture and
// playout happen in libwebrtc's audio device module in the Rust process,
// which is why no `TrackSubscribed` event is raised here — there is no
// MediaStreamTrack to attach.
//
// Lifecycle (B7-11): the Tauri subscription is registered per connect() and
// released in disconnect() with the late-resolve guard, and disconnect() is
// scoped to this room's own native session id, so a superseded attempt tears
// down only its own room.
import { DisconnectReason, RoomEvent } from "livekit-client";
import { createLogger } from "../../../lib/logger";
import { desktop } from "../../../platform/desktop";
import type {
  NativeVoiceAudioOptions,
  NativeVoiceEnvelope,
  NativeVoiceEvent,
  NativeVoiceTrack,
} from "../../../platform/contracts/nativeVoice";
import { nativeCounters } from "./counters";

const log = createLogger("nativeRoom");

type Listener = (...args: unknown[]) => void;

// --- Participant model: the members audioElements/livekitDiagnostics read ---

export class NativeRemotePublication {
  readonly trackSid: string;
  readonly kind: string;
  readonly source: string;
  isSubscribed = true;
  readonly isEnabled = true;
  isMuted: boolean;
  /** No browser track exists: playout is native. */
  readonly track = undefined;
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
  // ponytail: per-user volume is phase 1b (the ADM mixes all remote tracks
  // with no per-track gain in the SDK); the store keeps the preference.
  getVolume(): number {
    return 1;
  }
  setVolume(_volume: number): void {}
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
    trackPublications: new Map<string, never>(),
    getTrackPublication: (): undefined => undefined,
    setMicrophoneEnabled: async (enabled: boolean): Promise<void> => {
      if (this.sessionId === null) throw new Error("native room is not connected");
      await desktop.nativeVoice.setMicrophone(this.sessionId, enabled);
      this.micPublished = enabled;
    },
    setCameraEnabled: (): Promise<void> => Promise.reject(unsupported("camera")),
    publishTrack: (): Promise<void> => Promise.reject(unsupported("video publish")),
    unpublishTrack: (): Promise<void> => Promise.resolve(),
  };

  private sessionId: number | null = null;
  private micPublished = false;
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Releases this connect attempt's event subscription; null when none. */
  private unsubscribe: (() => void) | null = null;
  /** Events that arrived before connect() resolved with this room's id. */
  private pending: NativeVoiceEnvelope[] | null = null;

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
  // ponytail: device selection is phase 1b — saved-device switches at join
  // resolve as no-ops so the join proceeds on the system default.
  switchActiveDevice(kind: string, deviceId: string): Promise<boolean> {
    log.debug("switchActiveDevice ignored on the native backend (phase 1b)", { kind, deviceId });
    return Promise.resolve(true);
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
    } catch (err) {
      this.state = "disconnected";
      this.pending = null;
      this.releaseSubscription();
      throw err;
    }
    this.state = "connected";
    nativeCounters.openRooms++;
    const queued = this.pending;
    this.pending = null;
    for (const envelope of queued ?? []) this.onEnvelope(envelope);
  }

  async disconnect(): Promise<void> {
    const id = this.sessionId;
    this.releaseSubscription();
    this.pending = null;
    if (id === null) return;
    this.sessionId = null;
    this.micPublished = false;
    if (this.state !== "disconnected") nativeCounters.openRooms--;
    this.state = "disconnected";
    // Scoped to this room's own session: the backend ignores a stale id.
    nativeCounters.rust = await desktop.nativeVoice.disconnect(id);
  }

  /** Deafen: forwarded from the publication model. */
  setSubscribed(identity: string, sid: string, subscribed: boolean): void {
    if (this.sessionId === null) return;
    desktop.nativeVoice
      .setSubscribed(this.sessionId, identity, sid, subscribed)
      .catch((err) => log.warn("native setSubscribed failed", { identity, sid, subscribed, err }));
  }

  /** For the facade's debug surface. */
  get isMicrophonePublished(): boolean {
    return this.micPublished;
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

  private apply(event: NativeVoiceEvent): void {
    switch (event.type) {
      case "connected":
        this.remoteParticipants.clear();
        for (const info of event.participants) {
          const p = this.participant(info.identity);
          for (const t of info.tracks)
            p.trackPublications.set(t.sid, new NativeRemotePublication(this, info.identity, t));
        }
        this.emit(RoomEvent.Connected);
        break;
      case "participantConnected":
        this.emit(RoomEvent.ParticipantConnected, this.participant(event.identity));
        break;
      case "participantDisconnected": {
        const p = this.remoteParticipants.get(event.identity);
        this.remoteParticipants.delete(event.identity);
        if (p !== undefined) this.emit(RoomEvent.ParticipantDisconnected, p);
        break;
      }
      case "trackPublished":
      case "trackSubscribed": {
        const p = this.participant(event.identity);
        if (!p.trackPublications.has(event.track.sid))
          p.trackPublications.set(
            event.track.sid,
            new NativeRemotePublication(this, event.identity, event.track),
          );
        break;
      }
      case "trackUnpublished":
        this.remoteParticipants.get(event.identity)?.trackPublications.delete(event.sid);
        break;
      case "trackUnsubscribed":
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

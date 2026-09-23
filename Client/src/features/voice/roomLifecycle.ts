// Voice room lifecycle — extracted from livekitSession.ts.
// Owns building a Room (E2EE worker, room options, event wiring), pointing the
// extracted media modules at a room, and the full leave teardown. The session
// state and every collaborator stay owned by LiveKitSession; this module
// reaches them only through RoomLifecycleHost, and receives the room event
// handlers from it rather than importing the facade.
import { Room, RoomEvent } from "livekit-client";
import type { WsClient } from "../../lib/ws";
import { setLocalCamera, setLocalScreenshare, setVoiceStatus } from "../../stores/voice.store";
import { loadPref } from "../../components/settings/helpers";
import { createLogger } from "../../lib/logger";
import type { AudioPipeline } from "../../lib/audioPipeline";
import type { AudioElements } from "../../lib/audioElements";
import { type DeviceManager, isMicPolicyGated } from "../../lib/deviceManager";
import type { E2EEManager } from "../../lib/livekitE2EE";
import type { VoiceTokenManager } from "../../lib/voiceTokenManager";
import {
  type CameraTrackState,
  type ScreenTrackState,
  CAMERA_PRESETS,
  CAMERA_PUBLISH_BITRATES,
  getStreamQuality,
  getScreenShareFps,
  getEffectiveScreenShareFps,
  getScreenShareMaxBitrate,
  stopManualCameraTrack,
  stopManualScreenTracks,
  bumpGeneration,
} from "../../lib/screenShare";
import { attachDiagnosticListeners } from "../../lib/livekitDiagnostics";
import type { RoomEventHandlers } from "../../lib/roomEventHandlers";
import { parseUserId, type SessionState } from "./sessionState";
import { isLinuxDesktop } from "./native/platform";

// Same logger tag as before the extraction, so the lifecycle log lines are unchanged.
const log = createLogger("livekitSession");

/** Everything the room lifecycle needs from LiveKitSession. Collaborators are
 *  read through getters on every use, never captured, so the session stays the
 *  single owner of each one. */
export interface RoomLifecycleHost {
  getState(): SessionState;
  setState(next: SessionState): void;
  getRoom(): Room | null;
  getWs(): WsClient | null;
  getOnError(): ((message: string) => void) | null;
  getE2EE(): Pick<E2EEManager, "keyProvider" | "clearState">;
  getEventHandlers(): RoomEventHandlers;
  getAudioPipeline(): AudioPipeline;
  getAudioElements(): AudioElements;
  getDeviceManager(): DeviceManager;
  getTokenManager(): Pick<VoiceTokenManager, "resetBudget">;
  getCameraState(): CameraTrackState;
  getScreenState(): ScreenTrackState;
  getPendingMicrophoneRoom(): Room | null;
  setPendingMicrophoneRoom(room: Room | null): void;
  clearPendingReconnectFields(): void;
  clearTokenRefreshTimer(): void;
  configuredAudioOptions(
    channelId: number | null,
  ): { audioPreset: { maxBitrate: number } } | undefined;
  microphonePublishingAllowed(room: Room): boolean;
  applyMicMuteState(muted: boolean): Promise<void>;
}

export class RoomLifecycle {
  constructor(private readonly host: RoomLifecycleHost) {}

  // --- Host views, named as the pre-extraction fields so the bodies read the same ---

  private get _room(): Room | null {
    return this.host.getRoom();
  }
  private get _reconnectAc(): AbortController | null {
    const s = this.host.getState();
    return s.type === "reconnecting" ? s.ac : null;
  }
  private get ws(): WsClient | null {
    return this.host.getWs();
  }
  private get onErrorCallback(): ((message: string) => void) | null {
    return this.host.getOnError();
  }
  private get _e2ee(): Pick<E2EEManager, "keyProvider" | "clearState"> {
    return this.host.getE2EE();
  }
  private get _eventHandlers(): RoomEventHandlers {
    return this.host.getEventHandlers();
  }
  private get _audioPipeline(): AudioPipeline {
    return this.host.getAudioPipeline();
  }
  private get _audioElements(): AudioElements {
    return this.host.getAudioElements();
  }
  private get _deviceManager(): DeviceManager {
    return this.host.getDeviceManager();
  }
  private get _tokenManager(): Pick<VoiceTokenManager, "resetBudget"> {
    return this.host.getTokenManager();
  }
  private get _cameraState(): CameraTrackState {
    return this.host.getCameraState();
  }
  private get _screenState(): ScreenTrackState {
    return this.host.getScreenState();
  }
  private get pendingMicrophoneRoom(): Room | null {
    return this.host.getPendingMicrophoneRoom();
  }
  private set pendingMicrophoneRoom(room: Room | null) {
    this.host.setPendingMicrophoneRoom(room);
  }
  private setState(next: SessionState): void {
    this.host.setState(next);
  }
  private clearTokenRefreshTimer(): void {
    this.host.clearTokenRefreshTimer();
  }
  private configuredAudioOptions(
    channelId: number | null,
  ): { audioPreset: { maxBitrate: number } } | undefined {
    return this.host.configuredAudioOptions(channelId);
  }
  private microphonePublishingAllowed(room: Room): boolean {
    return this.host.microphonePublishingAllowed(room);
  }
  private applyMicMuteState(muted: boolean): Promise<void> {
    return this.host.applyMicMuteState(muted);
  }

  // --- Room factory ---

  /** The current room's E2EE worker. livekit never terminates it, so the
   *  session must — a leaked worker keeps receiving every future room key
   *  through the process-lifetime key provider's setKey fan-out. */
  private _e2eeWorker: Worker | null = null;

  async createRoom(channelId?: number): Promise<Room> {
    if (isLinuxDesktop()) return this.createNativeRoom();
    // livekit's per-room E2EEManager registers a SetKey listener on the
    // shared key provider and never removes it; only those managers
    // subscribe, so clear them all before the new Room re-registers.
    this._e2ee.keyProvider.removeAllListeners();
    this._e2eeWorker?.terminate();
    this._e2eeWorker = new Worker(new URL("livekit-client/e2ee-worker", import.meta.url));
    const quality = getStreamQuality();
    const isSource = quality === "source";
    // OC-0438: publish with the channel's configured audio bitrate — spreading
    // undefined omits audioPreset, leaving LiveKit's own default in place.
    const audioOptions = this.configuredAudioOptions(channelId ?? null);
    const newRoom = new Room({
      // Adaptive features reduce quality based on subscriber viewport —
      // disable for "source" quality to maintain full resolution.
      adaptiveStream: !isSource,
      dynacast: !isSource,
      audioCaptureDefaults: {
        echoCancellation: loadPref("echoCancellation", true),
        noiseSuppression: loadPref("noiseSuppression", true),
        autoGainControl: loadPref("autoGainControl", true),
      },
      videoCaptureDefaults: CAMERA_PRESETS[quality],
      publishDefaults: {
        videoEncoding: {
          maxBitrate: CAMERA_PUBLISH_BITRATES[quality],
          maxFramerate: quality === "low" ? 15 : 30,
        },
        // Fallback for setScreenShareEnabled paths — the manual publish in
        // screenShare.ts passes explicit per-track encoding that overrides this.
        screenShareEncoding: {
          maxBitrate: getScreenShareMaxBitrate(quality, getScreenShareFps()),
          maxFramerate: getEffectiveScreenShareFps(quality, getScreenShareFps()),
        },
        // Mute must stop the OS capture, not merely mute the publication:
        // otherwise the microphone stays open and the OS in-use indicator
        // stays lit for as long as the client is muted. LiveKit honours this
        // key only through TrackPublishDefaults — a top-level RoomOptions key
        // is silently ignored — and reading it off publishDefaults is what
        // makes it reach every publish path, including the deviceManager ones
        // that call setMicrophoneEnabled with no options at all.
        stopMicTrackOnMute: true,
        ...audioOptions,
      },
      // End-to-end encryption: SFrame-based E2EE using a server-distributed
      // per-channel symmetric key. The SFU only sees encrypted frames.
      e2ee: {
        keyProvider: this._e2ee.keyProvider,
        worker: this._e2eeWorker,
      },
    });
    // OC-0095: the Room constructor only wires up the E2EEManager — it never
    // enables encryption. Without this, LocalParticipant.encryptionType stays
    // NONE, the worker's encode transform takes the disabled passthrough
    // branch, and every frame reaches the SFU in plaintext even though the
    // full ECDH/HKDF/AES-GCM key exchange above completed successfully.
    // Safe to call before connect(): the manager just records the enabled
    // flag and it's a no-op today for the "" pre-connect identity, then wires
    // up for real once the SignalConnected handler has the real identity.
    await newRoom.setE2EEEnabled(true);
    this.wireRoomEvents(newRoom);
    return newRoom;
  }

  /** Linux: the Room is the Rust backend's (`src-tauri/src/native_voice/`),
   *  driven through the NativeRoom adapter, which implements the slice of
   *  `Room` the voice modules use. Loaded on demand so the native backend
   *  never lands in the voice chunk on other platforms. The room key was
   *  installed by the E2EE worker before this room connects, and the same
   *  event wiring applies. */
  private async createNativeRoom(): Promise<Room> {
    const { createNativeRoom } = await import("./native/nativeRoom");
    const nativeRoom = createNativeRoom(
      {
        echoCancellation: loadPref("echoCancellation", true),
        noiseSuppression: loadPref("noiseSuppression", true),
        autoGainControl: loadPref("autoGainControl", true),
        enhancedNoiseSuppression: loadPref("enhancedNoiseSuppression", false),
      },
      (identity) => this._audioElements.getEffectiveVolume(parseUserId(identity)),
      (identity) => this._audioElements.getScreenshareGain(parseUserId(identity)),
    );
    this._audioElements.setScreenshareGainListener(() => nativeRoom.applyScreenshareVolumes());
    // The adapter is structurally the subset of Room the modules call; the
    // cast is the one seam where the two backends meet.
    const newRoom = nativeRoom as unknown as Room;
    this.wireRoomEvents(newRoom);
    return newRoom;
  }

  private wireRoomEvents(newRoom: Room): void {
    newRoom.on(RoomEvent.TrackSubscribed, this._eventHandlers.handleTrackSubscribed);
    newRoom.on(RoomEvent.TrackUnsubscribed, this._eventHandlers.handleTrackUnsubscribed);
    newRoom.on(RoomEvent.Disconnected, this._eventHandlers.handleDisconnected);
    newRoom.on(RoomEvent.ActiveSpeakersChanged, this._eventHandlers.handleActiveSpeakersChanged);
    newRoom.on(
      RoomEvent.AudioPlaybackStatusChanged,
      this._eventHandlers.handleAudioPlaybackChanged,
    );
    newRoom.on(RoomEvent.LocalTrackPublished, this._eventHandlers.handleLocalTrackPublished);
    newRoom.on(RoomEvent.ParticipantPermissionsChanged, (_previous, participant) => {
      if (
        participant !== newRoom.localParticipant ||
        this._room !== newRoom ||
        this.pendingMicrophoneRoom !== newRoom ||
        !this.microphonePublishingAllowed(newRoom)
      )
        return;
      this.pendingMicrophoneRoom = null;
      if (isMicPolicyGated()) return;
      this.applyMicMuteState(false).catch((err) => log.warn("Mic grant restoration failed", err));
    });
    // OC-0002: the only SDK-level signal that the E2EE worker died after the
    // key exchange already succeeded — see roomEventHandlers.ts for detail.
    newRoom.on(RoomEvent.EncryptionError, this._eventHandlers.handleEncryptionError);
    attachDiagnosticListeners(newRoom);
  }

  // --- Module wiring helper ---

  /** Update all extracted modules with a room reference.
   *
   *  Defaults to the room in the CURRENT shared state. Pass `room` explicitly
   *  from mid-attempt code (the reconnect loop), where the state is still
   *  "reconnecting" and therefore room-less — the default would wire every
   *  module to null. Either way the DeviceManager callbacks are re-installed
   *  here, so there is exactly one place that knows the full wiring. */
  syncModuleRooms(room: Room | null = this._room): void {
    this._audioPipeline.setRoom(room);
    this._audioElements.setRoom(room);
    this._deviceManager.setRoom(room);
    this._deviceManager.setAudioPipeline(room !== null ? this._audioPipeline : null);
    this._deviceManager.setOnError(this.onErrorCallback);
    this._deviceManager.setOnToast(this.onErrorCallback);
  }

  leaveVoice(sendWs = true): void {
    this.pendingMicrophoneRoom = null;
    // Cancel any pending auto-reconnect loop first.
    const ac = this._reconnectAc;
    if (ac !== null) {
      ac.abort();
    }
    this.host.clearPendingReconnectFields();
    this.clearTokenRefreshTimer();
    // OC-0029: a fresh join must never inherit the outgoing session's refresh
    // budget — otherwise a rejoin shortly after a leave could get silently
    // throttled for up to 60s with no refresh sent at all.
    this._tokenManager.resetBudget();
    this._audioPipeline.teardownAudioPipeline();
    this._eventHandlers.removeAutoplayUnlock();
    // OC-0042: bump first, mirroring doDisableCamera/doDisableScreenshare —
    // a concurrent enableCamera()/enableScreenshare() still awaiting device
    // acquisition (getUserMedia/getDisplayMedia/publishTrack) when the user
    // leaves voice must detect it was superseded and discard its track
    // instead of publishing onto the room this leave already disconnected.
    bumpGeneration(this._cameraState);
    bumpGeneration(this._screenState);
    // Clean up manually published tracks.
    stopManualCameraTrack(this._cameraState, this._room);
    stopManualScreenTracks(this._screenState, this._room);
    if (sendWs && this.ws !== null) {
      this.ws.send({ type: "voice_leave", payload: {} });
    }
    // Remove orphaned remote audio elements (normally cleaned up by
    // TrackUnsubscribed, but may be missed during rapid reconnection).
    // Full cleanup: also clears screenshare mute state on intentional leave.
    this._audioElements.cleanupAllAudioElementsFull();
    this._audioElements.setScreenshareGainListener(null);
    const room = this._room;
    if (room !== null) {
      room.removeAllListeners();
      room.disconnect().catch((err) => log.warn("room.disconnect() error (non-fatal)", err));
    }
    // Clear client-side E2EE state (ECDH keypair, room key, peer keys), and
    // kill the E2EE worker so the last room key does not stay resident in it.
    this._e2ee.clearState();
    this._e2eeWorker?.terminate();
    this._e2eeWorker = null;
    // Transition to idle — atomically clears room, channelId, tokens, reconnectAc,
    // pendingJoin, and the joinGeneration (idle has none). Any in-flight
    // connectAndSetup() will detect the state type change at its next checkpoint.
    this.setState({ type: "idle" });
    setVoiceStatus("idle");
    this.syncModuleRooms();
    setLocalCamera(false);
    setLocalScreenshare(false);
    log.info("Left voice session");
  }
}

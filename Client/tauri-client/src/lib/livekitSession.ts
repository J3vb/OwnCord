// =============================================================================
// LiveKit Session — lifecycle orchestrator for voice chat via LiveKit
//
// Replaces the old WebRTC-based voiceSession.ts. Manages LiveKit Room
// connection, mic publishing (with optional RNNoise pre-processing),
// remote track playback, and camera/screenshare.
// =============================================================================

import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  DisconnectReason,
} from "livekit-client";
import type { WsClient } from "@lib/ws";
import {
  voiceStore,
  setLocalMuted,
  setLocalDeafened,
  setLocalCamera,
  setSpeakers,
} from "@stores/voice.store";
import { loadPref, savePref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import { createNoiseSuppressor } from "@lib/noise-suppression";
import type { NoiseSuppressor } from "@lib/noise-suppression";

const log = createLogger("livekitSession");

// ---------------------------------------------------------------------------
// Module-level state (singleton)
// ---------------------------------------------------------------------------

let room: Room | null = null;
let ws: WsClient | null = null;
let noiseSuppressor: NoiseSuppressor | null = null;
let onErrorCallback: ((message: string) => void) | null = null;
let currentChannelId: number | null = null;
/** Server host (e.g. "192.168.0.247:8443") for constructing LiveKit proxy URL. */
let serverHost: string | null = null;

// Speaking detection via audioLevel polling
let speakingPollInterval: ReturnType<typeof setInterval> | null = null;
/** Cached sensitivity threshold (0.0-0.15). Updated by setVoiceSensitivity. */
let speakingThreshold = ((100 - 50) / 100) * 0.15; // default: sensitivity 50

/** The raw mic stream acquired for RNNoise processing (must be stopped on cleanup). */
let rawMicStream: MediaStream | null = null;

// Remote audio playback
const audioElements = new Map<string, HTMLAudioElement>();
let audioContainer: HTMLDivElement | null = null;

// Remote video callbacks
type RemoteVideoCallback = (userId: number, stream: MediaStream) => void;
type RemoteVideoRemovedCallback = (userId: number) => void;
let onRemoteVideoCallback: RemoteVideoCallback | null = null;
let onRemoteVideoRemovedCallback: RemoteVideoRemovedCallback | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse userId from LiveKit participant identity "user-{id}". Returns 0 if unparseable. */
function parseUserId(identity: string): number {
  const match = identity.match(/^user-(\d+)$/);
  if (match !== null && match[1] !== undefined) {
    return parseInt(match[1], 10);
  }
  return 0;
}

/** Get or create the hidden container for remote audio elements. */
function getOrCreateAudioContainer(): HTMLDivElement {
  if (audioContainer !== null) return audioContainer;

  const existing = document.getElementById("voice-audio-container");
  if (existing instanceof HTMLDivElement) {
    audioContainer = existing;
    return audioContainer;
  }

  const div = document.createElement("div");
  div.id = "voice-audio-container";
  div.style.display = "none";
  document.body.appendChild(div);
  audioContainer = div;
  return audioContainer;
}

/** Get saved per-user volume (0-200 range, default 100). */
function getSavedUserVolume(userId: number): number {
  return loadPref<number>(`userVolume_${userId}`, 100);
}

/** Clean up all remote audio elements. */
function cleanupAudioElements(): void {
  for (const el of audioElements.values()) {
    el.srcObject = null;
    el.remove();
  }
  audioElements.clear();
}

// ---------------------------------------------------------------------------
// RNNoise integration
// ---------------------------------------------------------------------------

/** Acquire mic, run through RNNoise, and publish the processed track to LiveKit. */
async function publishWithNoiseSuppression(): Promise<void> {
  if (room === null) return;

  const savedDevice = loadPref<string>("audioInputDevice", "");
  const constraints: MediaStreamConstraints = {
    audio: {
      deviceId: savedDevice ? { exact: savedDevice } : undefined,
      echoCancellation: loadPref("echoCancellation", true),
      noiseSuppression: loadPref("noiseSuppression", true),
      autoGainControl: loadPref("autoGainControl", true),
    },
    video: false,
  };
  const rawStream = await navigator.mediaDevices.getUserMedia(constraints);
  rawMicStream = rawStream;
  noiseSuppressor = createNoiseSuppressor();
  const processedStream = await noiseSuppressor.process(rawStream);
  const processedTrack = processedStream.getAudioTracks()[0];
  if (processedTrack) {
    await room.localParticipant.publishTrack(processedTrack, {
      source: Track.Source.Microphone,
    });
  }
}

// ---------------------------------------------------------------------------
// Room event handlers
// ---------------------------------------------------------------------------

function handleTrackSubscribed(
  track: RemoteTrack,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant,
): void {
  const userId = parseUserId(participant.identity);

  if (track.kind === Track.Kind.Audio) {
    // Attach audio track to a hidden <audio> element for playback
    const container = getOrCreateAudioContainer();
    const audioEl = track.attach();

    // Apply saved per-user volume
    const savedVolume = userId > 0 ? getSavedUserVolume(userId) : 100;
    audioEl.volume = Math.min(savedVolume, 100) / 100;

    // Respect current deafen state
    if (voiceStore.getState().localDeafened) {
      audioEl.muted = true;
    }

    // Apply saved output device
    const savedOutput = loadPref<string>("audioOutputDevice", "");
    if (savedOutput !== "" && typeof audioEl.setSinkId === "function") {
      audioEl.setSinkId(savedOutput).catch((err) => {
        log.warn("Failed to set output device on remote audio", err);
      });
    }

    container.appendChild(audioEl);
    const trackKey = `${participant.identity}-${track.sid}`;
    audioElements.set(trackKey, audioEl);
    // Create analyser for remote speaking detection
    if (userId > 0) {
      addRemoteAnalyser(userId, track.mediaStreamTrack);
    }
    log.debug("Remote audio track subscribed", { userId, trackSid: track.sid });
  } else if (track.kind === Track.Kind.Video) {
    if (userId > 0 && onRemoteVideoCallback !== null) {
      // Create a MediaStream from the video track for the VideoGrid
      const mediaTrack = track.mediaStreamTrack;
      const stream = new MediaStream([mediaTrack]);
      onRemoteVideoCallback(userId, stream);
    }
    log.debug("Remote video track subscribed", { userId, trackSid: track.sid });
  }
}

function handleTrackUnsubscribed(
  track: RemoteTrack,
  _publication: RemoteTrackPublication,
  participant: RemoteParticipant,
): void {
  const userId = parseUserId(participant.identity);

  if (track.kind === Track.Kind.Audio) {
    track.detach().forEach((el) => {
      el.remove();
    });
    const trackKey = `${participant.identity}-${track.sid}`;
    audioElements.delete(trackKey);
    if (userId > 0) {
      removeRemoteAnalyser(userId);
    }
    log.debug("Remote audio track unsubscribed", { userId, trackSid: track.sid });
  } else if (track.kind === Track.Kind.Video) {
    track.detach();
    if (userId > 0) {
      onRemoteVideoRemovedCallback?.(userId);
    }
    log.debug("Remote video track unsubscribed", { userId, trackSid: track.sid });
  }
}

// ---------------------------------------------------------------------------
// Remote audio analysers — one per remote participant for speaking detection
// ---------------------------------------------------------------------------

interface RemoteAnalyser {
  ctx: AudioContext;
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode;
  data: Uint8Array<ArrayBuffer>;
}

const remoteAnalysers = new Map<number, RemoteAnalyser>();

function addRemoteAnalyser(userId: number, mediaTrack: MediaStreamTrack): void {
  removeRemoteAnalyser(userId);
  try {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    const stream = new MediaStream([mediaTrack]);
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    remoteAnalysers.set(userId, { ctx, analyser, source, data: new Uint8Array(128) as Uint8Array<ArrayBuffer> });
  } catch (err) {
    log.warn("Failed to create remote analyser", { userId, error: err });
  }
}

function removeRemoteAnalyser(userId: number): void {
  const ra = remoteAnalysers.get(userId);
  if (ra) {
    ra.source.disconnect();
    ra.analyser.disconnect();
    void ra.ctx.close();
    remoteAnalysers.delete(userId);
  }
}

function cleanupAllRemoteAnalysers(): void {
  for (const [id] of remoteAnalysers) {
    removeRemoteAnalyser(id);
  }
}

/** Track whether local mic is currently gated by threshold. */
let localMicGated = false;
/** Local mic audio level analyser (Web Audio API). */
let localAnalyser: AnalyserNode | null = null;
let localAnalyserCtx: AudioContext | null = null;
let localAnalyserSource: MediaStreamAudioSourceNode | null = null;
let localAnalyserClonedTrack: MediaStreamTrack | null = null;
const localAnalyserData = new Uint8Array(128);

/** Compute RMS audio level (0-1) from frequency data. */
function computeRms(data: Uint8Array<ArrayBuffer>): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] ?? 0) / 255;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

/** Start local mic audio analysis using Web Audio AnalyserNode. */
function startLocalAnalyser(): void {
  stopLocalAnalyser();
  if (room === null) return;

  const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const mediaTrack = micPub?.track?.mediaStreamTrack;
  if (!mediaTrack) return;

  try {
    localAnalyserCtx = new AudioContext({ sampleRate: 48000 });
    localAnalyser = localAnalyserCtx.createAnalyser();
    localAnalyser.fftSize = 256;
    localAnalyser.smoothingTimeConstant = 0.5;

    // Clone the track so mic gating (track.enabled=false) doesn't
    // kill the analyser's audio input — avoids a deadlock where
    // gated silence keeps the threshold below forever.
    localAnalyserClonedTrack = mediaTrack.clone();
    const stream = new MediaStream([localAnalyserClonedTrack]);
    localAnalyserSource = localAnalyserCtx.createMediaStreamSource(stream);
    localAnalyserSource.connect(localAnalyser);
    log.debug("Local mic analyser started");
  } catch (err) {
    log.warn("Failed to start local mic analyser", err);
  }
}

function stopLocalAnalyser(): void {
  if (localAnalyserSource !== null) {
    localAnalyserSource.disconnect();
    localAnalyserSource = null;
  }
  if (localAnalyser !== null) {
    localAnalyser.disconnect();
    localAnalyser = null;
  }
  if (localAnalyserClonedTrack !== null) {
    localAnalyserClonedTrack.stop();
    localAnalyserClonedTrack = null;
  }
  if (localAnalyserCtx !== null) {
    void localAnalyserCtx.close();
    localAnalyserCtx = null;
  }
}

/** Start the speaking detection poll. Measures local mic via Web Audio
 *  AnalyserNode (since LiveKit's audioLevel is always 0 for local
 *  participant). Remote participants use LiveKit's audioLevel. */
function startSpeakingPoll(): void {
  stopSpeakingPoll();
  localMicGated = false;
  speakingPollInterval = setInterval(() => {
    if (room === null || currentChannelId === null) return;

    const speakerIds: number[] = [];

    // Measure local mic level via Web Audio analyser
    let localLevel = 0;
    if (localAnalyser !== null) {
      localAnalyser.getByteFrequencyData(localAnalyserData);
      localLevel = computeRms(localAnalyserData);
    }
    const localSpeaking = localLevel > speakingThreshold;

    // Gate local mic: disable track when below threshold (silence suppression)
    const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track?.mediaStreamTrack) {
      if (localSpeaking && localMicGated) {
        micPub.track.mediaStreamTrack.enabled = true;
        localMicGated = false;
      } else if (!localSpeaking && !localMicGated) {
        micPub.track.mediaStreamTrack.enabled = false;
        localMicGated = true;
      }
    }

    // Build speaker list for the ring
    if (localSpeaking) {
      const localId = parseUserId(room.localParticipant.identity);
      if (localId > 0) speakerIds.push(localId);
    }

    // Check remote participants via their own audio analysers
    for (const [userId, ra] of remoteAnalysers) {
      ra.analyser.getByteFrequencyData(ra.data);
      const rms = computeRms(ra.data);
      if (rms > speakingThreshold) {
        speakerIds.push(userId);
      }
    }

    setSpeakers({
      channel_id: currentChannelId,
      speakers: speakerIds,
    });
  }, 100);
}

function stopSpeakingPoll(): void {
  if (speakingPollInterval !== null) {
    clearInterval(speakingPollInterval);
    speakingPollInterval = null;
  }
  stopLocalAnalyser();
  cleanupAllRemoteAnalysers();
}

function handleDisconnected(reason?: DisconnectReason): void {
  log.info("LiveKit room disconnected", { reason });

  const isUnexpected = reason !== DisconnectReason.CLIENT_INITIATED;
  leaveVoice(false);

  if (isUnexpected) {
    onErrorCallback?.("Voice connection lost — disconnected");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Set the WS client reference used for signaling. */
export function setWsClient(client: WsClient): void {
  ws = client;
}

/** Set the server host for constructing LiveKit proxy URLs. */
export function setServerHost(host: string): void {
  serverHost = host;
}

/**
 * Resolve a LiveKit URL. If the server sends a relative path like "/livekit",
 * construct the full wss:// URL using the server host. This proxies LiveKit
 * signaling through OwnCord's HTTPS to avoid mixed-content blocks.
 */
/**
 * Resolve which LiveKit URL to use. Prefers the direct URL on localhost
 * (avoids self-signed TLS issues with WebView fetch). Falls back to the
 * HTTPS proxy path for remote connections.
 */
function resolveLiveKitUrl(proxyPath: string, directUrl?: string): string {
  if (serverHost !== null) {
    const host = serverHost.split(":")[0] ?? "";
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (isLocal && directUrl) {
      return directUrl;
    }
    if (proxyPath.startsWith("/")) {
      return `wss://${serverHost}${proxyPath}`;
    }
  }
  return proxyPath;
}

/** Set error callback for UI feedback (e.g. toast on connection failure). */
export function setOnError(cb: (message: string) => void): void {
  onErrorCallback = cb;
}

/** Clear the error callback. */
export function clearOnError(): void {
  onErrorCallback = null;
}

/** Set callback for when a remote user enables their camera. */
export function setOnRemoteVideo(cb: RemoteVideoCallback): void {
  onRemoteVideoCallback = cb;
}

/** Set callback for when a remote user disables their camera. */
export function setOnRemoteVideoRemoved(cb: RemoteVideoRemovedCallback): void {
  onRemoteVideoRemovedCallback = cb;
}

/** Clear remote video callbacks. */
export function clearOnRemoteVideo(): void {
  onRemoteVideoCallback = null;
  onRemoteVideoRemovedCallback = null;
}

/**
 * Handle a voice_token message from the server. Creates a LiveKit Room,
 * connects to the SFU, and publishes the local microphone track.
 */
export async function handleVoiceToken(
  token: string,
  url: string,
  channelId: number,
  directUrl?: string,
): Promise<void> {
  // Disconnect existing session first
  if (room !== null) {
    leaveVoice(false);
  }

  try {
    // Create room with audio processing defaults
    room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        echoCancellation: loadPref("echoCancellation", true),
        noiseSuppression: loadPref("noiseSuppression", true),
        autoGainControl: loadPref("autoGainControl", true),
      },
    });

    // Wire room events
    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
    room.on(RoomEvent.Disconnected, handleDisconnected);

    // Connect to LiveKit server with retry (LiveKit may still be initializing)
    const resolvedUrl = resolveLiveKitUrl(url, directUrl);
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await room.connect(resolvedUrl, token);
        break;
      } catch (connectErr) {
        if (attempt < MAX_RETRIES) {
          log.warn("LiveKit connect failed, retrying", { attempt, maxRetries: MAX_RETRIES, error: connectErr });
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          // Room may have been nulled by a concurrent leaveVoice() during the delay
          if (room === null) throw connectErr;
          // Recreate room for fresh connection state
          room.removeAllListeners();
          room = new Room({
            adaptiveStream: true,
            dynacast: true,
            audioCaptureDefaults: {
              echoCancellation: loadPref("echoCancellation", true),
              noiseSuppression: loadPref("noiseSuppression", true),
              autoGainControl: loadPref("autoGainControl", true),
            },
          });
          room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
          room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
          room.on(RoomEvent.Disconnected, handleDisconnected);
        } else {
          throw connectErr;
        }
      }
    }
    log.info("Connected to LiveKit room", { channelId, url: resolvedUrl });

    // Start audioLevel polling for speaking ring (uses sensitivity slider threshold)
    speakingThreshold = ((100 - loadPref<number>("voiceSensitivity", 50)) / 100) * 0.15;
    startSpeakingPoll();

    // Enable microphone: use RNNoise if Enhanced Noise Suppression is on
    const enhancedNS = loadPref<boolean>("enhancedNoiseSuppression", false);
    if (enhancedNS) {
      await publishWithNoiseSuppression();
      log.info("Published mic with RNNoise noise suppression");
    } else {
      await room.localParticipant.setMicrophoneEnabled(true);
      log.info("Published mic via LiveKit native capture");
    }

    // Apply saved input device
    const savedInput = loadPref<string>("audioInputDevice", "");
    if (savedInput) {
      await room.switchActiveDevice("audioinput", savedInput);
    }

    // Apply saved output device
    const savedOutput = loadPref<string>("audioOutputDevice", "");
    if (savedOutput) {
      await room.switchActiveDevice("audiooutput", savedOutput);
    }

    currentChannelId = channelId;

    // Start local mic level analyser (must be after mic is published)
    startLocalAnalyser();
    log.info("Voice session active", { channelId });
  } catch (err) {
    log.error("Failed to connect to LiveKit", err);
    onErrorCallback?.("Failed to join voice — connection error");
    leaveVoice(false);
  }
}

/**
 * Leave the current voice session and clean up all resources.
 * If sendWs is true (default), also notifies the server via voice_leave.
 */
export function leaveVoice(sendWs = true): void {
  if (sendWs && ws !== null) {
    ws.send({ type: "voice_leave", payload: {} });
  }

  // Stop raw mic stream acquired for RNNoise
  if (rawMicStream !== null) {
    for (const track of rawMicStream.getTracks()) {
      track.stop();
    }
    rawMicStream = null;
  }

  // Destroy noise suppressor
  if (noiseSuppressor !== null) {
    noiseSuppressor.destroy();
    noiseSuppressor = null;
  }

  // Stop speaking detection polling
  stopSpeakingPoll();

  // Disconnect LiveKit room
  if (room !== null) {
    room.removeAllListeners();
    void room.disconnect();
    room = null;
  }

  // Clean up remote audio elements
  cleanupAudioElements();

  currentChannelId = null;
  log.info("Left voice session");
}

/** Mute or unmute the local microphone. */
export function setMuted(muted: boolean): void {
  setLocalMuted(muted);
  if (room !== null) {
    void room.localParticipant.setMicrophoneEnabled(!muted);
  }
}

/** Deafen or undeafen — mutes all remote audio playback. */
export function setDeafened(deafened: boolean): void {
  setLocalDeafened(deafened);
  if (room !== null) {
    // Toggle subscription on remote audio tracks for deafen
    for (const participant of room.remoteParticipants.values()) {
      for (const pub of participant.audioTrackPublications.values()) {
        pub.setSubscribed(!deafened);
      }
    }
  }
  // Also mute/unmute audio elements directly for immediate effect
  for (const el of audioElements.values()) {
    el.muted = deafened;
  }
  log.debug("Deafen state changed", { deafened });
}

/** Enable camera: publish video track, notify server. */
export async function enableCamera(): Promise<void> {
  if (room === null || ws === null) {
    log.warn("Cannot enable camera: no active voice session");
    onErrorCallback?.("Join a voice channel first");
    return;
  }

  // Optimistic UI update — highlight button immediately
  setLocalCamera(true);

  try {
    await room.localParticipant.setCameraEnabled(true);

    // Apply saved video device
    const savedVideoDevice = loadPref<string>("videoInputDevice", "");
    if (savedVideoDevice) {
      await room.switchActiveDevice("videoinput", savedVideoDevice);
    }

    ws.send({ type: "voice_camera", payload: { enabled: true } });
    log.info("Camera enabled");
  } catch (err) {
    // Revert optimistic update on failure
    setLocalCamera(false);
    log.error("Failed to enable camera", err);
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      onErrorCallback?.("Camera permission denied");
    } else if (err instanceof DOMException && err.name === "NotFoundError") {
      onErrorCallback?.("No camera found");
    } else {
      onErrorCallback?.("Failed to start camera");
    }
  }
}

/** Disable camera: unpublish video track, notify server. */
export async function disableCamera(): Promise<void> {
  if (room !== null) {
    await room.localParticipant.setCameraEnabled(false);
  }

  setLocalCamera(false);
  if (ws !== null) {
    ws.send({ type: "voice_camera", payload: { enabled: false } });
  }
  log.info("Camera disabled");
}

/** Switch the input (microphone) device on an active session. */
export async function switchInputDevice(deviceId: string): Promise<void> {
  if (room === null) {
    log.debug("Skipping input device switch — no active voice session");
    return;
  }

  try {
    const enhancedNS = loadPref<boolean>("enhancedNoiseSuppression", false);
    if (enhancedNS && noiseSuppressor !== null) {
      // Need to re-acquire mic and re-process through RNNoise
      // Stop old raw stream
      if (rawMicStream !== null) {
        for (const track of rawMicStream.getTracks()) {
          track.stop();
        }
        rawMicStream = null;
      }
      noiseSuppressor.destroy();
      noiseSuppressor = null;

      // Unpublish current mic track
      for (const pub of room.localParticipant.audioTrackPublications.values()) {
        if (pub.source === Track.Source.Microphone && pub.track) {
          await room.localParticipant.unpublishTrack(pub.track);
        }
      }

      // Re-publish with new device
      await publishWithNoiseSuppression();
    } else {
      // Empty deviceId means "use system default" — skip switchActiveDevice
      // (it throws on empty string). Re-enable mic via LiveKit's native capture.
      if (deviceId) {
        await room.switchActiveDevice("audioinput", deviceId);
      } else {
        await room.localParticipant.setMicrophoneEnabled(false);
        await room.localParticipant.setMicrophoneEnabled(true);
      }
    }
    log.info("Switched input device", { deviceId });
  } catch (err) {
    log.error("Failed to switch input device", err);
    onErrorCallback?.("Failed to switch microphone");
  }
}

/** Switch the output (speaker) device on an active session. */
export async function switchOutputDevice(deviceId: string): Promise<void> {
  if (room !== null) {
    await room.switchActiveDevice("audiooutput", deviceId);
  }

  // Also update any existing audio elements
  for (const el of audioElements.values()) {
    if (typeof el.setSinkId === "function") {
      try {
        await el.setSinkId(deviceId);
      } catch (err) {
        log.warn("Failed to set output device on audio element", err);
      }
    }
  }
  log.info("Switched output device", { deviceId });
}

/**
 * Set per-user volume (0-200%). Persisted to localStorage.
 * Note: HTMLAudioElement.volume only supports 0.0-1.0, so volumes above
 * 100% are clamped.
 */
export function setUserVolume(userId: number, volume: number): void {
  const clamped = Math.max(0, Math.min(200, volume));
  savePref(`userVolume_${userId}`, clamped);

  // Find audio elements for this user's tracks
  if (room !== null) {
    for (const participant of room.remoteParticipants.values()) {
      const pUserId = parseUserId(participant.identity);
      if (pUserId === userId) {
        for (const pub of participant.audioTrackPublications.values()) {
          if (pub.track) {
            const els = pub.track.attachedElements;
            for (const el of els) {
              if (el instanceof HTMLAudioElement) {
                el.volume = Math.min(clamped, 100) / 100;
              }
            }
          }
        }
      }
    }
  }
}

/** Get the current per-user volume (0-200%, default 100). */
export function getUserVolume(userId: number): number {
  return getSavedUserVolume(userId);
}

/** Update the speaking detection sensitivity threshold.
 *  High sensitivity (100) = low threshold (picks up quiet sounds).
 *  Low sensitivity (0) = high threshold (only loud sounds). */
export function setVoiceSensitivity(sensitivity: number): void {
  const clamped = Math.max(0, Math.min(100, sensitivity));
  speakingThreshold = ((100 - clamped) / 100) * 0.15;
}

/** Get the local camera stream for self-view display. */
export function getLocalCameraStream(): MediaStream | null {
  if (room === null) return null;
  const cameraPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
  if (cameraPub?.track?.mediaStreamTrack) {
    return new MediaStream([cameraPub.track.mediaStreamTrack]);
  }
  return null;
}

/** Snapshot of current voice session state for debugging. */
export function getSessionDebugInfo(): Record<string, unknown> {
  if (room === null) {
    return {
      hasRoom: false,
      hasNoiseSuppressor: noiseSuppressor !== null,
      currentChannelId,
    };
  }

  const remoteParticipants: Record<string, unknown>[] = [];
  for (const p of room.remoteParticipants.values()) {
    const tracks: Record<string, unknown>[] = [];
    for (const pub of p.trackPublications.values()) {
      tracks.push({
        sid: pub.trackSid,
        source: pub.source,
        kind: pub.kind,
        subscribed: pub.isSubscribed,
        enabled: pub.isEnabled,
      });
    }
    remoteParticipants.push({
      identity: p.identity,
      userId: parseUserId(p.identity),
      tracks,
    });
  }

  const localTracks: Record<string, unknown>[] = [];
  for (const pub of room.localParticipant.trackPublications.values()) {
    localTracks.push({
      sid: pub.trackSid,
      source: pub.source,
      kind: pub.kind,
      isMuted: pub.isMuted,
    });
  }

  return {
    hasRoom: true,
    roomName: room.name,
    roomState: room.state,
    hasNoiseSuppressor: noiseSuppressor !== null,
    currentChannelId,
    localParticipant: room.localParticipant.identity,
    localTracks,
    remoteParticipants,
    audioElements: audioElements.size,
  };
}

// =============================================================================
// Voice Session — lifecycle orchestrator for voice chat
//
// Manages audio capture, WebRTC connection, remote audio playback, and
// WS signaling. Singleton module: only one voice session at a time.
// =============================================================================

import type { WsClient } from "@lib/ws";
import type { VoiceConfigPayload, IceServer } from "@lib/types";
import type { WebRtcService } from "@lib/webrtc";
import type { AudioManager } from "@lib/audio";
import type { VadDetector } from "@lib/vad";
import { createWebRtcService } from "@lib/webrtc";
import { createAudioManager } from "@lib/audio";
import { createVadDetector, sensitivityToThreshold } from "@lib/vad";
import { createNoiseSuppressor } from "@lib/noise-suppression";
import type { NoiseSuppressor } from "@lib/noise-suppression";
import { voiceStore, setLocalMuted, setLocalDeafened, setLocalSpeaking, setLocalCamera } from "@stores/voice.store";
import { createVideoManager } from "@lib/video";
import type { VideoManager } from "@lib/video";
import { loadPref, savePref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";

const log = createLogger("voiceSession");

// ---------------------------------------------------------------------------
// Module-level state (singleton)
// ---------------------------------------------------------------------------

let audioManager: AudioManager | null = null;
let webrtcService: WebRtcService | null = null;
let vadDetector: VadDetector | null = null;
let noiseSuppressor: NoiseSuppressor | null = null;
let localStream: MediaStream | null = null;
/** The stream actually sent to WebRTC (may be noise-suppressed). */
let processedStream: MediaStream | null = null;
let ws: WsClient | null = null;
let videoManager: VideoManager | null = null;
let cameraStream: MediaStream | null = null;
let videoSender: RTCRtpSender | null = null;
const audioElements = new Map<string, HTMLAudioElement>();
/** Shared AudioContext for all remote audio processing (avoids browser limit of ~6 contexts). */
let sharedAudioCtx: AudioContext | null = null;

function getSharedAudioContext(): AudioContext {
  if (sharedAudioCtx === null || sharedAudioCtx.state === "closed") {
    // Force 48kHz to match WebRTC Opus output. At high native rates
    // (e.g. 192kHz), the Web Audio resampling pipeline can introduce
    // issues or silence when bridging MediaStream → GainNode → destination.
    sharedAudioCtx = new AudioContext({ sampleRate: 48000 });
  }
  return sharedAudioCtx;
}

/** Map userId → GainNode for per-user volume control (legacy, unused — kept for diagnostics). */
const userGainNodes = new Map<number, GainNode>();
/** Map userId → HTMLAudioElement for per-user volume control via element.volume. */
const userAudioElements = new Map<number, HTMLAudioElement>();
/** Map stream.id → userId (parsed from server's "user-{id}" stream label). */
const streamUserMap = new Map<string, number>();
let audioContainer: HTMLDivElement | null = null;

// Optional error callback for UI feedback (e.g. toast on WebRTC failure)
let onErrorCallback: ((message: string) => void) | null = null;

// Remote video callbacks
type RemoteVideoCallback = (userId: number, stream: MediaStream) => void;
type RemoteVideoRemovedCallback = (userId: number) => void;
let onRemoteVideoCallback: RemoteVideoCallback | null = null;
let onRemoteVideoRemovedCallback: RemoteVideoRemovedCallback | null = null;

export function setOnRemoteVideo(cb: RemoteVideoCallback): void {
  onRemoteVideoCallback = cb;
}

export function setOnRemoteVideoRemoved(cb: RemoteVideoRemovedCallback): void {
  onRemoteVideoRemovedCallback = cb;
}

export function clearOnRemoteVideo(): void {
  onRemoteVideoCallback = null;
  onRemoteVideoRemovedCallback = null;
}

// Track event-unsubscribe functions for cleanup
let unsubIce: (() => void) | null = null;
let unsubTrack: (() => void) | null = null;
let unsubState: (() => void) | null = null;
let unsubIceState: (() => void) | null = null;
let unsubVad: (() => void) | null = null;

// ICE restart state
const ICE_RESTART_DELAY_MS = 5000;
let iceRestartTimer: ReturnType<typeof setTimeout> | null = null;
let currentChannelId: number | null = null;

// Guard against concurrent joinVoice calls
let joinInProgress = false;

// Cached silence suppression preference (avoid localStorage reads in hot path)
let silenceSuppressionEnabled = true;

/** Update cached silence suppression preference. Called from settings. */
export function updateSilenceSuppressionPref(): void {
  silenceSuppressionEnabled = loadPref<boolean>("silenceSuppression", true);
}

/** Shared VAD speaking callback — includes silence suppression logic. */
function onVadSpeakingChange(speaking: boolean): void {
  setLocalSpeaking(speaking);
  if (silenceSuppressionEnabled && webrtcService !== null) {
    webrtcService.setSilenced(!speaking);
  }
}

/** Pipe a raw mic stream through noise suppression if enabled, returning the
 *  stream to send to WebRTC. Destroys any existing suppressor first. */
async function applyNoiseSuppression(raw: MediaStream): Promise<MediaStream> {
  if (noiseSuppressor !== null) {
    noiseSuppressor.destroy();
    noiseSuppressor = null;
  }
  if (!loadPref<boolean>("enhancedNoiseSuppression", false)) return raw;
  try {
    noiseSuppressor = createNoiseSuppressor();
    const cleaned = await noiseSuppressor.process(raw);
    log.info("Enhanced noise suppression enabled");
    return cleaned;
  } catch (err) {
    log.warn("Failed to init noise suppression, using raw stream", err);
    return raw;
  }
}

/** Start (or restart) VAD on the stream that's actually sent to WebRTC.
 *  When noise suppression is active, this is the processed stream so the
 *  threshold matches what's transmitted (not raw mic noise). */
function startVad(stream: MediaStream): void {
  // Destroy old detector to avoid reusing a closed AudioContext
  if (vadDetector !== null) {
    if (unsubVad !== null) { unsubVad(); unsubVad = null; }
    vadDetector.destroy();
    vadDetector = null;
  }
  const sensitivity = loadPref<number>("voiceSensitivity", 50);
  vadDetector = createVadDetector({ threshold: sensitivityToThreshold(sensitivity) });
  vadDetector.start(stream);
  unsubVad = vadDetector.onSpeakingChange(onVadSpeakingChange);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Parse userId from server's stream label "user-{id}" or "user-{id}-{kind}". Returns 0 if unparseable. */
function parseUserIdFromStream(stream: MediaStream): number {
  // The server creates tracks with streamID = "user-{userID}-{kind}" (e.g. "user-42-audio", "user-42-video")
  const match = stream.id.match(/^user-(\d+)(?:-(?:audio|video))?$/);
  if (match !== null && match[1] !== undefined) {
    return Number(match[1]);
  }
  // Fallback: check track labels "audio-{userID}"
  for (const track of stream.getTracks()) {
    const trackMatch = track.id.match(/^(?:audio|video)-(\d+)$/);
    if (trackMatch !== null && trackMatch[1] !== undefined) {
      return Number(trackMatch[1]);
    }
  }
  log.warn("Could not parse userId from remote stream", {
    streamId: stream.id,
    trackIds: stream.getTracks().map((t) => t.id),
  });
  return 0;
}

/** Get saved per-user volume (0-200 range, default 100). */
function getSavedUserVolume(userId: number): number {
  return loadPref<number>(`userVolume_${userId}`, 100);
}

/** Add a remote MediaStream as an <audio> element with per-user volume.
 *  Uses HTMLAudioElement.volume directly instead of Web Audio GainNode —
 *  WebView2/Chromium silences remote WebRTC streams routed through
 *  createMediaStreamSource → GainNode → createMediaStreamDestination. */
function addRemoteStream(stream: MediaStream): void {
  if (audioElements.has(stream.id)) return;

  const container = getOrCreateAudioContainer();
  const userId = parseUserIdFromStream(stream);
  if (userId > 0) {
    streamUserMap.set(stream.id, userId);
  }

  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.setAttribute("playsinline", "");
  audio.srcObject = stream;

  // Apply saved per-user volume via HTMLAudioElement.volume (0.0-1.0 range).
  // We clamp the stored 0-200 range to 0-100 for element volume.
  const savedVolume = userId > 0 ? getSavedUserVolume(userId) : 100;
  audio.volume = Math.min(savedVolume, 100) / 100;

  if (userId > 0) {
    userAudioElements.set(userId, audio);
  }
  log.debug("Remote audio stream attached (direct playback)", { userId, volume: audio.volume });

  // Monitor playback state — autoplay may be blocked by browser policy
  audio.addEventListener("playing", () => {
    log.info("Remote audio playing", { streamId: stream.id, userId });
  });
  audio.addEventListener("pause", () => {
    // Ignore pause events that fire before the element is attached to DOM
    if (!audio.parentElement) return;
    log.warn("Remote audio paused", { streamId: stream.id, userId });
  });
  audio.addEventListener("error", () => {
    log.error("Remote audio element error", {
      streamId: stream.id,
      userId,
      error: audio.error?.message ?? "unknown",
      code: audio.error?.code,
    });
  });

  // Apply saved output device
  const savedOutput = loadPref<string>("audioOutputDevice", "");
  if (savedOutput !== "" && typeof audio.setSinkId === "function") {
    audio.setSinkId(savedOutput).catch((err) => {
      log.warn("Failed to set output device on remote audio", err);
    });
  }

  // Auto-remove when all tracks end
  stream.onremovetrack = () => {
    if (stream.getTracks().length === 0) {
      audio.srcObject = null;
      audio.remove();
      audioElements.delete(stream.id);
      streamUserMap.delete(stream.id);
      if (userId > 0) {
        userGainNodes.delete(userId);
        userAudioElements.delete(userId);
      }
      log.debug("Removed remote audio element", { streamId: stream.id, userId });
    }
  };

  container.appendChild(audio);
  audioElements.set(stream.id, audio);
  log.debug("Added remote audio element", { streamId: stream.id, userId });

  // Kick playback after DOM attachment — avoids "interrupted by a new load request"
  // race between autoplay and srcObject assignment.
  queueMicrotask(() => {
    if (audio.paused && audio.srcObject !== null) {
      audio.play().catch((err) => {
        log.error("Remote audio play() rejected", {
          streamId: stream.id,
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });
}

/** Attempt to acquire the microphone, falling back to system default. */
async function acquireMicrophone(): Promise<MediaStream | null> {
  if (audioManager === null) {
    audioManager = createAudioManager();
  }

  const savedDevice = loadPref<string>("audioInputDevice", "");

  // Try saved device first
  if (savedDevice !== "") {
    try {
      return await audioManager.getUserMedia(savedDevice);
    } catch (err) {
      log.warn("Failed to use saved input device, trying default", err);
    }
  }

  // Fall back to system default
  try {
    return await audioManager.getUserMedia();
  } catch (err) {
    log.warn("Failed to acquire microphone — entering listen-only mode", err);
    return null;
  }
}

/** Clean up all remote audio elements and per-user gain nodes. */
function cleanupAudioElements(): void {
  for (const el of audioElements.values()) {
    el.srcObject = null;
    el.remove();
  }
  audioElements.clear();
  userGainNodes.clear();
  userAudioElements.clear();
  streamUserMap.clear();

  // Close the shared AudioContext (will be re-created on next join)
  if (sharedAudioCtx !== null) {
    void sharedAudioCtx.close();
    sharedAudioCtx = null;
  }
}

/** Attempt ICE restart by creating a new offer with iceRestart flag. */
async function attemptIceRestart(): Promise<void> {
  if (webrtcService === null || ws === null || currentChannelId === null) {
    log.warn("Cannot ICE restart — no active session");
    return;
  }
  try {
    log.info("Attempting ICE restart", { channelId: currentChannelId });
    const offerSdp = await webrtcService.createOffer(true);
    ws.send({
      type: "voice_offer",
      payload: { channel_id: currentChannelId, sdp: offerSdp },
    });
    log.info("ICE restart offer sent");
  } catch (err) {
    log.error("ICE restart failed", err);
    onErrorCallback?.("Voice reconnection failed — please rejoin");
    leaveVoice();
  }
}

/** Unsubscribe WebRTC and VAD event handlers. */
function cleanupWebrtcSubs(): void {
  if (unsubIce !== null) {
    unsubIce();
    unsubIce = null;
  }
  if (unsubTrack !== null) {
    unsubTrack();
    unsubTrack = null;
  }
  if (unsubState !== null) {
    unsubState();
    unsubState = null;
  }
  if (unsubIceState !== null) {
    unsubIceState();
    unsubIceState = null;
  }
  if (unsubVad !== null) {
    unsubVad();
    unsubVad = null;
  }
  // Cancel any pending ICE restart
  if (iceRestartTimer !== null) {
    clearTimeout(iceRestartTimer);
    iceRestartTimer = null;
  }
  currentChannelId = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Set the WS client reference used for signaling. */
export function setWsClient(client: WsClient): void {
  ws = client;
}

/** Set error callback for UI feedback (e.g. toast on WebRTC failure). */
export function setOnError(cb: (message: string) => void): void {
  onErrorCallback = cb;
}

/** Clear the error callback (call on component destroy to avoid stale refs). */
export function clearOnError(): void {
  onErrorCallback = null;
}

/**
 * Fetch ICE servers (TURN/STUN credentials) for WebRTC.
 * Falls back to empty array on failure so voice still works on LAN.
 */
export type IceServerFetcher = () => Promise<readonly IceServer[]>;

/** Join a voice channel: acquire mic, set up WebRTC, send offer. */
export async function joinVoice(
  channelId: number,
  config: VoiceConfigPayload,
  fetchIceServers?: IceServerFetcher,
): Promise<void> {
  if (ws === null) {
    log.error("Cannot join voice: WS client not set");
    return;
  }

  // Prevent concurrent join attempts
  if (joinInProgress) {
    log.warn("Join already in progress, ignoring");
    return;
  }
  joinInProgress = true;

  // Clean up any existing voice session to prevent stale callbacks
  // from killing the new session (don't send voice_leave — server
  // already handled the channel switch).
  if (webrtcService !== null) {
    leaveVoice(false);
  }

  // Cache silence suppression pref at join time
  silenceSuppressionEnabled = loadPref<boolean>("silenceSuppression", true);

  try {
    // 1. Acquire microphone and ICE servers in parallel
    const [stream, iceServers] = await Promise.all([
      acquireMicrophone(),
      fetchIceServers
        ? fetchIceServers().catch((err) => {
            log.warn("Failed to fetch ICE servers, falling back to direct", err);
            return [] as readonly IceServer[];
          })
        : Promise.resolve([] as readonly IceServer[]),
    ]);
    localStream = stream;

    // 2. Create WebRTC peer connection with TURN/STUN servers
    webrtcService = createWebRtcService();
    webrtcService.createConnection({
      iceServers: iceServers.map((s) => ({
        urls: s.urls,
        username: s.username,
        credential: s.credential,
      })),
      opusBitrate: config.bitrate,
    });

    // 3. Apply noise suppression if enabled, then attach to WebRTC
    processedStream = localStream !== null
      ? await applyNoiseSuppression(localStream)
      : null;

    // 4. Attach local stream if available
    if (processedStream !== null) {
      webrtcService.setLocalStream(processedStream);
    }

    // 5. Wire ICE candidate forwarding
    unsubIce = webrtcService.onIceCandidate((candidate) => {
      if (ws === null) return;
      ws.send({
        type: "voice_ice",
        payload: { channel_id: channelId, candidate },
      });
    });

    // 6. Wire remote track playback
    unsubTrack = webrtcService.onRemoteTrack((stream) => {
      const hasVideo = stream.getVideoTracks().length > 0;
      const hasAudio = stream.getAudioTracks().length > 0;

      if (hasAudio && !hasVideo) {
        addRemoteStream(stream);
      } else if (hasVideo) {
        const userId = parseUserIdFromStream(stream);
        if (userId > 0 && onRemoteVideoCallback !== null) {
          onRemoteVideoCallback(userId, stream);
        }
        stream.onremovetrack = () => {
          if (stream.getTracks().length === 0 && userId > 0) {
            onRemoteVideoRemovedCallback?.(userId);
          }
        };
      }
    });

    // 7. Wire connection state monitoring
    unsubState = webrtcService.onStateChange((state) => {
      log.info("WebRTC connection state changed", { state });
      if (state === "failed") {
        log.error("WebRTC connection failed, leaving voice");
        onErrorCallback?.("Voice connection failed — disconnected");
        leaveVoice();
      }
    });

    // 7b. Wire ICE connection state for automatic ICE restart
    currentChannelId = channelId;
    unsubIceState = webrtcService.onIceStateChange((state) => {
      log.info("ICE connection state changed", { state });

      if (state === "disconnected") {
        // Start timer — ICE may self-recover. If not, restart after delay.
        if (iceRestartTimer === null) {
          log.info("ICE disconnected, scheduling restart", { delayMs: ICE_RESTART_DELAY_MS });
          iceRestartTimer = setTimeout(() => {
            iceRestartTimer = null;
            void attemptIceRestart();
          }, ICE_RESTART_DELAY_MS);
        }
      } else if (state === "connected" || state === "completed") {
        // ICE recovered on its own — cancel pending restart
        if (iceRestartTimer !== null) {
          log.info("ICE recovered, cancelling restart timer");
          clearTimeout(iceRestartTimer);
          iceRestartTimer = null;
        }
      } else if (state === "failed") {
        // ICE failed — attempt restart immediately
        if (iceRestartTimer !== null) {
          clearTimeout(iceRestartTimer);
          iceRestartTimer = null;
        }
        void attemptIceRestart();
      }
    });

    // 8. Start VAD on the processed stream (so threshold matches what's sent)
    if (localStream !== null && processedStream !== null) {
      startVad(processedStream);
    }

    // 9. Create and send SDP offer (guard: session may have been destroyed
    //    by a connection-failed event firing between wire-up and offer)
    if (webrtcService === null) {
      log.warn("WebRTC service destroyed before offer — aborting join");
      return;
    }
    // If the server already sent us an offer (renegotiation arrived before we
    // could create ours), we're in have-remote-offer state — skip our offer.
    // The handleServerOffer path will send an answer instead.
    try {
      const offerSdp = await webrtcService.createOffer();
      ws.send({
        type: "voice_offer",
        payload: { channel_id: channelId, sdp: offerSdp },
      });
    } catch (offerErr) {
      // Likely "Called in wrong state: have-remote-offer" — server renegotiation
      // arrived first. The onRemoteTrack + handleServerOffer path handles it.
      log.info("Skipping initial offer — server offer arrived first", {
        error: offerErr instanceof Error ? offerErr.message : String(offerErr),
      });
    }

    log.info("Joined voice channel", { channelId });
  } catch (err) {
    log.error("Failed to join voice channel", err);
    leaveVoice();
  } finally {
    joinInProgress = false;
  }
}

/**
 * Leave the current voice session and clean up all resources.
 * If sendWs is true (default), also notifies the server via voice_leave.
 * Pass sendWs=false when the server already knows (e.g. explicit UI leave
 * that sends voice_leave separately).
 */
export function leaveVoice(sendWs = true): void {
  // Notify server so it cleans up our voice state
  if (sendWs && ws !== null) {
    ws.send({ type: "voice_leave", payload: {} });
  }
  // Clear join guard so a new join can proceed after leave
  joinInProgress = false;

  // Stop camera stream
  if (cameraStream !== null) {
    for (const track of cameraStream.getTracks()) {
      track.stop();
    }
    cameraStream = null;
    videoSender = null;
  }

  // Stop processedStream tracks first (before nulling localStream so guard works)
  if (processedStream !== null && processedStream !== localStream) {
    for (const track of processedStream.getTracks()) {
      track.stop();
    }
  }
  processedStream = null;

  // Stop all local media tracks
  if (localStream !== null) {
    for (const track of localStream.getTracks()) {
      track.stop();
    }
    localStream = null;
  }

  // Destroy VAD
  if (vadDetector !== null) {
    vadDetector.destroy();
    vadDetector = null;
  }

  // Clean up WebRTC subscriptions before destroying
  cleanupWebrtcSubs();

  // Destroy noise suppressor
  if (noiseSuppressor !== null) {
    noiseSuppressor.destroy();
    noiseSuppressor = null;
  }

  // Destroy WebRTC
  if (webrtcService !== null) {
    webrtcService.destroy();
    webrtcService = null;
  }

  // Clean up remote audio playback
  cleanupAudioElements();

  // Destroy audio manager
  if (audioManager !== null) {
    audioManager.destroy();
    audioManager = null;
  }

  // Destroy video manager
  if (videoManager !== null) {
    videoManager.destroy();
    videoManager = null;
  }

  log.info("Left voice session");
}

/** Mute or unmute the local microphone. */
export function setMuted(muted: boolean): void {
  setLocalMuted(muted);
  if (webrtcService !== null) {
    // Mute via track.enabled — no renegotiation, instant, no race conditions.
    webrtcService.setMuted(muted);
  } else {
    // Fallback for listen-only mode (no WebRTC): disable raw mic tracks
    if (localStream !== null) {
      for (const track of localStream.getAudioTracks()) {
        track.enabled = !muted;
      }
    }
  }
}

/** Deafen or undeafen — mutes all remote audio playback. */
export function setDeafened(deafened: boolean): void {
  setLocalDeafened(deafened);
  for (const el of audioElements.values()) {
    el.muted = deafened;
  }
  log.debug("Deafen state changed", { deafened, audioElements: audioElements.size });
}

/** Enable camera: acquire webcam, add video track to WebRTC, notify server. */
export async function enableCamera(): Promise<void> {
  if (webrtcService === null || ws === null || currentChannelId === null) {
    log.warn("Cannot enable camera: no active voice session");
    onErrorCallback?.("Join a voice channel first");
    return;
  }

  if (cameraStream !== null) {
    log.debug("Camera already enabled");
    return;
  }

  if (videoManager === null) {
    videoManager = createVideoManager();
  }

  try {
    const savedDevice = loadPref<string>("videoInputDevice", "");
    cameraStream = savedDevice !== ""
      ? await videoManager.getCameraStream(savedDevice)
      : await videoManager.getCameraStream();

    const videoTrack = cameraStream.getVideoTracks()[0];
    if (videoTrack !== undefined) {
      videoTrack.addEventListener("ended", () => {
        log.warn("Camera track ended unexpectedly (device disconnected?)");
        void disableCamera();
        onErrorCallback?.("Camera disconnected");
      });
    }

    videoSender = webrtcService.addVideoTrack(cameraStream);

    if (webrtcService !== null && ws !== null) {
      const offerSdp = await webrtcService.createOffer();
      ws.send({
        type: "voice_offer",
        payload: { channel_id: currentChannelId, sdp: offerSdp },
      });
    }

    // Notify server and update store AFTER successful track addition
    setLocalCamera(true);
    ws.send({ type: "voice_camera", payload: { enabled: true } });

    log.info("Camera enabled", { channelId: currentChannelId });
  } catch (err) {
    log.error("Failed to enable camera", err);
    cameraStream = null;
    videoSender = null;

    if (err instanceof DOMException && err.name === "NotAllowedError") {
      onErrorCallback?.("Camera permission denied");
    } else if (err instanceof DOMException && err.name === "NotFoundError") {
      onErrorCallback?.("No camera found");
    } else {
      onErrorCallback?.("Failed to start camera");
    }
  }
}

/** Disable camera: stop stream, remove video track, notify server. */
export async function disableCamera(): Promise<void> {
  if (cameraStream !== null) {
    for (const track of cameraStream.getTracks()) {
      track.stop();
    }
    cameraStream = null;
  }

  if (videoSender !== null && webrtcService !== null) {
    webrtcService.removeVideoTrack(videoSender);
    videoSender = null;

    if (ws !== null && currentChannelId !== null) {
      try {
        const offerSdp = await webrtcService.createOffer();
        ws.send({
          type: "voice_offer",
          payload: { channel_id: currentChannelId, sdp: offerSdp },
        });
      } catch (err) {
        log.error("Failed to renegotiate after camera disable", err);
      }
    }
  }

  setLocalCamera(false);
  if (ws !== null) {
    ws.send({ type: "voice_camera", payload: { enabled: false } });
  }

  log.info("Camera disabled");
}

/** Switch the input (microphone) device on an active session. */
export async function switchInputDevice(deviceId: string): Promise<void> {
  // Don't acquire microphone if there's no active voice session
  if (webrtcService === null) {
    log.debug("Skipping input device switch — no active voice session");
    return;
  }
  if (audioManager === null) {
    audioManager = createAudioManager();
  }

  // Save old state so we can roll back on failure
  const oldLocalStream = localStream;
  const oldProcessedStream = processedStream;
  const oldSuppressor = noiseSuppressor;

  try {
    const newStream = await audioManager.getUserMedia(deviceId || undefined);
    if (newStream === null) return;

    // Guard: session may have ended during the async getUserMedia call
    if (webrtcService === null) {
      for (const track of newStream.getTracks()) track.stop();
      return;
    }

    // Temporarily detach old suppressor so applyNoiseSuppression doesn't
    // destroy it — we need the old pipeline alive for rollback on failure.
    noiseSuppressor = null;
    let newProcessed: MediaStream;
    try {
      newProcessed = await applyNoiseSuppression(newStream);
    } catch (err) {
      // Noise suppression failed — restore old suppressor, stop new stream
      noiseSuppressor = oldSuppressor;
      log.warn("Noise suppression failed during device switch, keeping old device", err);
      for (const track of newStream.getTracks()) track.stop();
      onErrorCallback?.("Failed to switch microphone — noise suppression error");
      return;
    }

    // Guard: session may have ended during noise suppression setup
    if (webrtcService === null) {
      if (newProcessed !== newStream) {
        for (const track of newProcessed.getTracks()) track.stop();
      }
      for (const track of newStream.getTracks()) track.stop();
      return;
    }

    // Swap track on WebRTC sender — no renegotiation needed
    await webrtcService.replaceTrack(newProcessed);

    // Success — update module state and stop old tracks
    localStream = newStream;
    processedStream = newProcessed;

    // Restart VAD on processed stream with full silence suppression
    startVad(newProcessed);

    // NOW clean up old resources (after new pipeline is fully wired)
    if (oldSuppressor !== null && oldSuppressor !== noiseSuppressor) {
      oldSuppressor.destroy();
    }
    if (oldProcessedStream !== null && oldProcessedStream !== oldLocalStream) {
      for (const track of oldProcessedStream.getTracks()) {
        track.stop();
      }
    }
    if (oldLocalStream !== null) {
      for (const track of oldLocalStream.getTracks()) {
        track.stop();
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
  let hadError = false;
  for (const el of audioElements.values()) {
    if (typeof el.setSinkId === "function") {
      try {
        await el.setSinkId(deviceId);
      } catch (err) {
        log.error("Failed to set output device on audio element", err);
        hadError = true;
      }
    }
  }
  if (hadError) {
    onErrorCallback?.("Failed to switch some audio to new speaker");
  }
  log.info("Switched output device", { deviceId });
}

/**
 * Set per-user volume (0-200%). Persisted to localStorage.
 * Like Discord, this only affects YOUR playback of that user's audio.
 * Note: HTMLAudioElement.volume only supports 0.0-1.0, so volumes above
 * 100% are clamped. For boost beyond 100%, a Web Audio GainNode would
 * be needed, but WebView2 silences remote WebRTC streams through GainNode.
 */
export function setUserVolume(userId: number, volume: number): void {
  const clamped = Math.max(0, Math.min(200, volume));
  savePref(`userVolume_${userId}`, clamped);

  const audioEl = userAudioElements.get(userId);
  if (audioEl !== undefined) {
    audioEl.volume = Math.min(clamped, 100) / 100;
  }
}

/** Get the current per-user volume (0-200%, default 100). */
export function getUserVolume(userId: number): number {
  return getSavedUserVolume(userId);
}

/** Update the VAD sensitivity threshold on an active session. */
export function setVoiceSensitivity(sensitivity: number): void {
  if (vadDetector === null) return;
  vadDetector.setThreshold(sensitivityToThreshold(sensitivity));
}

/** Get raw WebRTC remote streams for diagnostics (before GainNode). */
export function getRemoteStreams(): readonly MediaStream[] {
  return webrtcService?.getRemoteStreams() ?? [];
}

/** Get the local processed stream for diagnostics. */
export function getLocalProcessedStream(): MediaStream | null {
  return processedStream;
}

/** Handle an SDP offer from the server (re-negotiation). */
export async function handleServerOffer(
  sdp: string,
  channelId: number,
): Promise<void> {
  if (webrtcService === null) {
    log.warn("Received server offer but no WebRTC service active");
    return;
  }
  if (ws === null) {
    log.warn("Received server offer but no WS client set");
    return;
  }

  try {
    const answerSdp = await webrtcService.handleServerOffer(sdp);
    ws.send({
      type: "voice_answer",
      payload: { channel_id: channelId, sdp: answerSdp },
    });
    log.debug("Responded to server offer with answer", { channelId });
  } catch (err) {
    log.error("Failed to handle server offer", err);
  }
}

/** Handle an SDP answer from the server. */
export async function handleServerAnswer(sdp: string): Promise<void> {
  if (webrtcService === null) {
    log.warn("Received server answer but no WebRTC service active");
    return;
  }

  try {
    await webrtcService.handleAnswer(sdp);
    log.debug("Applied server answer");
  } catch (err) {
    log.error("Failed to handle server answer", err);
  }
}

/** Measure RMS audio level on a MediaStream (0-1). Returns 0 if no data. */
export function measureStreamLevel(stream: MediaStream): Promise<number> {
  return new Promise((resolve) => {
    try {
      const ctx = new AudioContext({ sampleRate: 48000 });
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      // Wait a few frames for data to flow
      let attempts = 0;
      const check = (): void => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] ?? 0) / 255;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        attempts++;
        if (rms > 0 || attempts >= 10) {
          source.disconnect();
          void ctx.close();
          resolve(Math.round(rms * 1000) / 1000);
        } else {
          setTimeout(check, 50);
        }
      };
      setTimeout(check, 100);
    } catch {
      resolve(-1);
    }
  });
}

/** Get the local camera stream for self-view display. */
export function getLocalCameraStream(): MediaStream | null {
  return cameraStream;
}

/** Snapshot of current voice session state for debugging. */
export function getSessionDebugInfo(): Record<string, unknown> {
  // Gather detailed remote track info
  const remoteTrackDetails: Record<string, unknown>[] = [];
  for (const [streamId, audioEl] of audioElements.entries()) {
    const userId = streamUserMap.get(streamId) ?? 0;
    const gainNode = userId > 0 ? userGainNodes.get(userId) : undefined;
    const srcObj = audioEl.srcObject as MediaStream | null;
    const tracks = srcObj?.getAudioTracks() ?? [];
    const trackInfo = tracks.map((t) => ({
      id: t.id,
      enabled: t.enabled,
      muted: t.muted,
      readyState: t.readyState,
    }));

    remoteTrackDetails.push({
      streamId,
      userId,
      audioPaused: audioEl.paused,
      audioMuted: audioEl.muted,
      audioVolume: audioEl.volume,
      audioReadyState: audioEl.readyState,
      hasSrcObject: audioEl.srcObject !== null,
      gainValue: gainNode?.gain.value ?? "no-node",
      tracks: trackInfo,
    });
  }

  // Local track info
  const localTracks = processedStream?.getAudioTracks() ?? [];
  const localTrackInfo = localTracks.map((t) => ({
    id: t.id,
    enabled: t.enabled,
    muted: t.muted,
    readyState: t.readyState,
  }));

  // WebRTC remote streams info
  const webrtcRemoteStreams = webrtcService?.getRemoteStreams() ?? [];
  const webrtcRemoteInfo = webrtcRemoteStreams.map((s) => ({
    streamId: s.id,
    trackCount: s.getTracks().length,
    audioTracks: s.getAudioTracks().map((t) => ({
      id: t.id,
      enabled: t.enabled,
      muted: t.muted,
      readyState: t.readyState,
    })),
  }));

  return {
    hasAudioManager: audioManager !== null,
    hasWebrtc: webrtcService !== null,
    hasVad: vadDetector !== null,
    hasNoiseSuppressor: noiseSuppressor !== null,
    hasLocalStream: localStream !== null,
    hasProcessedStream: processedStream !== null,
    joinInProgress,
    silenceSuppressionEnabled,
    sharedAudioCtx: sharedAudioCtx !== null
      ? { state: sharedAudioCtx.state, sampleRate: sharedAudioCtx.sampleRate }
      : null,
    localTracks: localTrackInfo,
    remoteAudioElements: remoteTrackDetails,
    webrtcRemoteStreams: webrtcRemoteInfo,
  };
}

/** Handle an ICE candidate from the server. */
export async function handleServerIce(
  candidate: RTCIceCandidateInit,
): Promise<void> {
  if (webrtcService === null) {
    log.warn("Received ICE candidate but no WebRTC service active");
    return;
  }

  try {
    await webrtcService.handleIceCandidate(candidate);
    log.debug("Added server ICE candidate");
  } catch (err) {
    log.error("Failed to handle server ICE candidate", err);
  }
}

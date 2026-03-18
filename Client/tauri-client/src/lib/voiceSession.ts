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
import { createVadDetector } from "@lib/vad";
import { voiceStore, setLocalMuted, setLocalDeafened, setLocalSpeaking } from "@stores/voice.store";
import { loadPref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";

const log = createLogger("voiceSession");

// ---------------------------------------------------------------------------
// Module-level state (singleton)
// ---------------------------------------------------------------------------

let audioManager: AudioManager | null = null;
let webrtcService: WebRtcService | null = null;
let vadDetector: VadDetector | null = null;
let localStream: MediaStream | null = null;
let ws: WsClient | null = null;
const audioElements = new Map<string, HTMLAudioElement>();
let audioContainer: HTMLDivElement | null = null;

// Optional error callback for UI feedback (e.g. toast on WebRTC failure)
let onErrorCallback: ((message: string) => void) | null = null;

// Track event-unsubscribe functions for cleanup
let unsubIce: (() => void) | null = null;
let unsubTrack: (() => void) | null = null;
let unsubState: (() => void) | null = null;
let unsubVad: (() => void) | null = null;

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

/** Add a remote MediaStream as an <audio> element for playback. */
function addRemoteStream(stream: MediaStream): void {
  if (audioElements.has(stream.id)) return;

  const container = getOrCreateAudioContainer();
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.setAttribute("playsinline", "");
  audio.srcObject = stream;

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
      log.debug("Removed remote audio element", { streamId: stream.id });
    }
  };

  container.appendChild(audio);
  audioElements.set(stream.id, audio);
  log.debug("Added remote audio element", { streamId: stream.id });
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

/** Clean up all remote audio elements. */
function cleanupAudioElements(): void {
  for (const [id, el] of audioElements) {
    el.srcObject = null;
    el.remove();
    audioElements.delete(id);
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
  if (unsubVad !== null) {
    unsubVad();
    unsubVad = null;
  }
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

  // Clean up any existing voice session to prevent stale callbacks
  // from killing the new session (don't send voice_leave — server
  // already handled the channel switch).
  if (webrtcService !== null) {
    leaveVoice(false);
  }

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

    // 3. Attach local stream if available
    if (localStream !== null) {
      webrtcService.setLocalStream(localStream);
    }

    // 4. Wire ICE candidate forwarding
    unsubIce = webrtcService.onIceCandidate((candidate) => {
      if (ws === null) return;
      ws.send({
        type: "voice_ice",
        payload: { channel_id: channelId, candidate },
      });
    });

    // 5. Wire remote track playback
    unsubTrack = webrtcService.onRemoteTrack((stream) => {
      addRemoteStream(stream);
    });

    // 6. Wire connection state monitoring
    unsubState = webrtcService.onStateChange((state) => {
      log.info("WebRTC connection state changed", { state });
      if (state === "failed") {
        log.error("WebRTC connection failed, leaving voice");
        onErrorCallback?.("Voice connection failed — disconnected");
        leaveVoice();
      }
    });

    // 7. Start VAD if we have a mic stream
    if (localStream !== null) {
      vadDetector = createVadDetector();
      vadDetector.start(localStream);
      unsubVad = vadDetector.onSpeakingChange((speaking) => {
        setLocalSpeaking(speaking);
      });
    }

    // 8. Create and send SDP offer
    const offerSdp = await webrtcService.createOffer();
    ws.send({
      type: "voice_offer",
      payload: { channel_id: channelId, sdp: offerSdp },
    });

    log.info("Joined voice channel", { channelId });
  } catch (err) {
    log.error("Failed to join voice channel", err);
    leaveVoice();
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

  log.info("Left voice session");
}

/** Mute or unmute the local microphone. */
export function setMuted(muted: boolean): void {
  setLocalMuted(muted);
  // Disable tracks on the local stream directly as a fallback
  if (localStream !== null) {
    for (const track of localStream.getAudioTracks()) {
      track.enabled = !muted;
    }
  }
  // Also replace tracks on WebRTC senders for full RTP-level muting
  if (webrtcService !== null) {
    webrtcService.setMuted(muted);
  }
}

/** Deafen or undeafen — mutes all remote audio playback. */
export function setDeafened(deafened: boolean): void {
  setLocalDeafened(deafened);
  for (const el of audioElements.values()) {
    el.muted = deafened;
  }
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
  try {
    const newStream = await audioManager.getUserMedia(deviceId || undefined);
    if (newStream === null) return;

    // Stop old tracks
    if (localStream !== null) {
      for (const track of localStream.getTracks()) {
        track.stop();
      }
    }
    localStream = newStream;

    // Replace in WebRTC
    if (webrtcService !== null) {
      webrtcService.setLocalStream(localStream);
      // Re-apply mute state to new tracks
      if (voiceStore.getState().localMuted) {
        webrtcService.setMuted(true);
      }
    }

    // Restart VAD on new stream
    if (vadDetector !== null) {
      if (unsubVad !== null) {
        unsubVad();
        unsubVad = null;
      }
      vadDetector.stop();
      vadDetector.start(localStream);
      unsubVad = vadDetector.onSpeakingChange((speaking) => {
        setLocalSpeaking(speaking);
      });
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

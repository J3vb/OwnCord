// LiveKit Session — lifecycle orchestrator for voice chat via LiveKit
import type { Room } from "livekit-client";
import { voiceStore, setVoiceStatus, onPttPollingLiveChange } from "@stores/voice.store";
import { installLivekitLogging } from "@lib/voice/livekitDiagnostics";
import { LiveKitSession } from "../../features/voice/voiceSession";
export { LiveKitSession } from "../../features/voice/voiceSession";

// Re-export StreamQuality so existing consumers don't break
export type { StreamQuality } from "@lib/voice/screenShare";

// --- Push-to-talk liveness (cross-module signal, no instance state) ---

/** Re-exported from the voice store, which owns the flag so `ptt.ts` can write
 *  it at startup without importing this module (and the ~1.3 MB livekit-client
 *  SDK behind it). See `voice.store.ts` for the platform-capability contract. */
export { setPttPollingLive } from "@stores/voice.store";

// --- Session state types + pure helpers (leaf module) ---

export { parseUserId } from "../../features/voice/sessionState";
export type {
  RemoteVideoCallback,
  RemoteVideoRemovedCallback,
} from "../../features/voice/sessionState";

// --- Singleton instance + re-exported bound methods ---

installLivekitLogging();
const session = new LiveKitSession();

// Expose debug info on window under __owncord namespace for DevTools console access
// Usage: JSON.stringify(__owncord.lkDebug(), null, 2)
const owncordNs = ((window as unknown as Record<string, unknown>).__owncord ??= {}) as Record<
  string,
  unknown
>;
owncordNs.lkDebug = session.getSessionDebugInfo.bind(session);
// Status seam for the production-build e2e suite, which cannot import stores:
// it stands in for room.connect() succeeding (no real LiveKit server there).
owncordNs.voiceStatus = () => voiceStore.getState().voiceStatus;
owncordNs.setVoiceStatus = setVoiceStatus;

export const setWsClient = session.setWsClient.bind(session);
export const resendWatching = session.resendWatching.bind(session);
export const retryWatching = session.retryWatching.bind(session);
export const setServerHost = session.setServerHost.bind(session);
export const setOnError = session.setOnError.bind(session);
export const setOnRemoteVideo = session.setOnRemoteVideo.bind(session);
export const setOnRemoteVideoRemoved = session.setOnRemoteVideoRemoved.bind(session);
export const clearOnRemoteVideo = session.clearOnRemoteVideo.bind(session);
export const handleVoiceToken = session.handleVoiceToken.bind(session);
export const handleE2EEAnnounce = session.handleE2EEAnnounce.bind(session);
export const handleE2EEOffer = session.handleE2EEOffer.bind(session);
export const rePinPeerIdentity = session.rePinPeerIdentity.bind(session);
export const peerAnnouncedIdentityKey = session.peerAnnouncedIdentityKey.bind(session);
export const handleParticipantLeft = session.handleParticipantLeft.bind(session);
export const leaveVoice = session.leaveVoice.bind(session);
export const failPendingRejoin = session.failPendingRejoin.bind(session);
export const isAutoReconnecting = session.isAutoReconnecting.bind(session);
export const retryMicPermission = session.retryMicPermission.bind(session);
export const cleanupAll = session.cleanupAll.bind(session);
export const setMuted = session.setMuted.bind(session);
export const setDeafened = session.setDeafened.bind(session);
export const enableCamera = session.enableCamera.bind(session);
export const disableCamera = session.disableCamera.bind(session);
export const enableScreenshare = session.enableScreenshare.bind(session);
export const disableScreenshare = session.disableScreenshare.bind(session);
export const reconcileVideoFlags = session.reconcileVideoFlags.bind(session);
export const changeScreenshareSource = session.changeScreenshareSource.bind(session);
export const setScreenshareQuality = session.setScreenshareQuality.bind(session);
export const getScreenshareQuality = session.getScreenshareQuality.bind(session);
export const canChangeScreenshareSource = session.canChangeScreenshareSource.bind(session);
export const switchInputDevice = session.switchInputDevice.bind(session);
export const switchOutputDevice = session.switchOutputDevice.bind(session);
export const switchVideoDevice = session.switchVideoDevice.bind(session);
export const setUserVolume = session.setUserVolume.bind(session);
export const getUserVolume = session.getUserVolume.bind(session);
export const setUserLocalMute = session.setUserLocalMute.bind(session);
export const getUserLocalMute = session.getUserLocalMute.bind(session);
export const setInputVolume = session.setInputVolume.bind(session);
export const onNativeInputLevel = session.onNativeInputLevel.bind(session);
export const setOutputVolume = session.setOutputVolume.bind(session);
export const setVoiceSensitivity = session.setVoiceSensitivity.bind(session);
export const applyInputMode = session.applyInputMode.bind(session);
// Push to Talk takes over from the sensitivity gate only once its poller is live.
onPttPollingLiveChange(applyInputMode);
export const setPttGated = session.setPttGated.bind(session);
export const reapplyAudioProcessing = session.reapplyAudioProcessing.bind(session);
export const reapplyEnhancedNoiseSuppression =
  session.reapplyEnhancedNoiseSuppression.bind(session);
export const getLocalCameraStream = session.getLocalCameraStream.bind(session);
export const getLocalScreenshareStream = session.getLocalScreenshareStream.bind(session);
export const getLocalScreenshareStats = session.getLocalScreenshareStats.bind(session);
export const hasLocalScreenshareAudio = session.hasLocalScreenshareAudio.bind(session);
export const getRemoteVideoStats = session.getRemoteVideoStats.bind(session);
export const setRemoteVideoView = session.setRemoteVideoView.bind(session);
export const setRemoteVideoWatched = session.setRemoteVideoWatched.bind(session);
export const forgetRemoteVideoWatch = session.forgetRemoteVideoWatch.bind(session);
export const getSessionDebugInfo = session.getSessionDebugInfo.bind(session);
export const getShareDiagnostics = session.getShareDiagnostics.bind(session);
export const getLocalMicSettings = session.getLocalMicSettings.bind(session);
export const setScreenshareAudioVolume = session.setScreenshareAudioVolume.bind(session);
export const getScreenshareAudioVolume = session.getScreenshareAudioVolume.bind(session);
export const muteScreenshareAudio = session.muteScreenshareAudio.bind(session);
export const getScreenshareAudioMuted = session.getScreenshareAudioMuted.bind(session);

/** True while a join is in flight ("connecting"/"reconnecting") OR a room is
 *  live ("connected") — i.e. there is something for leaveVoice() to tear
 *  down. A Room-existence check alone reads false for the entire
 *  "connecting" state (no Room object exists yet), so a caller deciding
 *  whether to abort an in-flight join must ask this instead. */
export function isVoiceSessionActive(): boolean {
  return session.hasActiveSession();
}

export function getRoomForStats(): Room | null {
  return session.getRoom();
}

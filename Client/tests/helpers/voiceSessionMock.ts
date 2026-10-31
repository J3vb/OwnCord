import { vi } from "vitest";

/**
 * Module factory bodies for `vi.mock("@lib/voice/livekitSession", ...)`.
 *
 * `defaults()` covers every export the suites mock, each as a spy with the
 * behaviour most suites want. `withOverrides(partial)` changes single members
 * and leaves the rest. Call them synchronously from the factory, through a
 * namespace import placed before the module under test:
 *
 *   import * as voiceSession from "../helpers/voiceSessionMock";
 *   vi.mock("@lib/voice/livekitSession", () => voiceSession.withOverrides({ ... }));
 */

export function defaults() {
  return {
    applyInputMode: vi.fn(),
    canChangeScreenshareSource: () => false,
    changeScreenshareSource: vi.fn(),
    cleanupAll: vi.fn(),
    clearOnRemoteVideo: vi.fn(),
    disableCamera: vi.fn().mockResolvedValue(undefined),
    disableScreenshare: vi.fn().mockResolvedValue(undefined),
    enableCamera: vi.fn().mockResolvedValue(undefined),
    enableScreenshare: vi.fn().mockResolvedValue(undefined),
    failPendingRejoin: vi.fn(),
    getLocalCameraStream: vi.fn(() => null),
    getLocalMicSettings: () => null,
    getLocalScreenshareStats: vi.fn().mockResolvedValue(null),
    getLocalScreenshareStream: vi.fn(() => null),
    getRemoteVideoStats: vi.fn().mockResolvedValue(null),
    getRoomForStats: vi.fn().mockReturnValue(null),
    getScreenshareAudioMuted: vi.fn(() => false),
    getScreenshareAudioVolume: vi.fn(() => 1),
    getScreenshareQuality: () => null,
    getSessionDebugInfo: vi.fn().mockReturnValue({}),
    getShareDiagnostics: vi.fn().mockReturnValue(null),
    getUserLocalMute: vi.fn(() => false),
    getUserVolume: vi.fn(() => 1),
    handleE2EEAnnounce: vi.fn(async () => {}),
    handleE2EEOffer: vi.fn(async () => {}),
    handleParticipantLeft: vi.fn(async () => {}),
    handleVoiceToken: vi.fn(async () => {}),
    hasLocalScreenshareAudio: vi.fn(() => false),
    isAutoReconnecting: vi.fn(() => false),
    isVoiceSessionActive: vi.fn(() => false),
    joinVoice: vi.fn(),
    leaveVoice: vi.fn(),
    muteScreenshareAudio: vi.fn(),
    onNativeInputLevel: () => () => {},
    parseUserId: vi.fn(),
    peerAnnouncedIdentityKey: vi.fn(() => null),
    rePinPeerIdentity: vi.fn(() => Promise.resolve(true)),
    reapplyAudioProcessing: vi.fn().mockResolvedValue(undefined),
    reapplyEnhancedNoiseSuppression: vi.fn(),
    reconcileVideoFlags: vi.fn(),
    resendWatching: vi.fn(),
    retryMicPermission: vi.fn().mockResolvedValue(undefined),
    setDeafened: vi.fn(),
    setInputVolume: vi.fn(),
    setMuted: vi.fn(),
    setOnError: vi.fn(),
    setOnRemoteVideo: vi.fn(),
    setOnRemoteVideoRemoved: vi.fn(),
    setOutputVolume: vi.fn(),
    setPttGated: vi.fn(),
    setRemoteVideoView: vi.fn(),
    setScreenshareAudioVolume: vi.fn(),
    setScreenshareQuality: vi.fn(),
    setServerHost: vi.fn(),
    setUserLocalMute: vi.fn(),
    setUserVolume: vi.fn(),
    setVoiceSensitivity: vi.fn(),
    setWsClient: vi.fn(),
    switchInputDevice: vi.fn(),
    switchOutputDevice: vi.fn(),
    switchVideoDevice: vi.fn(),
    toggleDeafen: vi.fn(),
    toggleMute: vi.fn(),
  };
}

export type VoiceSessionMock = ReturnType<typeof defaults>;

/** The defaults with the named members replaced. */
export function withOverrides(partial: { [K in keyof VoiceSessionMock]?: unknown }) {
  return { ...defaults(), ...partial };
}

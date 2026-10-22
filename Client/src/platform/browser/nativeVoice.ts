// The browser has its own WebRTC, so the native voice backend does not exist:
// every operation rejects and every subscription is inert. The contract's
// "browser outlook" is "not applicable".
import type { NativeVoice } from "../contracts/nativeVoice";
import { inertUnsubscribe, refuse } from "./unavailable";

const no = <T>(): Promise<T> => refuse<T>();

export const nativeVoice: NativeVoice = {
  setRoomKey: () => no(),
  clearRoomKey: () => no(),
  connect: () => no(),
  disconnect: () => no(),
  setMicrophone: () => no(),
  setPttGated: () => no(),
  setVoiceGate: () => no(),
  setInputGain: () => no(),
  setAudioProcessing: () => no(),
  getStats: () => no(),
  setSubscribed: () => no(),
  setVideoView: () => no(),
  setVolume: () => no(),
  setScreenshareVolume: () => no(),
  publishCamera: () => no(),
  unpublishCamera: () => no(),
  listCameras: () => no(),
  cameraSupport: () => no(),
  videoCodecs: () => no(),
  startCamera: () => no(),
  stopCamera: () => no(),
  startCameraPreview: () => no(),
  stopCameraPreview: () => no(),
  screenSources: () => no(),
  startScreen: () => no(),
  publishScreen: () => no(),
  unpublishScreen: () => no(),
  publishScreenAudio: () => no(),
  unpublishScreenAudio: () => no(),
  stopScreen: () => no(),
  changeScreen: () => no(),
  setScreenQuality: () => no(),
  changeCamera: () => no(),
  debugInfo: () => no(),
  listDevices: () => no(),
  setDevice: () => no(),
  startMicTest: () => no(),
  updateMicTest: () => no(),
  stopMicTest: () => no(),
  onMicTestEvent: inertUnsubscribe,
  watchDevices: inertUnsubscribe,
  playSound: () => no(),
  stopSound: () => no(),
  onEvent: inertUnsubscribe,
};

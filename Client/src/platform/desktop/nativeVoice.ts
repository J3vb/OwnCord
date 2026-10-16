// The registered native-voice capability: a facade that loads the host
// bindings (`./nativeVoiceService.ts`) on first use, so the Linux-only
// backend costs the startup chunk nothing on any platform.
import type { NativeVoice } from "../contracts/nativeVoice";

async function service(): Promise<NativeVoice> {
  return (await import("./nativeVoiceService")).nativeVoice;
}

export const nativeVoice: NativeVoice = {
  setRoomKey: async (key) => (await service()).setRoomKey(key),
  clearRoomKey: async () => (await service()).clearRoomKey(),
  connect: async (url, token, audio) => (await service()).connect(url, token, audio),
  disconnect: async (session) => (await service()).disconnect(session),
  setMicrophone: async (session, enabled, bitrate) =>
    (await service()).setMicrophone(session, enabled, bitrate),
  setPttGated: async (session, gated) => (await service()).setPttGated(session, gated),
  setVoiceGate: async (session, threshold, retune) =>
    (await service()).setVoiceGate(session, threshold, retune),
  setInputGain: async (session, percent) => (await service()).setInputGain(session, percent),
  setAudioProcessing: async (session, audio) =>
    (await service()).setAudioProcessing(session, audio),
  setSubscribed: async (session, identity, sid, subscribed) =>
    (await service()).setSubscribed(session, identity, sid, subscribed),
  setVideoView: async (session, identity, sid, enabled, quality) =>
    (await service()).setVideoView(session, identity, sid, enabled, quality),
  setVolume: async (session, identity, volume) =>
    (await service()).setVolume(session, identity, volume),
  setScreenshareVolume: async (session, identity, volume) =>
    (await service()).setScreenshareVolume(session, identity, volume),
  publishCamera: async (session, capture, options) =>
    (await service()).publishCamera(session, capture, options),
  unpublishCamera: async (session, sid) => (await service()).unpublishCamera(session, sid),
  listCameras: async () => (await service()).listCameras(),
  cameraSupport: async () => (await service()).cameraSupport(),
  startCamera: async (session, source, capture) =>
    (await service()).startCamera(session, source, capture),
  stopCamera: async (session, capture) => (await service()).stopCamera(session, capture),
  startCameraPreview: async (source, capture) =>
    (await service()).startCameraPreview(source, capture),
  stopCameraPreview: async () => (await service()).stopCameraPreview(),
  screenSources: async () => (await service()).screenSources(),
  startScreen: async (session, source, capture) =>
    (await service()).startScreen(session, source, capture),
  publishScreen: async (session, capture, options) =>
    (await service()).publishScreen(session, capture, options),
  stopScreen: async (session, capture) => (await service()).stopScreen(session, capture),
  changeScreen: async (session, source, capture) =>
    (await service()).changeScreen(session, source, capture),
  debugInfo: async () => (await service()).debugInfo(),
  listDevices: async () => (await service()).listDevices(),
  setDevice: async (session, kind, deviceId) =>
    (await service()).setDevice(session, kind, deviceId),
  startMicTest: async (options) => (await service()).startMicTest(options),
  updateMicTest: async (test, update) => (await service()).updateMicTest(test, update),
  stopMicTest: async (test) => (await service()).stopMicTest(test),
  onMicTestEvent(handler) {
    let active = true;
    let unlisten: (() => void) | null = null;
    void service().then((s) => {
      const stop = s.onMicTestEvent(handler);
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
      unlisten = null;
    };
  },
  onEvent(handler) {
    // The service load is itself asynchronous: an unsubscribe that lands
    // before it resolves must release the subscription it would have made.
    let active = true;
    let unlisten: (() => void) | null = null;
    void service().then((s) => {
      const stop = s.onEvent(handler);
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
      unlisten = null;
    };
  },
};

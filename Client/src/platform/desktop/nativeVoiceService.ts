// The native voice backend's host bindings (`src-tauri/src/native_voice/`):
// one command per contract method and the `native-voice` event. Loaded on
// first use by the registered facade (`nativeVoice.ts`) so it stays out of
// the startup chunk on every platform — only the Linux voice path reaches it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  NativeVoice,
  NativeVoiceConnected,
  NativeVoiceDevices,
  NativeVoiceEnvelope,
  NativeVoiceResources,
  NativeVoiceScreenSources,
  NativeVoiceScreenStarted,
} from "../contracts/nativeVoice";

export const NATIVE_VOICE_EVENT = "native-voice";

export const nativeVoice: NativeVoice = {
  setRoomKey: (key) => invoke<void>("native_voice_set_key", { key }),
  clearRoomKey: () => invoke<void>("native_voice_clear_key"),
  connect: (url, token, audio) =>
    invoke<NativeVoiceConnected>("native_voice_connect", { url, token, audio }),
  disconnect: (session) => invoke<NativeVoiceResources>("native_voice_disconnect", { session }),
  setMicrophone: (session, enabled) =>
    invoke<void>("native_voice_set_microphone", { session, enabled }),
  setSubscribed: (session, identity, sid, subscribed) =>
    invoke<void>("native_voice_set_subscribed", { session, identity, sid, subscribed }),
  setVolume: (session, identity, volume) =>
    invoke<void>("native_voice_set_volume", { session, identity, volume }),
  setScreenshareVolume: (session, identity, volume) =>
    invoke<void>("native_voice_set_screenshare_volume", { session, identity, volume }),
  publishCamera: (session, options) =>
    invoke<string>("native_voice_publish_camera", { session, options }),
  unpublishCamera: (session, sid) =>
    invoke<void>("native_voice_unpublish_camera", { session, sid }),
  screenSources: () => invoke<NativeVoiceScreenSources>("native_voice_screen_sources"),
  startScreen: (session, source, capture) =>
    invoke<NativeVoiceScreenStarted>("native_voice_start_screen", { session, source, capture }),
  publishScreen: (session, capture, options) =>
    invoke<string>("native_voice_publish_screen", { session, capture, options }),
  stopScreen: (session, capture) => invoke<void>("native_voice_stop_screen", { session, capture }),
  debugInfo: () => invoke<NativeVoiceResources>("native_voice_debug_info"),
  listDevices: () => invoke<NativeVoiceDevices>("native_voice_list_devices"),
  setDevice: (session, kind, deviceId) =>
    invoke<void>("native_voice_set_device", { session, kind, deviceId }),
  onEvent(handler) {
    // Same late-resolve shape as trayStatus.ts: the host resolves the
    // unlisten asynchronously, and an unsubscribe that lands first must
    // still release it.
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<NativeVoiceEnvelope>(NATIVE_VOICE_EVENT, (e) => {
      if (active) handler(e.payload);
    }).then((stop) => {
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

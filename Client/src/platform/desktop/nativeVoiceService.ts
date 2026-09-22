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
  publishCamera: (session, options) =>
    invoke<void>("native_voice_publish_camera", { session, options }),
  unpublishCamera: (session) => invoke<void>("native_voice_unpublish_camera", { session }),
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

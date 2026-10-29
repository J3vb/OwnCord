// The native voice backend's host bindings (`src-tauri/src/native_voice/`):
// one command per contract method and the `native-voice` event. Loaded on
// first use by the registered facade (`nativeVoice.ts`) so it stays out of
// the startup chunk on every platform — only the Linux voice path reaches it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  NativeVoice,
  NativeVoiceCameraDevice,
  NativeVoiceCameraPreview,
  NativeVoiceCameraStarted,
  NativeVoiceCameraSupport,
  NativeVoiceVideoCodecs,
  NativeToneNote,
  NativeVoiceConnected,
  NativeVoiceDevices,
  NativeMicTestEnvelope,
  NativeVoiceEnvelope,
  NativeVoiceResources,
  NativeVoiceScreenQualityResult,
  NativeVoiceScreenQualitySet,
  NativeVoiceScreenSources,
  NativeVoiceScreenStarted,
  NativeVoiceStats,
} from "../contracts/nativeVoice";

import { createLogger } from "@lib/logger";
import { invokeOrThrow } from "./nativeInvoke";

const log = createLogger("nativeVoiceService");

export const NATIVE_VOICE_EVENT = "native-voice";
export const NATIVE_MIC_TEST_EVENT = "native-voice-mic-test";
export const NATIVE_DEVICES_EVENT = "native-voice-devices";

/** Same late-resolve shape as trayStatus.ts: the host resolves the unlisten
 *  asynchronously, and an unsubscribe that lands first must still release it. */
function listenLate<T>(name: string, handler: (payload: T) => void): () => void {
  let active = true;
  let unlisten: (() => void) | null = null;
  void listen<T>(name, (e) => {
    if (active) handler(e.payload);
  })
    .then((stop) => {
      if (active) unlisten = stop;
      else stop();
    })
    .catch((err: unknown) => log.warn(`${name} listen failed`, err));
  return () => {
    active = false;
    unlisten?.();
    unlisten = null;
  };
}

/** The host rejects a quality change with `{stage, message}`; anything else
 *  (an older host, a broken IPC) changed nothing we can vouch for, so it is
 *  a refusal. */
function qualityFailure(err: unknown): NativeVoiceScreenQualityResult {
  if (typeof err === "object" && err !== null && "stage" in err && "message" in err) {
    const { stage, message } = err;
    if ((stage === "refused" || stage === "publish") && typeof message === "string") {
      return { ok: false, stage, message };
    }
  }
  return { ok: false, stage: "refused", message: err instanceof Error ? err.message : String(err) };
}

export const nativeVoice: NativeVoice = {
  setRoomKey: (key) => invokeOrThrow<void>("native_voice_set_key", { key }),
  clearRoomKey: () => invokeOrThrow<void>("native_voice_clear_key"),
  connect: (url, token, audio) =>
    invokeOrThrow<NativeVoiceConnected>("native_voice_connect", { url, token, audio }),
  disconnect: (session) =>
    invokeOrThrow<NativeVoiceResources>("native_voice_disconnect", { session }),
  setMicrophone: (session, enabled, bitrate) =>
    invokeOrThrow<void>("native_voice_set_microphone", { session, enabled, bitrate }),
  setPttGated: (session, gated) =>
    invokeOrThrow<void>("native_voice_set_ptt_gated", { session, gated }),
  async setVoiceGate(session, threshold, retune) {
    try {
      await invoke<void>("native_voice_set_voice_gate", { session, threshold, retune });
    } catch (err) {
      // The host rejects with its reason as a string; callers log it.
      throw err instanceof Error ? err : new Error(String(err));
    }
  },
  async setInputGain(session, percent) {
    try {
      await invoke<void>("native_voice_set_input_gain", { session, percent });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  },
  async setAudioProcessing(session, audio) {
    try {
      await invoke<void>("native_voice_set_audio_processing", { session, audio });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  },
  setSubscribed: (session, identity, sid, subscribed) =>
    invokeOrThrow<void>("native_voice_set_subscribed", { session, identity, sid, subscribed }),
  setVideoView: (session, identity, sid, enabled, quality) =>
    invokeOrThrow<void>("native_voice_set_video_view", {
      session,
      identity,
      sid,
      enabled,
      quality,
    }),
  setVolume: (session, identity, volume) =>
    invokeOrThrow<void>("native_voice_set_volume", { session, identity, volume }),
  setScreenshareVolume: (session, identity, volume) =>
    invokeOrThrow<void>("native_voice_set_screenshare_volume", { session, identity, volume }),
  publishCamera: (session, capture, options) =>
    invokeOrThrow<string>("native_voice_publish_camera", { session, capture, options }),
  unpublishCamera: (session, sid) =>
    invokeOrThrow<void>("native_voice_unpublish_camera", { session, sid }),
  listCameras: () => invokeOrThrow<NativeVoiceCameraDevice[]>("native_voice_list_cameras"),
  cameraSupport: () => invokeOrThrow<NativeVoiceCameraSupport>("native_voice_camera_support"),
  async videoCodecs() {
    try {
      return await invoke<NativeVoiceVideoCodecs>("native_voice_video_codecs");
    } catch {
      // A failed probe reads as no H.264 or VP9 and no decode list: the
      // picker disables them, the publish stays on VP8 and the announce
      // reports the baseline.
      return { h264: false, vp9: false, decode: [] };
    }
  },
  startCamera: (session, source, capture) =>
    invokeOrThrow<NativeVoiceCameraStarted>("native_voice_start_camera", {
      session,
      source,
      capture,
    }),
  stopCamera: (session, capture) =>
    invokeOrThrow<void>("native_voice_stop_camera", { session, capture }),
  startCameraPreview: (source, capture) =>
    invokeOrThrow<NativeVoiceCameraPreview>("native_voice_start_camera_preview", {
      source,
      capture,
    }),
  stopCameraPreview: () => invokeOrThrow<void>("native_voice_stop_camera_preview"),
  screenSources: () => invokeOrThrow<NativeVoiceScreenSources>("native_voice_screen_sources"),
  startScreen: (session, source, capture) =>
    invokeOrThrow<NativeVoiceScreenStarted>("native_voice_start_screen", {
      session,
      source,
      capture,
    }),
  publishScreen: (session, capture, options) =>
    invokeOrThrow<string>("native_voice_publish_screen", { session, capture, options }),
  async unpublishScreen(session, capture) {
    try {
      await invoke<void>("native_voice_unpublish_screen", { session, capture });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  },
  async publishScreenAudio(session, capture) {
    try {
      return await invoke<string>("native_voice_publish_screen_audio", { session, capture });
    } catch (err) {
      // The host rejects with its reason as a string; callers classify it.
      throw err instanceof Error ? err : new Error(String(err));
    }
  },
  async unpublishScreenAudio(session, sid) {
    try {
      await invoke<void>("native_voice_unpublish_screen_audio", { session, sid });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  },
  stopScreen: (session, capture) =>
    invokeOrThrow<void>("native_voice_stop_screen", { session, capture }),
  async setScreenQuality(session, capture, options, publish) {
    try {
      const set = await invoke<NativeVoiceScreenQualitySet>("native_voice_set_screen_quality", {
        session,
        capture,
        options,
        publish,
      });
      return { ok: true, ...set };
    } catch (err) {
      return qualityFailure(err);
    }
  },
  async changeCamera(session, source, capture) {
    try {
      return await invoke<NativeVoiceCameraStarted>("native_voice_change_camera", {
        session,
        source,
        capture,
      });
    } catch (err) {
      // The host rejects with its reason as a string; callers classify it.
      throw err instanceof Error ? err : new Error(String(err));
    }
  },
  async changeScreen(session, source, capture) {
    try {
      return await invoke<NativeVoiceScreenStarted>("native_voice_change_screen", {
        session,
        source,
        capture,
      });
    } catch (err) {
      // The host rejects with its reason as a string; callers classify it.
      throw err instanceof Error ? err : new Error(String(err));
    }
  },
  async getStats(session) {
    try {
      return await invoke<NativeVoiceStats>("native_voice_get_stats", { session });
    } catch (err) {
      log.debug("native stats unavailable", err);
      return null;
    }
  },
  debugInfo: () => invokeOrThrow<NativeVoiceResources>("native_voice_debug_info"),
  listDevices: () => invokeOrThrow<NativeVoiceDevices>("native_voice_list_devices"),
  setDevice: (session, kind, deviceId) =>
    invokeOrThrow<void>("native_voice_set_device", { session, kind, deviceId }),
  async startMicTest(options) {
    try {
      return await invoke<number>("native_voice_start_mic_test", { options });
    } catch (err) {
      // The host rejects with its reason as a string; callers match it.
      throw err instanceof Error ? err : new Error(String(err));
    }
  },
  async updateMicTest(test, update) {
    try {
      await invoke<void>("native_voice_update_mic_test", { test, update });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  },
  async stopMicTest(test) {
    try {
      await invoke<void>("native_voice_stop_mic_test", { test });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  },
  onMicTestEvent: (handler) => listenLate<NativeMicTestEnvelope>(NATIVE_MIC_TEST_EVENT, handler),
  watchDevices(handler) {
    // Listen first so a change that lands right after the host starts is not
    // missed; a rejected start leaves the listener (and the webview trigger)
    // in place.
    const stop = listenLate<NativeVoiceDevices>(NATIVE_DEVICES_EVENT, handler);
    void (async () => {
      try {
        await invoke<void>("native_voice_watch_devices");
      } catch (err) {
        log.warn("native device watch did not start", err);
      }
    })();
    return stop;
  },
  async playSound(notes: readonly NativeToneNote[], deviceId: string, gain: number) {
    try {
      return await invoke<number>("native_voice_play_sound", { notes, deviceId, gain });
    } catch (err) {
      log.debug("native app sound unavailable", err);
      return null;
    }
  },
  async stopSound(id: number) {
    try {
      await invoke<void>("native_voice_stop_sound", { id });
    } catch (err) {
      log.debug("native app sound stop failed", err);
    }
  },
  onEvent: (handler) => listenLate<NativeVoiceEnvelope>(NATIVE_VOICE_EVENT, handler),
};

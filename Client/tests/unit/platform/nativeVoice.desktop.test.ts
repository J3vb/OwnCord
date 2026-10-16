// Desktop binding for the NativeVoice suite: `platform/desktop`'s registered
// facade, which loads the host service lazily. Driving the facade (not the
// service) covers both late-resolve layers: the service load and the host's
// asynchronous unlisten.
import { vi } from "vitest";
import type { NativeVoice } from "../../../src/platform/contracts/nativeVoice";
import { describeNativeVoiceSuite } from "./nativeVoice.suite";

const state = vi.hoisted(() => ({
  commands: [] as Array<[string, unknown]>,
  connected: { session: 1, identity: "user-1", frames: "" },
  devices: { inputs: [], outputs: [] } as unknown,
  cameras: [] as unknown,
  support: { available: true, missing: [] } as unknown,
  camera: { capture: 0, width: 0, height: 0 },
  preview: { width: 0, height: 0, frames: "" },
  cameraSid: "",
  screen: { sources: null as unknown, started: null as unknown, sid: "" },
  changeRefusal: null as string | null,
  micTest: 0,
  micTestRefusal: null as string | null,
  stats: null as unknown,
  statsFails: false,
  watchFails: false,
  handlers: new Map<string, Set<(e: { payload: unknown }) => void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, payload?: unknown) => {
    state.commands.push([cmd, payload]);
    if (cmd === "native_voice_connect") return Promise.resolve(state.connected);
    if (cmd === "native_voice_list_devices") return Promise.resolve(state.devices);
    if (cmd === "native_voice_list_cameras") return Promise.resolve(state.cameras);
    if (cmd === "native_voice_camera_support") return Promise.resolve(state.support);
    if (cmd === "native_voice_start_camera") return Promise.resolve(state.camera);
    if (cmd === "native_voice_start_camera_preview") return Promise.resolve(state.preview);
    if (cmd === "native_voice_publish_camera") return Promise.resolve(state.cameraSid);
    if (cmd === "native_voice_screen_sources") return Promise.resolve(state.screen.sources);
    if (cmd === "native_voice_start_screen") return Promise.resolve(state.screen.started);
    if (cmd === "native_voice_publish_screen") return Promise.resolve(state.screen.sid);
    if (cmd === "native_voice_get_stats") {
      // Tauri rejects with the command's error string.
      return state.statsFails
        ? Promise.reject("native voice stats timed out")
        : Promise.resolve(state.stats);
    }
    if (cmd === "native_voice_watch_devices") {
      return state.watchFails ? Promise.reject("no sound server") : Promise.resolve();
    }
    if (cmd === "native_voice_start_mic_test") {
      const refusal = state.micTestRefusal;
      state.micTestRefusal = null;
      return refusal === null ? Promise.resolve(state.micTest) : Promise.reject(refusal);
    }
    if (cmd === "native_voice_change_screen") {
      const refusal = state.changeRefusal;
      state.changeRefusal = null;
      // Tauri rejects with the command's error string.
      return refusal === null ? Promise.resolve(state.screen.started) : Promise.reject(refusal);
    }
    return Promise.resolve();
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    const set = state.handlers.get(event) ?? new Set();
    set.add(handler);
    state.handlers.set(event, set);
    return Promise.resolve(() => set.delete(handler));
  },
}));

describeNativeVoiceSuite(async () => {
  state.commands.length = 0;
  state.handlers.clear();
  state.stats = null;
  state.statsFails = false;
  state.watchFails = false;
  const mod = await import("../../../src/platform/desktop/nativeVoice");
  const desktopBinding: NativeVoice = mod.nativeVoice;
  return {
    subject: desktopBinding,
    native: {
      connectsAs(session, identity, frames) {
        state.connected = { session, identity, frames };
      },
      publishesCameraAs(sid) {
        state.cameraSid = sid;
      },
      hasCameras(devices, started, preview) {
        state.cameras = devices;
        state.camera = started;
        state.preview = preview;
      },
      hasDevices(devices) {
        state.devices = devices;
      },
      sharesScreenAs(sources, started, sid) {
        state.screen = { sources, started, sid };
      },
      refusesScreenChange(reason) {
        state.changeRefusal = reason;
      },
      startsMicTestAs(test) {
        state.micTest = test;
      },
      refusesMicTest(reason) {
        state.micTestRefusal = reason;
      },
      reportsStats(reply) {
        state.stats = reply;
        state.statsFails = false;
      },
      failsStats() {
        state.statsFails = true;
      },
      refusesDeviceWatch() {
        state.watchFails = true;
      },
      commands: () => state.commands,
      async emits(envelope) {
        // Let the facade's service load and a registering subscription
        // settle first: the same module promise the facade awaits.
        await import("../../../src/platform/desktop/nativeVoiceService");
        for (let i = 0; i < 4; i++) await Promise.resolve();
        for (const handler of state.handlers.get("native-voice") ?? [])
          handler({ payload: envelope });
      },
      async emitsDevices(devices) {
        await import("../../../src/platform/desktop/nativeVoiceService");
        for (let i = 0; i < 4; i++) await Promise.resolve();
        for (const handler of state.handlers.get("native-voice-devices") ?? [])
          handler({ payload: devices });
      },
      async emitsMicTest(envelope) {
        await import("../../../src/platform/desktop/nativeVoiceService");
        for (let i = 0; i < 4; i++) await Promise.resolve();
        for (const handler of state.handlers.get("native-voice-mic-test") ?? [])
          handler({ payload: envelope });
      },
    },
  };
});

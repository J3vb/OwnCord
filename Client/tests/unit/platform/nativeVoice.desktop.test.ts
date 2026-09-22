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
  cameraSid: "",
  handlers: new Map<string, Set<(e: { payload: unknown }) => void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, payload?: unknown) => {
    state.commands.push([cmd, payload]);
    if (cmd === "native_voice_connect") return Promise.resolve(state.connected);
    if (cmd === "native_voice_list_devices") return Promise.resolve(state.devices);
    if (cmd === "native_voice_publish_camera") return Promise.resolve(state.cameraSid);
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
      hasDevices(devices) {
        state.devices = devices;
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
    },
  };
});

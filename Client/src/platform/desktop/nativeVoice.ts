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
  setMicrophone: async (session, enabled) => (await service()).setMicrophone(session, enabled),
  setSubscribed: async (session, identity, sid, subscribed) =>
    (await service()).setSubscribed(session, identity, sid, subscribed),
  setVolume: async (session, identity, volume) =>
    (await service()).setVolume(session, identity, volume),
  publishCamera: async (session, options) => (await service()).publishCamera(session, options),
  unpublishCamera: async (session, sid) => (await service()).unpublishCamera(session, sid),
  debugInfo: async () => (await service()).debugInfo(),
  listDevices: async () => (await service()).listDevices(),
  setDevice: async (session, kind, deviceId) =>
    (await service()).setDevice(session, kind, deviceId),
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

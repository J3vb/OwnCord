// The global voice shortcuts' native host: `shortcuts.rs`'s polling commands
// and its `voice-shortcut` event, plus the tray's own Mute/Deafen items (which
// emit the same event from `tray.rs`). The Wayland portal commands
// (`global_keys_status`, `global_keys_portal_bind`,
// `global_keys_portal_configure`) and the `global-keys-changed` event are here
// too; each invoke turns a rejection into a typed result (status reads as
// `none`, bind and configure reject with a `GlobalKeysError`) and never
// reaches a caller unhandled. The event API is a static import, the
// same as the sibling `trayStatus.ts`; the polling commands go through
// `nativeInvoke.ts` and reject with a `NativeCallError`.
import { listen } from "@tauri-apps/api/event";
import { invokeOrThrow } from "./nativeInvoke";
import type { GlobalKeysStatus, GlobalShortcuts } from "../contracts/globalShortcuts";

// The portal commands themselves (the invokes in try/catch, the payload
// narrowing and the typed error) live in `globalKeysPortal.ts`, imported where
// they are used, so they stay out of the startup chunk.

/** An owned `listen()`: the callback stops once unsubscribed, and a listener
 *  that registers after the unsubscribe is released at once (late-unlisten). */
function subscribe(
  event: string,
  onPayload: (payload: unknown, active: () => boolean) => void,
): () => void {
  let active = true;
  let unlisten: (() => void) | null = null;
  void listen<unknown>(event, (e) => {
    if (active) onPayload(e.payload, () => active);
  })
    .then((stop) => {
      if (active) unlisten = stop;
      else stop();
    })
    .catch(() => {
      // No Tauri event bridge (a browser/test host): nothing will arrive.
    });
  return () => {
    active = false;
    unlisten?.();
  };
}

export const globalShortcuts: GlobalShortcuts = {
  async start() {
    await invokeOrThrow("voice_shortcuts_start");
  },
  async supported() {
    return invokeOrThrow<boolean>("voice_shortcuts_supported");
  },
  async setKeys(keys) {
    await invokeOrThrow("voice_shortcuts_set_keys", {
      muteVk: keys.muteVk,
      deafenVk: keys.deafenVk,
    });
  },
  async status() {
    try {
      const { portalStatus } = await import("./globalKeysPortal");
      return await portalStatus();
    } catch {
      return {
        backend: "none",
        portalVersion: 0,
        triggers: { ptt: null, mute: null, deafen: null },
        canConfigure: false,
        triggersUnnamed: false,
        sessionRefused: false,
      };
    }
  },
  async bindPortal(keys) {
    const { portalBind } = await import("./globalKeysPortal");
    return portalBind(keys);
  },
  async configurePortal() {
    const { portalConfigure } = await import("./globalKeysPortal");
    return portalConfigure();
  },
  onStatusChange(handler: (status: GlobalKeysStatus) => void): () => void {
    return subscribe("global-keys-changed", (payload, active) => {
      import("./globalKeysPortal")
        .then(({ parseStatus }) => {
          if (active()) handler(parseStatus(payload));
        })
        .catch(() => {});
    });
  },
  onShortcut(handler: (action: "mute" | "deafen") => void): () => void {
    return subscribe("voice-shortcut", (payload) => {
      if (payload === "mute" || payload === "deafen") handler(payload);
    });
  },
};

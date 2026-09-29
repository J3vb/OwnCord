// The global voice shortcuts' native host: `shortcuts.rs`'s polling commands
// and its `voice-shortcut` event, plus the tray's own Mute/Deafen items (which
// emit the same event from `tray.rs`). The event API is a static import, the
// same as the sibling `trayStatus.ts`; the core API is dynamic because the
// registry is reachable from the entry and `invoke` was not a startup
// dependency.
import { listen } from "@tauri-apps/api/event";
import type { GlobalShortcuts } from "../contracts/globalShortcuts";

export const globalShortcuts: GlobalShortcuts = {
  async start() {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("voice_shortcuts_start");
  },
  async supported() {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<boolean>("voice_shortcuts_supported");
  },
  async setKeys(keys) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("voice_shortcuts_set_keys", { muteVk: keys.muteVk, deafenVk: keys.deafenVk });
  },
  onShortcut(handler: (action: "mute" | "deafen") => void): () => void {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<string>("voice-shortcut", (e) => {
      if (!active) return;
      if (e.payload === "mute" || e.payload === "deafen") handler(e.payload);
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
  },
};

// The tray's presence picks: the native `status-change` event
// (`src-tauri/src/tray.rs`). Lifted from `main.ts` (B7-5), which keeps the
// payload check and the legacy "offline" → "invisible" mapping. The event API
// was already a static import of the entry, so it stays one here.
import { listen } from "@tauri-apps/api/event";
import type { TrayStatus } from "../contracts/trayStatus";

export const trayStatus: TrayStatus = {
  onStatusChange(handler: (status: string) => void): () => void {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<string>("status-change", (e) => {
      if (active) handler(e.payload);
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  },
};

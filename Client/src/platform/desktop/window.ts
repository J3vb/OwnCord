// The native window operations `lib/prefs/windowState.ts`'s off-screen guard needs.
// Lifted verbatim; the guard itself is behaviour and stays there.
//
// The window API stays a dynamic `import()`: it is its own lazy chunk today,
// and this registry is statically reachable from the entry.
import type { WindowControl } from "../contracts/window";
import { createLogger } from "@lib/logger";

const log = createLogger("window");

export const windowControl: WindowControl = {
  available: true,
  async isMaximized() {
    return (await import("@tauri-apps/api/window")).getCurrentWindow().isMaximized();
  },
  async availableMonitors() {
    return (await import("@tauri-apps/api/window")).availableMonitors();
  },
  async outerPosition() {
    return (await import("@tauri-apps/api/window")).getCurrentWindow().outerPosition();
  },
  async outerSize() {
    return (await import("@tauri-apps/api/window")).getCurrentWindow().outerSize();
  },
  async center() {
    await (await import("@tauri-apps/api/window")).getCurrentWindow().center();
  },
  async setFullscreen(on: boolean, label?: string) {
    const { getCurrentWindow, Window } = await import("@tauri-apps/api/window");
    const win = label === undefined ? getCurrentWindow() : await Window.getByLabel(label);
    await win?.setFullscreen(on);
  },
  async setZoom(scale: number) {
    try {
      await (await import("@tauri-apps/api/webview")).getCurrentWebview().setZoom(scale);
      return true;
    } catch (err) {
      log.warn("webview zoom failed", { error: String(err) });
      return false;
    }
  },
};

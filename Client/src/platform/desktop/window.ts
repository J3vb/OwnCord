// The native window operations `lib/window-state.ts`'s off-screen guard needs.
// Lifted verbatim (B7-5); the guard itself is behaviour and stays there.
//
// The window API stays a dynamic `import()`: it is its own lazy chunk today,
// and this registry is statically reachable from the entry.
import type { WindowControl } from "../contracts/window";

export const windowControl: WindowControl = {
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
};

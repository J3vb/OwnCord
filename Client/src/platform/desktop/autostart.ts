// Launch on login, through the native autostart plugin. Lifted verbatim from
// `settings/AdvancedTab.ts`'s "Launch on Login" row; the row's
// read-back race guard is behaviour and stays in the tab.
//
// The plugin stays a dynamic `import()`: it is not part of the startup chunk
// today, and this registry is statically reachable from the entry.
import type { Autostart } from "../contracts/updater";
import { tryInvoke } from "./nativeInvoke";

export const autostart: Autostart = {
  available: true,
  async isEnabled(): Promise<boolean> {
    const { isEnabled } = await import("@tauri-apps/plugin-autostart");
    return isEnabled();
  },
  async enable(): Promise<void> {
    const { enable } = await import("@tauri-apps/plugin-autostart");
    await enable();
    // The plugin writes the Linux login entry with the app's path unquoted:
    // the host quotes it (a no-op elsewhere). The entry exists either way,
    // and the host retries at the next start, so a failure is not the toggle's.
    await tryInvoke("autostart_fix_entry");
  },
  async disable(): Promise<void> {
    const { disable } = await import("@tauri-apps/plugin-autostart");
    await disable();
  },
};

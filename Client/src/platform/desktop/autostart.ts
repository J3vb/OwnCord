// Launch on login, through the native autostart plugin. Lifted verbatim from
// `settings/AdvancedTab.ts`'s "Launch on Login" row (B7-5); the row's
// read-back race guard (OC-0141) is behaviour and stays in the tab.
//
// The plugin stays a dynamic `import()`: it is not part of the startup chunk
// today, and this registry is statically reachable from the entry.
import type { Autostart } from "../contracts/updater";

export const autostart: Autostart = {
  async isEnabled(): Promise<boolean> {
    const { isEnabled } = await import("@tauri-apps/plugin-autostart");
    return isEnabled();
  },
  async enable(): Promise<void> {
    const { enable } = await import("@tauri-apps/plugin-autostart");
    await enable();
  },
  async disable(): Promise<void> {
    const { disable } = await import("@tauri-apps/plugin-autostart");
    await disable();
  },
};

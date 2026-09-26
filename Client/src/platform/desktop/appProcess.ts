// The app process. Lifted verbatim from `settings/AdvancedTab.ts`'s "Clear &
// Restart" (B7-5).
//
// The process plugin stays a dynamic `import()`: it is not part of the
// startup chunk today, and this registry is statically reachable from the
// entry.
import type { AppProcess } from "../contracts/appProcess";

export const appProcess: AppProcess = {
  async relaunch(): Promise<void> {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
};

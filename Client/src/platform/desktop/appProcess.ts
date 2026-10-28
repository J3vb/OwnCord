// The app process. Lifted verbatim from `settings/AdvancedTab.ts`'s "Clear &
// Restart" (B7-5).
//
// The process plugin stays a dynamic `import()`: it is not part of the
// startup chunk today, and this registry is statically reachable from the
// entry.
import { invoke } from "@tauri-apps/api/core";
import { invokeOrThrow } from "./nativeInvoke";
import type { AppProcess } from "../contracts/appProcess";

export const appProcess: AppProcess = {
  async relaunch(): Promise<void> {
    // The restart copies this process's `--minimized`; ask the host to show
    // the window next time. A failure only risks a hidden restart.
    try {
      await invoke("show_next_launch");
    } catch {
      // The relaunch itself still goes ahead.
    }
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
  async reportReady(): Promise<void> {
    await invokeOrThrow("frontend_ready");
  },
};

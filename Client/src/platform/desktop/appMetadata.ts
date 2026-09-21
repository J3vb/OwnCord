// The native app metadata. Lifted verbatim from `settings/LogsTab.ts` (B7-5).
//
// The app API stays a dynamic `import()`: it is its own lazy chunk today, and
// this registry is statically reachable from the entry.
import type { AppMetadata } from "../contracts/appMetadata";

export const appMetadata: AppMetadata = {
  async getVersion(): Promise<string> {
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  },
};

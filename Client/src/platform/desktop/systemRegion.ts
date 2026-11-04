// The OS regional format (`src-tauri/src/region.rs`), read once at startup.
import { isAndroidHost } from "@lib/hostPlatform";
import { tryInvoke } from "./nativeInvoke";
import type { SystemRegion } from "../contracts/systemRegion";

export const systemRegion: SystemRegion = {
  async localeTag(): Promise<string | null> {
    // The phone's webview already reports the system language and region.
    if (isAndroidHost()) return null;
    // A failed read leaves dates on the display language; nothing to report.
    const result = await tryInvoke<string | null>("system_region_locale");
    return result.ok ? result.value : null;
  },
};

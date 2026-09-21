// The native shell opener: opens a URL in the user's default browser. Lifted
// verbatim from `lib/admin-panel.ts` and `main.ts`'s external-link listener
// (B7-5). The plugin was already a static import of the entry, so it stays
// one here.
import { openUrl } from "@tauri-apps/plugin-opener";
import type { UrlOpener } from "../contracts/opener";

export const urlOpener: UrlOpener = {
  async open(url: string): Promise<void> {
    await openUrl(url);
  },
};

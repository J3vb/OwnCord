// The native shell opener: opens a URL in the user's default browser. Lifted
// verbatim from `lib/admin-panel.ts` and `main.ts`'s external-link listener
// (B7-5), then moved behind the `open_external_url` command: the Linux
// AppImage leaks its bundled libraries into whatever the plugin launches, so
// the Rust side opens the URL with a cleaned environment (external_open.rs).
import { invoke } from "@tauri-apps/api/core";
import type { UrlOpener } from "../contracts/opener";

export const urlOpener: UrlOpener = {
  async open(url: string): Promise<void> {
    try {
      await invoke("open_external_url", { url });
    } catch (err) {
      // The command rejects with a string; callers expect an Error.
      throw err instanceof Error ? err : new Error(String(err));
    }
  },
};

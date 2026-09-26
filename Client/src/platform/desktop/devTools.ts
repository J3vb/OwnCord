// Opens the webview's developer tools. Lifted verbatim from the two inline
// call sites, `main.ts`'s dev-build shortcut and `settings/AdvancedTab.ts`'s
// button (B7-5).
import { invoke } from "@tauri-apps/api/core";
import type { DevTools } from "../contracts/devTools";

export const devTools: DevTools = {
  async open(): Promise<void> {
    await invoke("open_devtools");
  },
};

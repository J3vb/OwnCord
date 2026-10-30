// Opens the webview's developer tools. Lifted verbatim from the two inline
// call sites, `main.ts`'s dev-build shortcut and `settings/AdvancedTab.ts`'s
// button.
import { invokeOrThrow } from "./nativeInvoke";
import type { DevTools } from "../contracts/devTools";

export const devTools: DevTools = {
  available: true,
  async open(): Promise<void> {
    await invokeOrThrow("open_devtools");
  },
};

/**
 * The webview's developer tools. Both call sites (`main.ts`'s dev-build
 * shortcut, `settings/AdvancedTab.ts`'s button) invoked the native command
 * inline; B7-5 lifted it in place, pinned it with `devTools.suite.ts`, then
 * moved it to `platform/desktop/devTools.ts`.
 */
export interface DevTools {
  open(): Promise<void>;
}

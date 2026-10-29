/**
 * The webview's developer tools. Both call sites (`main.ts`'s dev-build
 * shortcut, `settings/AdvancedTab.ts`'s button) invoked the native command
 * inline; the platform seam lifted it in place, pinned it with `devTools.suite.ts`, then
 * moved it to `platform/desktop/devTools.ts`.
 */
export interface DevTools {
  /** Whether this platform can do this at all. False on the web build, where a
   *  Settings control for it is not drawn rather than drawn to fail. */
  readonly available: boolean;
  open(): Promise<void>;
}

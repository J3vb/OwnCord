/**
 * No-seam: both call sites (`main.ts:86-89`, `settings/AdvancedTab.ts:70`)
 * invoke the native command inline inside an event listener — neither is
 * itself the seam function. The suite lands with the seam in B7-5.
 */
export interface DevTools {
  open(): Promise<void>;
}

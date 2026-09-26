/**
 * The window operations `lib/window-state.ts`'s off-screen guard needs. The
 * seam is the operations, not the guard: `initWindowState` is a
 * fire-and-forget orchestrator over them, and it stays in `lib/` as behaviour.
 * B7-5 lifted the operations in place, pinned them with `window.suite.ts`,
 * then moved them to `platform/desktop/window.ts`.
 *
 * `notifications.ts`'s focus check (`isWindowFocused`) is `document.hasFocus()`
 * — a synchronous DOM API with no native dependency — so it is not part of
 * this contract at all; it needs no platform adapter.
 */

/** A monitor's position and size, physical pixels. */
export interface MonitorRect {
  readonly position: { readonly x: number; readonly y: number };
  readonly size: { readonly width: number; readonly height: number };
}

export interface WindowControl {
  isMaximized(): Promise<boolean>;
  availableMonitors(): Promise<readonly MonitorRect[]>;
  outerPosition(): Promise<{ readonly x: number; readonly y: number }>;
  outerSize(): Promise<{ readonly width: number; readonly height: number }>;
  center(): Promise<void>;
}

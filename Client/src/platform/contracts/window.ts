/**
 * No-seam: `lib/window-state.ts` exports only `initWindowState`, a
 * fire-and-forget orchestrator that calls several native window operations
 * internally. It is not an exported seam function on its own, so there is
 * nothing to bind a legacy suite against yet — it lands with the seam in
 * B7-5.
 *
 * `notifications.ts`'s focus check (`isWindowFocused`) is `document.hasFocus()`
 * — a synchronous DOM API with no native dependency — so it is not part of
 * this contract at all; it needs no platform adapter.
 */

/** Re-declared, structurally identical to `WindowRect` (`lib/window-state.ts`). */
export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

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

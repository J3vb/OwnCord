/**
 * No-seam: `lib/window-state.ts` exports only `initWindowState`, a
 * fire-and-forget orchestrator that calls several native window operations
 * internally; the focus check in `lib/notifications.ts` is a private
 * function. Neither is an exported seam function on its own, so there is
 * nothing to bind a legacy suite against yet — it lands with the seam in
 * B7-5.
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
  /** Whether the app window currently has OS input focus. */
  isFocused(): Promise<boolean>;
}

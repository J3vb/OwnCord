/**
 * Global toast helper — eliminates verbose `toast?.show()` plumbing.
 *
 * Call `initToast(container)` once at app startup (MainPage mount).
 * Then import `showToast` anywhere to display notifications.
 */

import type { ToastContainer, ToastType } from "@components/Toast";

let instance: ToastContainer | null = null;

/**
 * Register the app-wide ToastContainer. Called once during MainPage mount.
 * Subsequent calls replace the previous instance (for hot-reload safety).
 */
export function initToast(container: ToastContainer): void {
  instance = container;
}

/**
 * Clear the registered instance (called on MainPage destroy).
 */
export function teardownToast(): void {
  instance = null;
}

/**
 * Show a toast notification globally. No-ops silently if the toast
 * container has not been initialized yet.
 */
export function showToast(
  message: string,
  type: ToastType = "info",
  durationMs?: number,
): void {
  instance?.show(message, type, durationMs);
}

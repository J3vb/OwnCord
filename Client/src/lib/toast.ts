/**
 * Global toast helper — eliminates verbose `toast?.show()` plumbing.
 *
 * Call `initToast(container)` once at app startup (MainPage mount).
 * Then import `showToast` anywhere to display notifications.
 */

import type { ToastContainer, ToastType } from "@components/Toast";
import type { PartialSuccessResponse } from "@lib/types";

let instance: ToastContainer | null = null;

/** A partial-success warning tells the user to go and revoke sessions by
 *  hand, which the default 5 s would not leave time to read. */
const PARTIAL_SUCCESS_TOAST_MS = 12_000;

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
export function showToast(message: string, type: ToastType = "info", durationMs?: number): void {
  instance?.show(message, type, durationMs);
}

/**
 * Surface the outcome of a credential change (password, 2FA on or off). The
 * server answers those with 204 on full success and with 200 plus a
 * `warning` when the change committed but the other sessions could not be
 * revoked — a partial success the user has to act on, which an unqualified
 * green toast used to hide (OC-0314). The warning wins whenever it is
 * present.
 */
export function showChangeOutcomeToast(
  outcome: PartialSuccessResponse | undefined,
  successMessage: string,
): void {
  const warning = outcome?.warning;
  if (warning !== undefined && warning !== "") {
    showToast(warning, "warning", PARTIAL_SUCCESS_TOAST_MS);
    return;
  }
  showToast(successMessage, "success");
}

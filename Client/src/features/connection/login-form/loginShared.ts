/** Constants and small helpers the login form modules share. */
import { ApiClientError } from "@lib/api";
import type { RegistrationMode } from "@lib/types";
import { connectText } from "../../../i18n/connect";
import { RestErrorCode } from "@lib/protocolTypes";
import type { FormState } from "../LoginForm";

/** A connect-form field a validation error can be tied to. */
export type FieldId = "host" | "username" | "password" | "invite";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_PASSWORD_LENGTH = 8;

// The password box shows this when a saved password exists. It is never sent
// anywhere: submission branches on `usingSavedPassword`, never on the field's
// text, so this string can never be mistaken for a real password.
export const SAVED_PASSWORD_PLACEHOLDER = "•".repeat(12);

/**
 * What the 2FA box accepts: a six-digit authenticator code, or an emergency
 * recovery code (`XXXXX-XXXXX`, case-insensitive, separator optional). The
 * server routes the one `code` field by this same shape.
 */
export const TOTP_OR_RECOVERY_CODE = /^(?:\d{6}|[A-Za-z0-9]{5}-?[A-Za-z0-9]{5})$/;

/**
 * Copy shown in the register notice for a mode, or null when no notice
 * applies. `closed` states why register is refused; `approval` states the
 * pending-approval fact up front, not only after a 202.
 */
export function registrationNoticeText(mode: RegistrationMode | null): string | null {
  if (mode === "closed") {
    return connectText("registration.closedNotice");
  }
  if (mode === "approval") {
    return connectText("registration.approvalNotice");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** How long a login keeps retrying a busy server before it gives up (P5-S02). */
export const AUTH_BUSY_RETRY_BUDGET_MS = 70_000;

/** The shortest wait before a retry, whatever Retry-After says (the
 *  saved-password relay sends none). The login route allows 5 attempts per IP
 *  per minute and refused ones count, so attempts at least 15 s apart keep
 *  one client to 4 in any minute. */
export const AUTH_BUSY_MIN_RETRY_MS = 15_000;

/** Up to this much is added to each wait, so a burst of refused clients
 *  does not come back in lockstep. */
export const AUTH_BUSY_JITTER_MS = 1_000;

/** The server's password-check queue was full: a refusal worth retrying. A
 *  per-IP RATE_LIMITED is not — retrying only spends the window again. */
export function isAuthBusy(err: unknown): err is ApiClientError {
  return err instanceof ApiClientError && err.code === RestErrorCode.AUTH_BUSY;
}

export function isBusy(state: FormState): boolean {
  return state === "loading" || state === "connecting" || state === "auto-connecting";
}

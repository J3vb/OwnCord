/** The auth slice: each server sentence and the connect catalog key its copy comes from. */
import type { connectText } from "../../src/i18n/connect";

export type AuthSliceKey = Parameters<typeof connectText>[0];

export const AUTH_SLICE: ReadonlyArray<readonly [string, AuthSliceKey]> = [
  ["account temporarily locked due to too many failed attempts", "error.accountLocked"],
  ["recovery temporarily locked due to too many failed attempts", "error.recoveryLocked"],
  ["too many failed attempts, try again later", "error.tooManyAttempts"],
  ["registration queue is full, try again later", "error.registrationQueueFull"],
  ["too many registrations from this address, try again later", "error.registrationRateLimited"],
  ["too many authentication attempts in progress, try again later", "error.authBusy"],
  ["too many recovery credentials issued; try again later", "error.recoveryCredentialBudget"],
  ["login temporarily unavailable", "error.loginUnavailable"],
  ["failed to load authentication policy", "error.couldNotComplete"],
  ["failed to process registration", "error.couldNotComplete"],
  ["failed to load registration policy", "error.registrationUnavailable"],
  ["registration failed — please try again", "error.registrationFailed"],
  ["failed to create session", "error.sessionFailed"],
  ["registration succeeded but user fetch failed", "error.registeredSignInFailed"],
  ["failed to start two-factor challenge", "error.totpUnavailable"],
  ["failed to verify two-factor code", "error.totpUnavailable"],
  ["two-factor verification temporarily unavailable", "error.totpUnavailable"],
  ["failed to logout", "error.logoutFailed"],
  ["failed to delete account", "error.deleteAccountFailed"],
  ["failed to generate two-factor secret", "error.totpEnableFailed"],
  ["failed to stage two-factor enrolment", "error.totpEnableFailed"],
  ["failed to enable two-factor authentication", "error.totpEnableFailed"],
  ["failed to disable two-factor authentication", "error.totpDisableFailed"],
  ["failed to issue recovery codes", "error.recoveryCodesFailed"],
  ["recovery failed — please try again", "error.recoveryFailed"],
  ["failed to issue the recovery kit", "error.recoveryKitFailed"],
  ["failed to issue the recovery credential", "error.recoveryCredentialFailed"],
];

import { defineCatalog } from "./format";

/**
 * Account recovery copy (B9-18). Only the lazily loaded recovery overlay reads
 * it, so it stays out of connect.ts and the startup chunk.
 */
export const recoverText = defineCatalog("recover", {
  "common.cancel": "Cancel",

  "recover.title": "Account Recovery",
  "recover.description":
    "Sign back in without your password or two-factor device. This sets a new password and signs out every other device.",
  "recover.usernameLabel": "Username",
  "recover.secretLabel": "Recovery kit secret or a recovery credential from your server owner",
  "recover.passwordLabel": "New password",
  "recover.submit": "Recover account",
  "recover.submitting": "Recovering…",
  "recover.secretRequired": "Enter your recovery kit secret or recovery credential.",
  "recover.passwordTooShort": "New password must be at least {min} characters.",
  "recover.failed": "Recovery failed.",
});

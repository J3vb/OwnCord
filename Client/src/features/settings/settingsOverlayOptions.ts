/** The host callbacks and optional tabs the Settings overlay is built with. */

import type { PartialSuccessResponse, UserStatus } from "@lib/types";
import type {
  OwnApiToken,
  RecoveryKitIssue,
  RecoveryKitStatus,
  RevokeAllSessionsResponse,
  SessionInfo,
} from "@lib/api";

export interface SettingsOverlayOptions {
  onClose(): void;
  /** Where focus goes on close when the opener is gone or cannot take focus. */
  fallbackFocus?(): HTMLElement | null;
  /**
   * Change the password, and revoke every API token of the account too when
   * `revokeApiTokens` is set. Resolves with the server's partial-success body
   * when the password changed but the other sessions or tokens could not be
   * revoked (its `warning` is the instruction the form must keep showing), or
   * with `undefined` on a clean success.
   */
  onChangePassword(
    oldPassword: string,
    newPassword: string,
    revokeApiTokens: boolean,
  ): Promise<PartialSuccessResponse | undefined>;
  /**
   * Patch the signed-in user's profile. Every field is optional and omitted
   * means "leave unchanged"; an empty string clears the nullable ones, which
   * is how the API itself distinguishes the two.
   */
  onUpdateProfile(patch: {
    username?: string;
    display_name?: string;
    about?: string;
    /** `#rrggbb`; "" clears. Sent only on a server with `profile_banners`. */
    banner_color?: string;
  }): Promise<void>;
  /** Upload an avatar image. Resolves with the URL the server stored. */
  onUploadAvatar(file: File): Promise<string>;
  /** Remove the avatar (3C-7a). Resolves once the server has cleared it. */
  onRemoveAvatar(): Promise<void>;
  /** Upload a cropped banner image. Resolves with the stored URL.
   *  Omitted: no banner upload control. */
  onUploadBanner?(file: File): Promise<string>;
  /** Remove the banner image. Omitted: no remove control. */
  onRemoveBanner?(): Promise<void>;
  onLogout(): void;
  onDeleteAccount(password: string): Promise<void>;
  /** The server-default retention sentence for the Account tab, or null when
   *  the server did not report one. */
  getRetentionNotice?(): string | null;
  onStatusChange(status: UserStatus): void;
  onEnableTotp(password: string): Promise<{ qr_uri: string; backup_codes: string[] }>;
  onConfirmTotp(password: string, code: string): Promise<void>;
  onDisableTotp(password: string): Promise<void>;
  /** Re-read the 2FA state from GET /users/me, the only response that
   *  carries it, and put it in the auth store. */
  onRefreshTotpStatus(): Promise<void>;
  /** Replace the emergency recovery codes (password-confirmed); resolves with
   *  the new set, which the tab shows once and never keeps. */
  onRegenerateRecoveryCodes(password: string): Promise<string[]>;
  /** Issue or replace the recovery kit (password-confirmed). The secret in
   *  the result is shown once and never kept. */
  onEnrolRecoveryKit(password: string): Promise<RecoveryKitIssue>;
  onGetRecoveryKitStatus(): Promise<RecoveryKitStatus>;
  /** List the account's signed-in devices (GET /users/me/sessions). */
  onListSessions(): Promise<readonly SessionInfo[]>;
  /** Sign one device out; it can no longer connect. */
  onRevokeSession(id: number): Promise<void>;
  /** Sign out every device, this one included. The page clears local auth
   *  when the response reports the current session revoked. */
  onRevokeAllSessions(): Promise<RevokeAllSessionsResponse>;
  /** The account's live API tokens (GET /users/me/api-tokens). Omitted: no
   *  token list and no "also revoke API tokens" option. */
  onListApiTokens?(): Promise<readonly OwnApiToken[]>;
  /** Revoke one of the account's API tokens; it stops working at once. */
  onRevokeApiToken?(id: number): Promise<void>;
  /** When false, the Account tab is hidden (e.g. on the connect page). Defaults to true. */
  isAuthenticated?: boolean;
  /** Builds the Safety tab. Absent until its feature ships, and then no tab shows. */
  safetyTab?: (signal: AbortSignal) => HTMLDivElement;
  /** Builds the My uploads tab. Absent when there is no signed-in server to ask, and then no tab shows. */
  myUploadsTab?: (signal: AbortSignal) => HTMLDivElement;
}

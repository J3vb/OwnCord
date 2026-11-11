/**
 * The settings overlay's options before sign-in: account actions are no-ops or
 * reject with "not authenticated", and closing clears the open flag.
 */
import { closeSettings } from "@stores/ui.store";
import type { createSettingsOverlay } from "../settings/SettingsOverlay";
import { connectText } from "../../i18n/connect";

type SettingsOverlayOptions = Parameters<typeof createSettingsOverlay>[0];

/** Account actions offered by the settings overlay before sign-in. */
const notAuthenticated = (): Promise<never> =>
  Promise.reject(new Error(connectText("settings.notAuthenticated")));

export function preAuthSettingsOptions(): SettingsOverlayOptions {
  return {
    isAuthenticated: false,
    onClose: () => closeSettings(),
    onChangePassword: () => Promise.resolve(undefined),
    onUpdateProfile: () => Promise.resolve(),
    onUploadAvatar: notAuthenticated,
    onRemoveAvatar: notAuthenticated,
    onLogout: () => {},
    onDeleteAccount: () => Promise.resolve(),
    onStatusChange: () => {},
    onEnableTotp: notAuthenticated,
    onConfirmTotp: notAuthenticated,
    onDisableTotp: notAuthenticated,
    onRefreshTotpStatus: () => Promise.resolve(),
    onRegenerateRecoveryCodes: notAuthenticated,
    onEnrolRecoveryKit: notAuthenticated,
    onGetRecoveryKitStatus: notAuthenticated,
    onListSessions: () => Promise.resolve([]),
    onRevokeSession: notAuthenticated,
    onRevokeAllSessions: notAuthenticated,
  };
}

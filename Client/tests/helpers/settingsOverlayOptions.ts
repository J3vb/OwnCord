import { vi } from "vitest";
import type { SettingsOverlayOptions } from "../../src/features/settings/SettingsOverlay";

/** A fresh set of overlay callbacks; every spy is new on each call. */
export function baseOptions() {
  return {
    onClose: vi.fn(),
    onChangePassword: vi.fn().mockResolvedValue(undefined),
    onUpdateProfile: vi.fn().mockResolvedValue(undefined),
    onUploadAvatar: vi.fn().mockResolvedValue("/api/v1/files/test"),
    onRemoveAvatar: vi.fn().mockResolvedValue(undefined),
    onLogout: vi.fn(),
    onDeleteAccount: vi.fn().mockResolvedValue(undefined),
    onStatusChange: vi.fn(),
    onEnableTotp: vi.fn().mockResolvedValue({ qr_uri: "otpauth://test", backup_codes: [] }),
    onConfirmTotp: vi.fn().mockResolvedValue(undefined),
    onDisableTotp: vi.fn().mockResolvedValue(undefined),
    onRefreshTotpStatus: vi.fn().mockResolvedValue(undefined),
    onRegenerateRecoveryCodes: vi.fn().mockResolvedValue([]),
    onEnrolRecoveryKit: vi.fn().mockResolvedValue({ created_at: "" }),
    onGetRecoveryKitStatus: vi.fn().mockResolvedValue({ enrolled: false, used_at: null }),
    onListSessions: vi.fn().mockResolvedValue([]),
    onRevokeSession: vi.fn().mockResolvedValue(undefined),
    onRevokeAllSessions: vi
      .fn()
      .mockResolvedValue({ sessions_revoked: 0, current_session_revoked: false }),
  };
}

export function makeOverlayOptions(
  overrides: Partial<SettingsOverlayOptions> = {},
): SettingsOverlayOptions {
  return { ...baseOptions(), ...overrides };
}

import { expect, vi, beforeEach, afterEach } from "vitest";
import * as attachments from "@components/message-list/attachments";
import * as formatting from "@lib/text/formatting";
import * as media from "@components/message-list/media";
import * as channelMutes from "@lib/prefs/channelMutes";
import {
  mockAppVersion,
  mockUiState,
  uiSubscriptions,
  mockAuthState,
} from "./settingsOverlayMocks";

export const APP_LIFETIME_MODULES = [
  ["@components/message-list/attachments", attachments],
  ["@lib/text/formatting", formatting],
  ["@components/message-list/media", media],
  ["@lib/prefs/channelMutes", channelMutes],
] as const;

export function clickEl(el: Element | null): void {
  expect(el).not.toBeNull();
  (el as HTMLElement).click();
}

export function getTab(container: HTMLDivElement, index: number): HTMLElement {
  const tabs = container.querySelectorAll(".settings-sidebar > button.settings-nav-item");
  const tab = tabs[index];
  expect(tab).toBeDefined();
  return tab as HTMLElement;
}

export const defaultOptions = {
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

/** Registers the shared beforeEach/afterEach for the SettingsOverlay describes; `bind` receives each fresh container. */
export function useSettingsOverlayHarness(bind: (el: HTMLDivElement) => void): void {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    bind(container);
    localStorage.clear();
    vi.clearAllMocks();
    mockAppVersion.mockResolvedValue("1.2.3-test");
    mockAuthState.user = { id: 1, username: "testuser", totp_enabled: false, display_name: null };
    mockUiState.settingsOpen = false;
    mockUiState.settingsTab = null;
    mockUiState.settingsTabSeq = 0;
    uiSubscriptions.all.length = 0;
  });

  afterEach(() => {
    container.remove();
  });
}

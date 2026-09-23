import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSettingsOverlay } from "@components/SettingsOverlay";
import type { SettingsOverlayOptions } from "@components/SettingsOverlay";
import { updateUser } from "@stores/auth.store";

// Mock logger
vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getLogBuffer: () => [],
  clearLogBuffer: vi.fn(),
  addLogListener: () => () => {},
  setLogLevel: vi.fn(),
}));

// Mock stores
const mockSetTheme = vi.fn();
vi.mock("@stores/ui.store", () => ({
  uiStore: {
    getState: () => ({ settingsOpen: false }),
    subscribe: () => () => {},
    subscribeSelector: vi.fn((_sel: unknown, _listener: unknown) => () => {}),
  },
  setTheme: (...args: unknown[]) => mockSetTheme(...args),
}));

vi.mock("@lib/livekitSession", () => ({
  switchInputDevice: vi.fn().mockResolvedValue(undefined),
  switchOutputDevice: vi.fn().mockResolvedValue(undefined),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  reapplyAudioProcessing: vi.fn().mockResolvedValue(undefined),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

// Start with totp_enabled = false for enrollment tests
let mockTotpEnabled = false;

vi.mock("@stores/auth.store", () => ({
  authStore: {
    getState: () => ({
      user: { id: 1, username: "testuser", totp_enabled: mockTotpEnabled },
    }),
    subscribeSelector: vi.fn(() => () => {}),
  },
  updateUser: vi.fn((patch: Record<string, unknown>) => {
    if ("totp_enabled" in patch) {
      mockTotpEnabled = patch.totp_enabled as boolean;
    }
  }),
}));

function makeOptions(overrides: Partial<SettingsOverlayOptions> = {}): SettingsOverlayOptions {
  return {
    onClose: vi.fn(),
    onChangePassword: vi.fn().mockResolvedValue(undefined),
    onUpdateProfile: vi.fn().mockResolvedValue(undefined),
    onUploadAvatar: vi.fn().mockResolvedValue("/api/v1/files/test"),
    onLogout: vi.fn(),
    onDeleteAccount: vi.fn().mockResolvedValue(undefined),
    onStatusChange: vi.fn(),
    onEnableTotp: vi.fn().mockResolvedValue({
      qr_uri: "otpauth://totp/OwnCord:testuser?secret=TESTSECRET",
      backup_codes: ["code1", "code2", "code3"],
    }),
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
    ...overrides,
  };
}

describe("TOTP Settings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    mockTotpEnabled = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    container.remove();
  });

  // -----------------------------------------------------------------------
  // OC-0354: the store's totp_enabled is a stale default until the profile
  // has been read, so the section asks the server when it opens.
  // -----------------------------------------------------------------------
  describe("2FA state refresh on open (OC-0354)", () => {
    it("asks the server once and switches to the disable view when 2FA is really on", async () => {
      mockTotpEnabled = false;
      const options = makeOptions({
        onRefreshTotpStatus: vi.fn(async () => {
          updateUser({ totp_enabled: true });
        }),
      });
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      // Rendered from the stale store first...
      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      expect(enableBtn).not.toBeNull();

      // ...then rebuilt from the server's answer.
      await vi.waitFor(() => {
        const badge = container.querySelector("[data-testid='totp-status-badge']") as HTMLElement;
        expect(badge.textContent).toBe("Enabled");
      });
      expect(container.querySelector("[data-testid='totp-disable-btn']")).not.toBeNull();
      expect(options.onRefreshTotpStatus).toHaveBeenCalledTimes(1);

      overlay.destroy?.();
    });

    it("keeps what it shows when the server confirms it or cannot be reached", async () => {
      mockTotpEnabled = false;
      const confirmed = makeOptions({ onRefreshTotpStatus: vi.fn().mockResolvedValue(undefined) });
      const overlay = createSettingsOverlay(confirmed);
      overlay.mount(container);
      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      enableBtn.click();
      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "typed already";
      await Promise.resolve();
      await Promise.resolve();
      // The form the user opened survives a refresh that changes nothing.
      expect(
        (container.querySelector("[data-testid='totp-password-input']") as HTMLInputElement).value,
      ).toBe("typed already");
      overlay.destroy?.();

      const failing = makeOptions({
        onRefreshTotpStatus: vi.fn().mockRejectedValue(new Error("offline")),
      });
      const overlay2 = createSettingsOverlay(failing);
      overlay2.mount(container);
      await Promise.resolve();
      await Promise.resolve();
      const badge = container.querySelector("[data-testid='totp-status-badge']") as HTMLElement;
      expect(badge.textContent).toBe("Disabled");
      overlay2.destroy?.();
    });
  });

  // -----------------------------------------------------------------------
  // Enrollment flow (user.totp_enabled is false/undefined)
  // -----------------------------------------------------------------------
  describe("TOTP enrollment (totp_enabled is false)", () => {
    it("renders 'Enable 2FA' button when totp_enabled is falsy", () => {
      mockTotpEnabled = false;
      const options = makeOptions();
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      expect(enableBtn).not.toBeNull();
      expect(enableBtn.textContent).toBe("Enable 2FA");

      overlay.destroy?.();
    });

    it("shows password form when 'Enable 2FA' is clicked", () => {
      mockTotpEnabled = false;
      const options = makeOptions();
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      enableBtn.click();

      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      expect(pwInput).not.toBeNull();
      // The enable button should be hidden
      expect(enableBtn.style.display).toBe("none");
      // The password input's parent (formArea) should be visible
      expect(pwInput.closest("div")!.style.display).not.toBe("none");

      overlay.destroy?.();
    });

    it("shows 'Password is required' error when submitting empty password", () => {
      mockTotpEnabled = false;
      const options = makeOptions();
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      enableBtn.click();

      // Leave password empty and click Submit
      const submitBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Submit",
      ) as HTMLElement;
      submitBtn.click();

      const errorEl = container.querySelector("[data-testid='totp-error']") as HTMLElement;
      expect(errorEl.textContent).toBe("Password is required.");
      expect(options.onEnableTotp).not.toHaveBeenCalled();

      overlay.destroy?.();
    });

    it("calls onEnableTotp with password on submit", async () => {
      mockTotpEnabled = false;
      const options = makeOptions();
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      enableBtn.click();

      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "mypassword123";

      const submitBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Submit",
      ) as HTMLElement;
      submitBtn.click();

      await vi.waitFor(() => {
        expect(options.onEnableTotp).toHaveBeenCalledWith("mypassword123");
      });

      overlay.destroy?.();
    });

    it("shows QR URI display after successful enable call", async () => {
      mockTotpEnabled = false;
      const options = makeOptions();
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      enableBtn.click();

      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "mypassword123";

      const submitBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Submit",
      ) as HTMLElement;
      submitBtn.click();

      await vi.waitFor(() => {
        const qrUri = container.querySelector("[data-testid='totp-qr-uri']") as HTMLElement;
        expect(qrUri).not.toBeNull();
        expect(qrUri.textContent).toBe("otpauth://totp/OwnCord:testuser?secret=TESTSECRET");
      });

      overlay.destroy?.();
    });

    it("shows backup codes if returned", async () => {
      mockTotpEnabled = false;
      const options = makeOptions();
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      enableBtn.click();

      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "mypassword123";

      const submitBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Submit",
      ) as HTMLElement;
      submitBtn.click();

      await vi.waitFor(() => {
        const qrUri = container.querySelector("[data-testid='totp-qr-uri']");
        expect(qrUri).not.toBeNull();
      });

      // Look for the backup codes text
      const codeElements = container.querySelectorAll("code");
      const backupCodeEl = Array.from(codeElements).find((el) => el.textContent?.includes("code1"));
      expect(backupCodeEl).not.toBeUndefined();
      expect(backupCodeEl!.textContent).toContain("code1");
      expect(backupCodeEl!.textContent).toContain("code2");
      expect(backupCodeEl!.textContent).toContain("code3");

      overlay.destroy?.();
    });

    it("warns the codes are shown once and offers a copy button", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });

      mockTotpEnabled = false;
      const options = makeOptions();
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      (container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement).click();
      (container.querySelector("[data-testid='totp-password-input']") as HTMLInputElement).value =
        "mypassword123";
      (
        Array.from(container.querySelectorAll(".ac-btn")).find(
          (b) => b.textContent === "Submit",
        ) as HTMLElement
      ).click();

      await vi.waitFor(() => {
        expect(container.querySelector("[data-testid='totp-copy-backup-codes']")).not.toBeNull();
      });

      expect(container.textContent).toContain("you won't see them again");

      const copyBtn = container.querySelector(
        "[data-testid='totp-copy-backup-codes']",
      ) as HTMLElement;
      copyBtn.click();

      expect(writeText).toHaveBeenCalledWith("code1\ncode2\ncode3");
      await vi.waitFor(() => {
        expect(copyBtn.textContent).toBe("Copied!");
      });

      overlay.destroy?.();
    });

    it("shows code confirmation input after enable success", async () => {
      mockTotpEnabled = false;
      const options = makeOptions();
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      enableBtn.click();

      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "mypassword123";

      const submitBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Submit",
      ) as HTMLElement;
      submitBtn.click();

      await vi.waitFor(() => {
        const codeInput = container.querySelector(
          "[data-testid='totp-code-input']",
        ) as HTMLInputElement;
        expect(codeInput).not.toBeNull();
        expect(codeInput.placeholder).toBe("6-digit code");
      });

      const confirmBtn = container.querySelector("[data-testid='totp-confirm-btn']") as HTMLElement;
      expect(confirmBtn).not.toBeNull();
      expect(confirmBtn.textContent).toBe("Verify & Activate");

      overlay.destroy?.();
    });

    it("calls onConfirmTotp with password and code on 'Verify & Activate' click", async () => {
      mockTotpEnabled = false;
      const options = makeOptions();
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      // Step 1: Click Enable 2FA
      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      enableBtn.click();

      // Step 2: Enter password and submit
      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "mypassword123";

      const submitBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Submit",
      ) as HTMLElement;
      submitBtn.click();

      // Wait for QR URI to appear
      await vi.waitFor(() => {
        expect(container.querySelector("[data-testid='totp-qr-uri']")).not.toBeNull();
      });

      // Step 3: Enter code and confirm
      const codeInput = container.querySelector(
        "[data-testid='totp-code-input']",
      ) as HTMLInputElement;
      codeInput.value = "123456";

      const confirmBtn = container.querySelector("[data-testid='totp-confirm-btn']") as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(options.onConfirmTotp).toHaveBeenCalledWith("mypassword123", "123456");
      });

      overlay.destroy?.();
    });

    it("shows error on failed enable (bad password)", async () => {
      mockTotpEnabled = false;
      const options = makeOptions({
        onEnableTotp: vi.fn().mockRejectedValue(new Error("Invalid password")),
      });
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      enableBtn.click();

      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "wrongpassword";

      const submitBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Submit",
      ) as HTMLElement;
      submitBtn.click();

      await vi.waitFor(() => {
        const errorEl = container.querySelector("[data-testid='totp-error']") as HTMLElement;
        expect(errorEl.textContent).toBe("Invalid password");
      });

      // Submit button should be re-enabled
      expect(submitBtn.textContent).toBe("Submit");
      expect((submitBtn as HTMLButtonElement).disabled).toBe(false);

      overlay.destroy?.();
    });

    it("shows error on failed confirm (bad code)", async () => {
      mockTotpEnabled = false;
      const options = makeOptions({
        onConfirmTotp: vi.fn().mockRejectedValue(new Error("Invalid code")),
      });
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      // Navigate through enable flow
      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      enableBtn.click();

      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "mypassword123";

      const submitBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Submit",
      ) as HTMLElement;
      submitBtn.click();

      await vi.waitFor(() => {
        expect(container.querySelector("[data-testid='totp-qr-uri']")).not.toBeNull();
      });

      const codeInput = container.querySelector(
        "[data-testid='totp-code-input']",
      ) as HTMLInputElement;
      codeInput.value = "000000";

      const confirmBtn = container.querySelector("[data-testid='totp-confirm-btn']") as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        // The error element in the confirm area also has data-testid="totp-error"
        const errorEls = container.querySelectorAll("[data-testid='totp-error']");
        const confirmError = Array.from(errorEls).find((el) => el.textContent === "Invalid code");
        expect(confirmError).not.toBeUndefined();
      });

      // Confirm button should be re-enabled
      const confirmBtnAfter = container.querySelector(
        "[data-testid='totp-confirm-btn']",
      ) as HTMLButtonElement;
      expect(confirmBtnAfter.disabled).toBe(false);
      expect(confirmBtnAfter.textContent).toBe("Verify & Activate");

      overlay.destroy?.();
    });

    it("updates UI to disabled state after successful confirm", async () => {
      mockTotpEnabled = false;
      // Simulate MainPage's onConfirmTotp: it calls updateUser after API success
      const options = makeOptions({
        onConfirmTotp: vi.fn().mockImplementation(async () => {
          updateUser({ totp_enabled: true });
        }),
      });
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      // Navigate through enable flow
      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      enableBtn.click();

      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "mypassword123";

      const submitBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Submit",
      ) as HTMLElement;
      submitBtn.click();

      await vi.waitFor(() => {
        expect(container.querySelector("[data-testid='totp-qr-uri']")).not.toBeNull();
      });

      const codeInput = container.querySelector(
        "[data-testid='totp-code-input']",
      ) as HTMLInputElement;
      codeInput.value = "123456";

      const confirmBtn = container.querySelector("[data-testid='totp-confirm-btn']") as HTMLElement;
      confirmBtn.click();

      // After successful confirmation, onEnrolled() is called which re-renders.
      // Since updateUser sets mockTotpEnabled = true, the re-render should show the disable view.
      await vi.waitFor(() => {
        const statusBadge = container.querySelector(
          "[data-testid='totp-status-badge']",
        ) as HTMLElement;
        expect(statusBadge.textContent).toBe("Enabled");
      });

      // The disable button should now be visible
      const disableBtn = container.querySelector("[data-testid='totp-disable-btn']") as HTMLElement;
      expect(disableBtn).not.toBeNull();
      expect(disableBtn.textContent).toBe("Disable 2FA");

      overlay.destroy?.();
    });
  });

  // -----------------------------------------------------------------------
  // Disable flow (user.totp_enabled is true)
  // -----------------------------------------------------------------------
  describe("TOTP disable (totp_enabled is true)", () => {
    it("renders 'Disable 2FA' button and 'Enabled' badge when totp_enabled is true", () => {
      mockTotpEnabled = true;
      const options = makeOptions();
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const disableBtn = container.querySelector("[data-testid='totp-disable-btn']") as HTMLElement;
      expect(disableBtn).not.toBeNull();
      expect(disableBtn.textContent).toBe("Disable 2FA");

      const badge = container.querySelector("[data-testid='totp-status-badge']") as HTMLElement;
      expect(badge).not.toBeNull();
      expect(badge.textContent).toBe("Enabled");

      overlay.destroy?.();
    });

    it("shows password confirmation when 'Disable 2FA' is clicked", () => {
      mockTotpEnabled = true;
      const options = makeOptions();
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const disableBtn = container.querySelector("[data-testid='totp-disable-btn']") as HTMLElement;
      disableBtn.click();

      // Disable button should be hidden
      expect(disableBtn.style.display).toBe("none");

      // Password input should appear
      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      expect(pwInput).not.toBeNull();

      overlay.destroy?.();
    });

    it("calls onDisableTotp with password on confirm", async () => {
      mockTotpEnabled = true;
      const options = makeOptions();
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const disableBtn = container.querySelector("[data-testid='totp-disable-btn']") as HTMLElement;
      disableBtn.click();

      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "mypassword123";

      const confirmBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Confirm Disable",
      ) as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(options.onDisableTotp).toHaveBeenCalledWith("mypassword123");
      });

      overlay.destroy?.();
    });

    it("shows error on failed disable (bad password)", async () => {
      mockTotpEnabled = true;
      const options = makeOptions({
        onDisableTotp: vi.fn().mockRejectedValue(new Error("Wrong password")),
      });
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const disableBtn = container.querySelector("[data-testid='totp-disable-btn']") as HTMLElement;
      disableBtn.click();

      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "wrongpassword";

      const confirmBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Confirm Disable",
      ) as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        const errorEl = container.querySelector("[data-testid='totp-error']") as HTMLElement;
        expect(errorEl.textContent).toBe("Wrong password");
      });

      // Button should be re-enabled
      expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
      expect(confirmBtn.textContent).toBe("Confirm Disable");

      overlay.destroy?.();
    });

    it("shows 'required' error when server returns 403 for require_2fa policy", async () => {
      mockTotpEnabled = true;
      const options = makeOptions({
        onDisableTotp: vi.fn().mockRejectedValue(new Error("2FA is required by server policy")),
      });
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const disableBtn = container.querySelector("[data-testid='totp-disable-btn']") as HTMLElement;
      disableBtn.click();

      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "mypassword123";

      const confirmBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Confirm Disable",
      ) as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        const errorEl = container.querySelector("[data-testid='totp-error']") as HTMLElement;
        expect(errorEl.textContent).toBe("2FA is required by this server and cannot be disabled");
      });

      overlay.destroy?.();
    });

    it("hides confirm area when cancel is clicked", () => {
      mockTotpEnabled = true;
      const options = makeOptions();
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const disableBtn = container.querySelector("[data-testid='totp-disable-btn']") as HTMLElement;
      disableBtn.click();

      // Confirm area should be visible
      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      expect(pwInput).not.toBeNull();

      // Find the Cancel button that is a sibling of the "Confirm Disable" button
      // inside the TOTP section
      const totpSection = container.querySelector("[data-testid='totp-section']") as HTMLElement;
      const cancelBtn = Array.from(totpSection.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Cancel",
      ) as HTMLElement;
      cancelBtn.click();

      // Disable button should reappear
      expect(disableBtn.style.display).toBe("");
      // The confirm area (parent of password input) should be hidden
      expect((pwInput.closest("div[style*='display']") as HTMLElement).style.display).toBe("none");

      overlay.destroy?.();
    });

    it("updates UI to enrollment state after successful disable", async () => {
      mockTotpEnabled = true;
      // Simulate MainPage's onDisableTotp: it calls updateUser after API success
      const options = makeOptions({
        onDisableTotp: vi.fn().mockImplementation(async () => {
          updateUser({ totp_enabled: false });
        }),
      });
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const disableBtn = container.querySelector("[data-testid='totp-disable-btn']") as HTMLElement;
      disableBtn.click();

      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "mypassword123";

      const confirmBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Confirm Disable",
      ) as HTMLElement;
      confirmBtn.click();

      // After successful disable, onDisabled() is called which re-renders.
      // Since updateUser sets mockTotpEnabled = false, re-render should show enrollment view.
      await vi.waitFor(() => {
        const statusBadge = container.querySelector(
          "[data-testid='totp-status-badge']",
        ) as HTMLElement;
        expect(statusBadge.textContent).toBe("Disabled");
      });

      // The enable button should now be visible
      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      expect(enableBtn).not.toBeNull();
      expect(enableBtn.textContent).toBe("Enable 2FA");

      overlay.destroy?.();
    });
  });

  // -----------------------------------------------------------------------
  // Regression: store mutation ownership
  // -----------------------------------------------------------------------
  describe("TOTP store mutation ownership", () => {
    it("AccountTab does NOT call updateUser on confirm — only the callback owner does", async () => {
      mockTotpEnabled = false;
      // The onConfirmTotp callback simulates MainPage: it calls updateUser itself
      const options = makeOptions({
        onConfirmTotp: vi.fn().mockImplementation(async () => {
          // MainPage calls updateUser here — this is the single owner
          updateUser({ totp_enabled: true });
        }),
      });
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      // Navigate through enable flow
      const enableBtn = container.querySelector("[data-testid='totp-enable-btn']") as HTMLElement;
      enableBtn.click();
      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "mypassword123";
      const submitBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Submit",
      ) as HTMLElement;
      submitBtn.click();

      await vi.waitFor(() => {
        expect(container.querySelector("[data-testid='totp-qr-uri']")).not.toBeNull();
      });

      const codeInput = container.querySelector(
        "[data-testid='totp-code-input']",
      ) as HTMLInputElement;
      codeInput.value = "123456";
      (updateUser as ReturnType<typeof vi.fn>).mockClear();

      const confirmBtn = container.querySelector("[data-testid='totp-confirm-btn']") as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(options.onConfirmTotp).toHaveBeenCalled();
      });

      // updateUser should have been called exactly once (by the callback, not by AccountTab)
      expect(updateUser).toHaveBeenCalledTimes(1);

      overlay.destroy?.();
    });

    it("AccountTab does NOT call updateUser on disable — only the callback owner does", async () => {
      mockTotpEnabled = true;
      const options = makeOptions({
        onDisableTotp: vi.fn().mockImplementation(async () => {
          updateUser({ totp_enabled: false });
        }),
      });
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      const disableBtn = container.querySelector("[data-testid='totp-disable-btn']") as HTMLElement;
      disableBtn.click();
      const pwInput = container.querySelector(
        "[data-testid='totp-password-input']",
      ) as HTMLInputElement;
      pwInput.value = "mypassword123";
      (updateUser as ReturnType<typeof vi.fn>).mockClear();

      const confirmBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
        (b) => b.textContent === "Confirm Disable",
      ) as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(options.onDisableTotp).toHaveBeenCalled();
      });

      expect(updateUser).toHaveBeenCalledTimes(1);

      overlay.destroy?.();
    });
  });

  // -------------------------------------------------------------------------
  // B7-15b: emergency code regeneration and the recovery kit
  // -------------------------------------------------------------------------

  const q = <T extends Element>(sel: string): T | null => container.querySelector<T>(sel);
  const byTestId = <T extends Element>(id: string): T => q<T>(`[data-testid='${id}']`)!;

  async function confirmWithPassword(prefix: string, password: string): Promise<void> {
    byTestId<HTMLButtonElement>(`${prefix}-btn`).click();
    byTestId<HTMLInputElement>(`${prefix}-password`).value = password;
    byTestId<HTMLButtonElement>(`${prefix}-submit`).click();
  }

  describe("Regenerate emergency recovery codes (B7-15b)", () => {
    const CODES = ["AAAAA-BBBBB", "CCCCC-DDDDD"];

    it("is offered only when 2FA is enabled", () => {
      mockTotpEnabled = false;
      const overlay = createSettingsOverlay(makeOptions());
      overlay.mount(container);
      expect(q("[data-testid='totp-regenerate-btn']")).toBeNull();
      overlay.destroy?.();
    });

    it("requires the password, then shows the new set once and clears the password", async () => {
      mockTotpEnabled = true;
      const options = makeOptions({ onRegenerateRecoveryCodes: vi.fn().mockResolvedValue(CODES) });
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      await confirmWithPassword("totp-regenerate", "");
      expect(byTestId("totp-regenerate-error").textContent).toBe("Password is required.");
      expect(options.onRegenerateRecoveryCodes).not.toHaveBeenCalled();

      byTestId<HTMLInputElement>("totp-regenerate-password").value = "mypassword123";
      byTestId<HTMLButtonElement>("totp-regenerate-submit").click();
      await vi.waitFor(() =>
        expect(q("[data-testid='totp-regenerated-codes']")?.textContent).toBe(CODES.join("\n")),
      );
      expect(options.onRegenerateRecoveryCodes).toHaveBeenCalledWith("mypassword123");
      expect(byTestId<HTMLInputElement>("totp-regenerate-password").value).toBe("");
      overlay.destroy?.();
    });

    it("replaces the previous set rather than keeping it, and Done wipes it", async () => {
      mockTotpEnabled = true;
      const onRegenerateRecoveryCodes = vi
        .fn()
        .mockResolvedValueOnce(["OLDOL-DOLDO"])
        .mockResolvedValueOnce(["NEWNE-WNEWN"]);
      const overlay = createSettingsOverlay(makeOptions({ onRegenerateRecoveryCodes }));
      overlay.mount(container);

      await confirmWithPassword("totp-regenerate", "pw");
      await vi.waitFor(() => expect(container.textContent).toContain("OLDOL-DOLDO"));
      await vi.waitFor(() =>
        expect(byTestId<HTMLButtonElement>("totp-regenerate-submit").disabled).toBe(false),
      );
      await confirmWithPassword("totp-regenerate", "pw");
      await vi.waitFor(() => expect(container.textContent).toContain("NEWNE-WNEWN"));
      expect(container.textContent).not.toContain("OLDOL-DOLDO");

      byTestId<HTMLButtonElement>("shown-once-done").click();
      expect(container.textContent).not.toContain("NEWNE-WNEWN");
      expect(q("[data-testid='totp-regenerated-codes']")).toBeNull();
      overlay.destroy?.();
    });

    it("shows the server's refusal and no codes", async () => {
      mockTotpEnabled = true;
      const overlay = createSettingsOverlay(
        makeOptions({
          onRegenerateRecoveryCodes: vi.fn().mockRejectedValue(new Error("invalid password")),
        }),
      );
      overlay.mount(container);
      await confirmWithPassword("totp-regenerate", "wrong");
      await vi.waitFor(() =>
        expect(byTestId("totp-regenerate-error").textContent).toBe("invalid password"),
      );
      expect(q("[data-testid='totp-regenerated-codes']")).toBeNull();
      overlay.destroy?.();
    });
  });

  describe("Recovery kit (B7-15b)", () => {
    const SECRET = "K7QF-3M2X-9PLA-ZB5A-QW2E-TT7Y-AAAA-BBBB";

    it.each([
      [
        { enrolled: true, created_at: "2026-09-21T00:00:00Z", used_at: null },
        "Enrolled",
        "Replace recovery kit",
      ],
      [{ enrolled: false, used_at: "2026-09-21T00:00:00Z" }, "Used", "Create recovery kit"],
      [{ enrolled: false, used_at: null }, "Not set up", "Create recovery kit"],
    ])("shows status %j as %s", async (status, badge, action) => {
      const overlay = createSettingsOverlay(
        makeOptions({ onGetRecoveryKitStatus: vi.fn().mockResolvedValue(status) }),
      );
      overlay.mount(container);
      await vi.waitFor(() => expect(byTestId("recovery-kit-status").textContent).toBe(badge));
      expect(byTestId("recovery-kit-btn").textContent).toBe(action);
      overlay.destroy?.();
    });

    it("enrols with the password, shows the secret once and refreshes the status", async () => {
      const onGetRecoveryKitStatus = vi
        .fn()
        .mockResolvedValueOnce({ enrolled: false, used_at: null })
        .mockResolvedValueOnce({
          enrolled: true,
          created_at: "2026-09-21T00:00:00Z",
          used_at: null,
        });
      const options = makeOptions({
        onGetRecoveryKitStatus,
        onEnrolRecoveryKit: vi
          .fn()
          .mockResolvedValue({ kit_secret: SECRET, created_at: "2026-09-21T00:00:00Z" }),
      });
      const overlay = createSettingsOverlay(options);
      overlay.mount(container);

      await confirmWithPassword("recovery-kit", "mypassword123");
      await vi.waitFor(() =>
        expect(q("[data-testid='recovery-kit-secret']")?.textContent).toBe(SECRET),
      );
      expect(options.onEnrolRecoveryKit).toHaveBeenCalledWith("mypassword123");
      await vi.waitFor(() => expect(byTestId("recovery-kit-status").textContent).toBe("Enrolled"));

      byTestId<HTMLButtonElement>("shown-once-done").click();
      expect(container.textContent).not.toContain(SECRET);
      overlay.destroy?.();
    });

    it("says so when the server returns no secret", async () => {
      const overlay = createSettingsOverlay(
        makeOptions({ onEnrolRecoveryKit: vi.fn().mockResolvedValue({ created_at: "x" }) }),
      );
      overlay.mount(container);
      await confirmWithPassword("recovery-kit", "pw");
      await vi.waitFor(() =>
        expect(byTestId("recovery-kit-error").textContent).toMatch(/did not return/),
      );
      overlay.destroy?.();
    });

    it.each(["closing the overlay", "switching tab"])(
      "wipes a shown secret and codes from the DOM on %s",
      async (how) => {
        mockTotpEnabled = true;
        const overlay = createSettingsOverlay(
          makeOptions({
            onEnrolRecoveryKit: vi.fn().mockResolvedValue({ kit_secret: SECRET, created_at: "x" }),
            onRegenerateRecoveryCodes: vi.fn().mockResolvedValue(["ZZZZZ-YYYYY"]),
          }),
        );
        overlay.mount(container);
        overlay.open();
        await confirmWithPassword("recovery-kit", "pw");
        await confirmWithPassword("totp-regenerate", "pw");
        await vi.waitFor(() => {
          expect(container.textContent).toContain(SECRET);
          expect(container.textContent).toContain("ZZZZZ-YYYYY");
        });
        const secretNode = byTestId("recovery-kit-secret");

        if (how === "closing the overlay") {
          overlay.close();
        } else {
          (
            Array.from(
              container.querySelectorAll(".settings-sidebar > button.settings-nav-item"),
            ).find((b) => b.textContent === "Appearance") as HTMLElement
          ).click();
        }
        expect(container.innerHTML).not.toContain(SECRET);
        expect(container.innerHTML).not.toContain("ZZZZZ-YYYYY");
        // Even a detached reference holds nothing.
        expect(secretNode.textContent).toBe("");
        overlay.destroy?.();
      },
    );
  });
});

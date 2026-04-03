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
    onLogout: vi.fn(),
    onDeleteAccount: vi.fn().mockResolvedValue(undefined),
    onStatusChange: vi.fn(),
    onEnableTotp: vi.fn().mockResolvedValue({
      qr_uri: "otpauth://totp/OwnCord:testuser?secret=TESTSECRET",
      backup_codes: ["code1", "code2", "code3"],
    }),
    onConfirmTotp: vi.fn().mockResolvedValue(undefined),
    onDisableTotp: vi.fn().mockResolvedValue(undefined),
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
          (updateUser as ReturnType<typeof vi.fn>)({ totp_enabled: true });
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
          (updateUser as ReturnType<typeof vi.fn>)({ totp_enabled: false });
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
          (updateUser as ReturnType<typeof vi.fn>)({ totp_enabled: true });
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
          (updateUser as ReturnType<typeof vi.fn>)({ totp_enabled: false });
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
});

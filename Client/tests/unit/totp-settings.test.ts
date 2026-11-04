import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../helpers/settingsOverlayMocks";
import { makeOverlayOptions } from "../helpers/settingsOverlayOptions";
import { createSettingsOverlay } from "../../src/features/settings/SettingsOverlay";
import type { SettingsOverlayOptions } from "../../src/features/settings/SettingsOverlay";
import { updateUser } from "@stores/auth.store";
import { ApiClientError } from "@lib/api";

vi.mock("@lib/logger", () => mocks.loggerMock());

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

vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

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
  return makeOverlayOptions({
    onEnableTotp: vi.fn().mockResolvedValue({
      qr_uri: "otpauth://totp/OwnCord:testuser?secret=TESTSECRET",
      backup_codes: ["code1", "code2", "code3"],
    }),
    ...overrides,
  });
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

  const q = <T extends Element>(sel: string): T | null => container.querySelector<T>(sel);
  const byTestId = <T extends Element>(id: string): T => q<T>(`[data-testid='${id}']`)!;

  function acButton(label: string, scope: ParentNode = container): HTMLElement {
    return Array.from(scope.querySelectorAll(".ac-btn")).find(
      (b) => b.textContent === label,
    ) as HTMLElement;
  }

  function submitEnrolPassword(password: string): HTMLElement {
    byTestId<HTMLElement>("totp-enable-btn").click();
    byTestId<HTMLInputElement>("totp-password-input").value = password;
    const submit = acButton("Submit");
    submit.click();
    return submit;
  }

  async function reachCodeStep(password: string): Promise<void> {
    submitEnrolPassword(password);
    await vi.waitFor(() => {
      expect(q("[data-testid='totp-qr-uri']")).not.toBeNull();
    });
  }

  function submitCode(code: string): void {
    byTestId<HTMLInputElement>("totp-code-input").value = code;
    byTestId<HTMLElement>("totp-confirm-btn").click();
  }

  function submitDisablePassword(password: string): HTMLElement {
    byTestId<HTMLElement>("totp-disable-btn").click();
    byTestId<HTMLInputElement>("totp-password-input").value = password;
    const confirm = acButton("Confirm Disable");
    confirm.click();
    return confirm;
  }

  function openOverlay(overrides: Partial<SettingsOverlayOptions> = {}, totpEnabled = false) {
    mockTotpEnabled = totpEnabled;
    const options = makeOptions(overrides);
    const overlay = createSettingsOverlay(options);
    overlay.mount(container);
    overlay.open();
    return { options, overlay };
  }

  // -----------------------------------------------------------------------
  // OC-0354: the store's totp_enabled is a stale default until the profile
  // has been read, so the section asks the server when it opens.
  // -----------------------------------------------------------------------
  describe("2FA state refresh on open", () => {
    it("asks the server once and switches to the disable view when 2FA is really on", async () => {
      const { options, overlay } = openOverlay({
        onRefreshTotpStatus: vi.fn(async () => {
          updateUser({ totp_enabled: true });
        }),
      });

      // Rendered from the stale store first...
      const enableBtn = byTestId<HTMLElement>("totp-enable-btn");
      expect(enableBtn).not.toBeNull();

      // ...then rebuilt from the server's answer.
      await vi.waitFor(() => {
        const badge = byTestId<HTMLElement>("totp-status-badge");
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
      overlay.open();
      byTestId<HTMLElement>("totp-enable-btn").click();
      byTestId<HTMLInputElement>("totp-password-input").value = "typed already";
      await Promise.resolve();
      await Promise.resolve();
      // The form the user opened survives a refresh that changes nothing.
      expect(byTestId<HTMLInputElement>("totp-password-input").value).toBe("typed already");
      overlay.destroy?.();

      const failing = makeOptions({
        onRefreshTotpStatus: vi.fn().mockRejectedValue(new Error("offline")),
      });
      const overlay2 = createSettingsOverlay(failing);
      overlay2.mount(container);
      overlay2.open();
      await Promise.resolve();
      await Promise.resolve();
      const badge = byTestId<HTMLElement>("totp-status-badge");
      expect(badge.textContent).toBe("Disabled");
      overlay2.destroy?.();
    });
  });

  // -----------------------------------------------------------------------
  // Enrollment flow (user.totp_enabled is false/undefined)
  // -----------------------------------------------------------------------
  describe("TOTP enrollment (totp_enabled is false)", () => {
    it("renders 'Enable 2FA' button when totp_enabled is falsy", () => {
      const { overlay } = openOverlay();

      const enableBtn = byTestId<HTMLElement>("totp-enable-btn");
      expect(enableBtn).not.toBeNull();
      expect(enableBtn.textContent).toBe("Enable 2FA");

      overlay.destroy?.();
    });

    it("shows password form when 'Enable 2FA' is clicked", () => {
      const { overlay } = openOverlay();

      const enableBtn = byTestId<HTMLElement>("totp-enable-btn");
      enableBtn.click();

      const pwInput = byTestId<HTMLInputElement>("totp-password-input");
      expect(pwInput).not.toBeNull();
      // The enable button should be hidden
      expect(enableBtn.style.display).toBe("none");
      // The password input's parent (formArea) should be visible
      expect(pwInput.closest("div")!.style.display).not.toBe("none");

      overlay.destroy?.();
    });

    it("shows 'Password is required' error when submitting empty password", () => {
      const { options, overlay } = openOverlay();

      byTestId<HTMLElement>("totp-enable-btn").click();

      // Leave password empty and click Submit
      acButton("Submit").click();

      const errorEl = byTestId<HTMLElement>("totp-error");
      expect(errorEl.textContent).toBe("Password is required.");
      expect(options.onEnableTotp).not.toHaveBeenCalled();

      overlay.destroy?.();
    });

    it("calls onEnableTotp with password on submit", async () => {
      const { options, overlay } = openOverlay();

      submitEnrolPassword("mypassword123");

      await vi.waitFor(() => {
        expect(options.onEnableTotp).toHaveBeenCalledWith("mypassword123");
      });

      overlay.destroy?.();
    });

    it("shows QR URI display after successful enable call", async () => {
      const { overlay } = openOverlay();

      submitEnrolPassword("mypassword123");

      await vi.waitFor(() => {
        const qrUri = byTestId<HTMLElement>("totp-qr-uri");
        expect(qrUri).not.toBeNull();
        expect(qrUri.textContent).toBe("otpauth://totp/OwnCord:testuser?secret=TESTSECRET");
      });

      overlay.destroy?.();
    });

    it("shows backup codes if returned", async () => {
      const { overlay } = openOverlay();

      submitEnrolPassword("mypassword123");

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

      const { overlay } = openOverlay();

      submitEnrolPassword("mypassword123");

      await vi.waitFor(() => {
        expect(container.querySelector("[data-testid='totp-copy-backup-codes']")).not.toBeNull();
      });

      expect(container.textContent).toContain("you won't see them again");

      const copyBtn = byTestId<HTMLElement>("totp-copy-backup-codes");
      copyBtn.click();

      expect(writeText).toHaveBeenCalledWith("code1\ncode2\ncode3");
      await vi.waitFor(() => {
        expect(copyBtn.textContent).toBe("Copied!");
      });

      overlay.destroy?.();
    });

    it("shows code confirmation input after enable success", async () => {
      const { overlay } = openOverlay();

      submitEnrolPassword("mypassword123");

      await vi.waitFor(() => {
        const codeInput = byTestId<HTMLInputElement>("totp-code-input");
        expect(codeInput).not.toBeNull();
        expect(codeInput.placeholder).toBe("6-digit code");
      });

      const confirmBtn = byTestId<HTMLElement>("totp-confirm-btn");
      expect(confirmBtn).not.toBeNull();
      expect(confirmBtn.textContent).toBe("Verify & Activate");

      overlay.destroy?.();
    });

    it("calls onConfirmTotp with password and code on 'Verify & Activate' click", async () => {
      const { options, overlay } = openOverlay();

      // Step 1: Click Enable 2FA
      await reachCodeStep("mypassword123");

      // Step 3: Enter code and confirm
      submitCode("123456");

      await vi.waitFor(() => {
        expect(options.onConfirmTotp).toHaveBeenCalledWith("mypassword123", "123456");
      });

      overlay.destroy?.();
    });

    it("shows error on failed enable (bad password)", async () => {
      const { overlay } = openOverlay({
        onEnableTotp: vi.fn().mockRejectedValue(new Error("Invalid password")),
      });

      const submitBtn = submitEnrolPassword("wrongpassword");

      await vi.waitFor(() => {
        const errorEl = byTestId<HTMLElement>("totp-error");
        expect(errorEl.textContent).toBe("Invalid password");
      });

      // Submit button should be re-enabled
      expect(submitBtn.textContent).toBe("Submit");
      expect((submitBtn as HTMLButtonElement).disabled).toBe(false);

      overlay.destroy?.();
    });

    async function expectConfirmFailure(
      onConfirmTotp: SettingsOverlayOptions["onConfirmTotp"],
      message: string,
    ): Promise<void> {
      const { overlay } = openOverlay({ onConfirmTotp });

      // Navigate through enable flow
      await reachCodeStep("mypassword123");

      submitCode("000000");

      await vi.waitFor(() => {
        // The error element in the confirm area also has data-testid="totp-error"
        const errorEls = container.querySelectorAll("[data-testid='totp-error']");
        const confirmError = Array.from(errorEls).find((el) => el.textContent === message);
        expect(confirmError).not.toBeUndefined();
      });

      // Confirm button should be re-enabled
      const confirmBtnAfter = byTestId<HTMLButtonElement>("totp-confirm-btn");
      expect(confirmBtnAfter.disabled).toBe(false);
      expect(confirmBtnAfter.textContent).toBe("Verify & Activate");

      overlay.destroy?.();
    }

    it("shows error on failed confirm (bad code)", async () => {
      await expectConfirmFailure(
        vi.fn().mockRejectedValue(new Error("Invalid code")),
        "Invalid code",
      );
    });

    it("reports an internal confirm failure as a failure, not a wrong code", async () => {
      await expectConfirmFailure(
        vi
          .fn()
          .mockRejectedValue(
            new ApiClientError(500, "INTERNAL_ERROR", "failed to enable two-factor authentication"),
          ),
        "Could not turn on two-factor authentication. Try again.",
      );
    });

    it("updates UI to disabled state after successful confirm", async () => {
      // Simulate MainPage's onConfirmTotp: it calls updateUser after API success
      const { overlay } = openOverlay({
        onConfirmTotp: vi.fn().mockImplementation(async () => {
          updateUser({ totp_enabled: true });
        }),
      });

      // Navigate through enable flow
      await reachCodeStep("mypassword123");

      submitCode("123456");

      // After successful confirmation, onEnrolled() is called which re-renders.
      // Since updateUser sets mockTotpEnabled = true, the re-render should show the disable view.
      await vi.waitFor(() => {
        const statusBadge = byTestId<HTMLElement>("totp-status-badge");
        expect(statusBadge.textContent).toBe("Enabled");
      });

      // The disable button should now be visible
      const disableBtn = byTestId<HTMLElement>("totp-disable-btn");
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
      const { overlay } = openOverlay({}, true);

      const disableBtn = byTestId<HTMLElement>("totp-disable-btn");
      expect(disableBtn).not.toBeNull();
      expect(disableBtn.textContent).toBe("Disable 2FA");

      const badge = byTestId<HTMLElement>("totp-status-badge");
      expect(badge).not.toBeNull();
      expect(badge.textContent).toBe("Enabled");

      overlay.destroy?.();
    });

    it("shows password confirmation when 'Disable 2FA' is clicked", () => {
      const { overlay } = openOverlay({}, true);

      const disableBtn = byTestId<HTMLElement>("totp-disable-btn");
      disableBtn.click();

      // Disable button should be hidden
      expect(disableBtn.style.display).toBe("none");

      // Password input should appear
      const pwInput = byTestId<HTMLInputElement>("totp-password-input");
      expect(pwInput).not.toBeNull();

      overlay.destroy?.();
    });

    it("calls onDisableTotp with password on confirm", async () => {
      const { options, overlay } = openOverlay({}, true);

      submitDisablePassword("mypassword123");

      await vi.waitFor(() => {
        expect(options.onDisableTotp).toHaveBeenCalledWith("mypassword123");
      });

      overlay.destroy?.();
    });

    it("shows error on failed disable (bad password)", async () => {
      const { overlay } = openOverlay(
        {
          onDisableTotp: vi.fn().mockRejectedValue(new Error("Wrong password")),
        },
        true,
      );

      const confirmBtn = submitDisablePassword("wrongpassword");

      await vi.waitFor(() => {
        const errorEl = byTestId<HTMLElement>("totp-error");
        expect(errorEl.textContent).toBe("Wrong password");
      });

      // Button should be re-enabled
      expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
      expect(confirmBtn.textContent).toBe("Confirm Disable");

      overlay.destroy?.();
    });

    it("shows 'required' error when server returns 403 for require_2fa policy", async () => {
      const { overlay } = openOverlay(
        {
          onDisableTotp: vi
            .fn()
            .mockRejectedValue(
              new ApiClientError(
                403,
                "FORBIDDEN",
                "two-factor authentication is required for this server",
              ),
            ),
        },
        true,
      );

      submitDisablePassword("mypassword123");

      await vi.waitFor(() => {
        const errorEl = byTestId<HTMLElement>("totp-error");
        expect(errorEl.textContent).toBe("2FA is required by this server and cannot be disabled");
      });

      overlay.destroy?.();
    });

    it("hides confirm area when cancel is clicked", () => {
      const { overlay } = openOverlay({}, true);

      const disableBtn = byTestId<HTMLElement>("totp-disable-btn");
      disableBtn.click();

      // Confirm area should be visible
      const pwInput = byTestId<HTMLInputElement>("totp-password-input");
      expect(pwInput).not.toBeNull();

      // Find the Cancel button that is a sibling of the "Confirm Disable" button
      // inside the TOTP section
      const totpSection = byTestId<HTMLElement>("totp-section");
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
      // Simulate MainPage's onDisableTotp: it calls updateUser after API success
      const { overlay } = openOverlay(
        {
          onDisableTotp: vi.fn().mockImplementation(async () => {
            updateUser({ totp_enabled: false });
          }),
        },
        true,
      );

      submitDisablePassword("mypassword123");

      // After successful disable, onDisabled() is called which re-renders.
      // Since updateUser sets mockTotpEnabled = false, re-render should show enrollment view.
      await vi.waitFor(() => {
        const statusBadge = byTestId<HTMLElement>("totp-status-badge");
        expect(statusBadge.textContent).toBe("Disabled");
      });

      // The enable button should now be visible
      const enableBtn = byTestId<HTMLElement>("totp-enable-btn");
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
      // The onConfirmTotp callback simulates MainPage: it calls updateUser itself
      const { options, overlay } = openOverlay({
        onConfirmTotp: vi.fn().mockImplementation(async () => {
          // MainPage calls updateUser here — this is the single owner
          updateUser({ totp_enabled: true });
        }),
      });

      // Navigate through enable flow
      await reachCodeStep("mypassword123");

      byTestId<HTMLInputElement>("totp-code-input").value = "123456";
      (updateUser as ReturnType<typeof vi.fn>).mockClear();

      byTestId<HTMLElement>("totp-confirm-btn").click();

      await vi.waitFor(() => {
        expect(options.onConfirmTotp).toHaveBeenCalled();
      });

      // updateUser should have been called exactly once (by the callback, not by AccountTab)
      expect(updateUser).toHaveBeenCalledTimes(1);

      overlay.destroy?.();
    });

    it("AccountTab does NOT call updateUser on disable — only the callback owner does", async () => {
      const { options, overlay } = openOverlay(
        {
          onDisableTotp: vi.fn().mockImplementation(async () => {
            updateUser({ totp_enabled: false });
          }),
        },
        true,
      );

      byTestId<HTMLElement>("totp-disable-btn").click();
      byTestId<HTMLInputElement>("totp-password-input").value = "mypassword123";
      (updateUser as ReturnType<typeof vi.fn>).mockClear();

      acButton("Confirm Disable").click();

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

  async function confirmWithPassword(prefix: string, password: string): Promise<void> {
    byTestId<HTMLButtonElement>(`${prefix}-btn`).click();
    byTestId<HTMLInputElement>(`${prefix}-password`).value = password;
    byTestId<HTMLButtonElement>(`${prefix}-submit`).click();
  }

  describe("Regenerate emergency recovery codes", () => {
    const CODES = ["AAAAA-BBBBB", "CCCCC-DDDDD"];

    it("is offered only when 2FA is enabled", () => {
      mockTotpEnabled = false;
      const overlay = createSettingsOverlay(makeOptions());
      overlay.mount(container);
      overlay.open();
      expect(q("[data-testid='totp-regenerate-btn']")).toBeNull();
      overlay.destroy?.();
    });

    it("requires the password, then shows the new set once and clears the password", async () => {
      const { options, overlay } = openOverlay(
        { onRegenerateRecoveryCodes: vi.fn().mockResolvedValue(CODES) },
        true,
      );

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
      overlay.open();

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
      overlay.open();
      await confirmWithPassword("totp-regenerate", "wrong");
      await vi.waitFor(() =>
        expect(byTestId("totp-regenerate-error").textContent).toBe("invalid password"),
      );
      expect(q("[data-testid='totp-regenerated-codes']")).toBeNull();
      overlay.destroy?.();
    });
  });

  describe("Recovery kit", () => {
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
      overlay.open();
      await vi.waitFor(() => expect(byTestId("recovery-kit-status").textContent).toBe(badge));
      expect(byTestId("recovery-kit-btn").textContent).toBe(action);
      overlay.destroy?.();
    });

    it("settles the badge out of 'Checking…' when the status fetch fails (#18)", async () => {
      const overlay = createSettingsOverlay(
        makeOptions({
          onGetRecoveryKitStatus: vi.fn().mockRejectedValue(new Error("network down")),
        }),
      );
      overlay.mount(container);
      overlay.open();

      await vi.waitFor(() =>
        expect(byTestId("recovery-kit-status").textContent).not.toBe("Checking…"),
      );
      expect(container.textContent).toContain("Could not load the recovery kit status.");
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
      overlay.open();

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
      overlay.open();
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

// Regression test for OC-0116: a rejected TOTP verify tore down the TOTP
// overlay (transitionTo("error", ...) leaves formState "totp", and
// updateTotpOverlay hides the overlay for every non-"totp" state), so the
// user was dropped back on the login form with no way to re-enter the code.
import { describe, it, expect, vi } from "vitest";
import * as mocks from "../helpers/connectPageMocks";
import { mountTotpOverlay } from "../helpers/connectPageHarness";
import { useMountContainer } from "../helpers/mountContainer";

vi.mock("../../src/lib/net/credentials", () => mocks.netCredentialsMock());
vi.mock("../../src/features/settings/SettingsOverlay", () => mocks.settingsOverlayMock());

describe("LoginForm TOTP retry after a rejected verify", () => {
  let container: HTMLDivElement;
  useMountContainer((mounted) => {
    container = mounted;
  });

  it("keeps the TOTP overlay open and lets a second code be submitted", async () => {
    const onTotpSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Invalid verification code"))
      .mockResolvedValueOnce(undefined);
    const { page, totpOverlay, totpInput, verifyBtn } = mountTotpOverlay(container, {
      onTotpSubmit,
    });

    totpInput.value = "111111";
    verifyBtn.click();

    await vi.waitFor(() => expect(onTotpSubmit).toHaveBeenCalledTimes(1));
    // Verify button re-enables once the rejected promise settles.
    await vi.waitFor(() => expect(verifyBtn.disabled).toBe(false));

    // The overlay must stay up so the code can be re-entered, instead of
    // being hidden because formState moved to "error".
    expect(totpOverlay.classList.contains("totp-overlay--hidden")).toBe(false);

    // A retry with a fresh code must actually reach onTotpSubmit again.
    totpInput.value = "222222";
    verifyBtn.click();

    await vi.waitFor(() => expect(onTotpSubmit).toHaveBeenCalledTimes(2));
    expect(onTotpSubmit).toHaveBeenNthCalledWith(2, "222222");

    page.destroy?.();
  });
});

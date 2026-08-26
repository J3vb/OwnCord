// Regression test for OC-0116: a rejected TOTP verify tore down the TOTP
// overlay (transitionTo("error", ...) leaves formState "totp", and
// updateTotpOverlay hides the overlay for every non-"totp" state), so the
// user was dropped back on the login form with no way to re-enter the code.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConnectPage } from "../../src/pages/ConnectPage";
import type { ConnectPageCallbacks, SimpleProfile } from "../../src/pages/ConnectPage";

vi.mock("../../src/lib/credentials", () => ({
  loadCredential: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/components/SettingsOverlay", () => ({
  createSettingsOverlay: () => ({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

function makeCallbacks(overrides: Partial<ConnectPageCallbacks> = {}): ConnectPageCallbacks {
  return {
    onLogin: vi.fn().mockResolvedValue(undefined),
    onRegister: vi.fn().mockResolvedValue(undefined),
    onTotpSubmit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const testProfiles: SimpleProfile[] = [{ name: "Test Server", host: "localhost:8443" }];

describe("LoginForm TOTP retry after a rejected verify", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("keeps the TOTP overlay open and lets a second code be submitted", async () => {
    const onTotpSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Invalid verification code"))
      .mockResolvedValueOnce(undefined);
    const page = createConnectPage(makeCallbacks({ onTotpSubmit }), testProfiles);
    page.mount(container);
    page.showTotp();

    const totpOverlay = container.querySelector(".totp-overlay") as HTMLDivElement;
    const totpInput = container.querySelector(".totp-overlay input") as HTMLInputElement;
    const verifyBtn = container.querySelector(".totp-overlay .btn-primary") as HTMLButtonElement;

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

// Regression test for finding v081: handleTotpSubmit (LoginForm.ts) had no
// in-flight guard, so Enter-key auto-repeat (or a fast double-Enter) during
// the verify round trip could fire a second onTotpSubmit call before the
// first resolved. Covered here through ConnectPage, which mounts LoginForm.
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

describe("LoginForm TOTP re-entrancy guard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("ignores a second Enter press fired before the first verify call resolves", async () => {
    let resolveVerify: (() => void) | undefined;
    const onTotpSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveVerify = resolve;
        }),
    );
    const page = createConnectPage(makeCallbacks({ onTotpSubmit }), testProfiles);
    page.mount(container);
    page.showTotp();

    const totpInput = container.querySelector(".totp-overlay input") as HTMLInputElement;
    totpInput.value = "654321";

    // First Enter starts the in-flight request (disables the submit button).
    totpInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(onTotpSubmit).toHaveBeenCalledTimes(1));

    // Auto-repeat / a second Enter while still verifying must not fire again.
    totpInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    totpInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onTotpSubmit).toHaveBeenCalledTimes(1);

    resolveVerify?.();
    await vi.waitFor(() => {
      // Button re-enabled once the in-flight request resolves.
      const verifyBtn = container.querySelector(".totp-overlay .btn-primary") as HTMLButtonElement;
      expect(verifyBtn.disabled).toBe(false);
    });

    // Now that it resolved, a fresh Enter is allowed to submit again.
    totpInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(onTotpSubmit).toHaveBeenCalledTimes(2));

    page.destroy?.();
  });
});

// Regression test for OC-0027: the LoginForm `totpPending` latch is set by
// showTotp() and is only cleared by handleTotpCancel()/resetToIdle() — never
// on a *successful* verify. If a later, unrelated error arrives (e.g. the WS
// auth handshake fails after a successful TOTP verify), updateTotpOverlay()'s
// `formState === "error" && totpPending` branch re-opens the dead 2FA overlay
// over the error banner, and the user is stuck: onTotpSubmit's guard in
// main.ts silently no-ops because the partial token was already consumed.
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

describe("LoginForm TOTP latch after a successful verify", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("does not re-open the TOTP overlay for an error that arrives after a successful verify", async () => {
    const onTotpSubmit = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onTotpSubmit }), testProfiles);
    page.mount(container);
    page.showTotp();

    const totpOverlay = container.querySelector(".totp-overlay") as HTMLDivElement;
    const totpInput = container.querySelector(".totp-overlay input") as HTMLInputElement;
    const verifyBtn = container.querySelector(".totp-overlay .btn-primary") as HTMLButtonElement;

    totpInput.value = "111111";
    verifyBtn.click();

    await vi.waitFor(() => expect(onTotpSubmit).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(verifyBtn.disabled).toBe(false));

    // Verify succeeded — nothing rejected. The caller (main.ts) would now be
    // driving the post-auth WS connect, e.g. via wirePostAuth. That connect
    // can still fail (rotated JWT key, revoked token, ban) and surface an
    // unrelated error through the same showError() path ConnectPage wires up
    // to the uiStore transientError subscription.
    page.showError("Connection failed: unauthorized");

    // The dead 2FA overlay must NOT come back — the token it would collect
    // can never be submitted again (the partial token was already consumed
    // on success), so re-showing it strands the user with no working control
    // except Cancel.
    expect(totpOverlay.classList.contains("totp-overlay--hidden")).toBe(true);

    const errorBanner = container.querySelector(".error-banner") as HTMLDivElement;
    expect(errorBanner.classList.contains("visible")).toBe(true);

    page.destroy?.();
  });
});

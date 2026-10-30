import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/connectPageMocks";
import { ApiClientError, TransportError } from "../../../src/lib/api";
import { createConnectPage } from "../../../src/pages/ConnectPage";
import { makeCallbacks, testProfiles } from "../../helpers/connectPageHarness";

vi.mock("../../../src/lib/net/credentials", () => mocks.netCredentialsMock());
vi.mock("../../../src/components/SettingsOverlay", () => mocks.settingsOverlayMock());
vi.mock("../../../src/stores/ui.store", () => mocks.uiStoreMock());

const { mockLoadCredential } = mocks;

describe("ConnectPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockLoadCredential.mockReset();
    mockLoadCredential.mockResolvedValue(null);
  });

  afterEach(() => {
    container.remove();
  });

  it("TOTP submit rejects invalid code (not 6 digits)", () => {
    const onTotpSubmit = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onTotpSubmit }), testProfiles);
    page.mount(container);

    page.showTotp();

    const totpInput = container.querySelector(".totp-overlay input") as HTMLInputElement;
    totpInput.value = "abc";

    const verifyBtn = container.querySelector(".totp-overlay .btn-primary") as HTMLButtonElement;
    verifyBtn.focus();
    verifyBtn.click();

    expect(onTotpSubmit).not.toHaveBeenCalled();
    expect(totpInput.classList.contains("error")).toBe(true);
    const totpError = container.querySelector("[data-testid='totp-invalid']")!;
    expect(totpError.textContent).not.toBe("");
    expect(totpError.hasAttribute("role")).toBe(false);
    expect(totpInput.getAttribute("aria-describedby")).toBe(totpError.id);
    expect(document.activeElement).toBe(totpInput);

    page.destroy?.();
  });

  it("announces a malformed code submitted with Enter from the focused input", () => {
    const onTotpSubmit = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onTotpSubmit }), testProfiles);
    page.mount(container);

    page.showTotp();
    const totpInput = container.querySelector(".totp-overlay input") as HTMLInputElement;
    expect(document.activeElement).toBe(totpInput);
    totpInput.value = "abc";
    totpInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    // Focus cannot move to the field it is already on, so the error is the
    // one live alert instead.
    expect(onTotpSubmit).not.toHaveBeenCalled();
    const totpError = container.querySelector("[data-testid='totp-invalid']")!;
    expect(totpError.textContent).not.toBe("");
    expect(totpError.getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe(totpInput);

    page.destroy?.();
  });

  it("TOTP cancel returns to idle state", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    page.showTotp();
    const totpOverlay = container.querySelector(".totp-overlay")!;
    expect(totpOverlay.classList.contains("totp-overlay--hidden")).toBe(false);

    const cancelBtn = container.querySelector(".totp-back") as HTMLElement;
    cancelBtn.click();

    expect(totpOverlay.classList.contains("totp-overlay--hidden")).toBe(true);

    page.destroy?.();
  });

  it("TOTP Enter key submits the code", async () => {
    const onTotpSubmit = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onTotpSubmit }), testProfiles);
    page.mount(container);

    page.showTotp();

    const totpInput = container.querySelector(".totp-overlay input") as HTMLInputElement;
    totpInput.value = "654321";

    totpInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => {
      expect(onTotpSubmit).toHaveBeenCalledWith("654321");
    });

    page.destroy?.();
  });

  it("TOTP submit shows error when callback throws", async () => {
    const onTotpSubmit = vi.fn().mockRejectedValue(new Error("Invalid TOTP"));
    const page = createConnectPage(makeCallbacks({ onTotpSubmit }), testProfiles);
    page.mount(container);

    page.showTotp();

    const totpInput = container.querySelector(".totp-overlay input") as HTMLInputElement;
    totpInput.value = "999999";

    const verifyBtn = container.querySelector(".totp-overlay .btn-primary") as HTMLButtonElement;
    verifyBtn.click();

    await vi.waitFor(() => {
      const errorBanner = container.querySelector(".error-banner")!;
      expect(errorBanner.classList.contains("visible")).toBe(true);
      expect(errorBanner.textContent).toBe("Invalid TOTP");
    });

    // Verify button should be re-enabled
    expect(verifyBtn.disabled).toBe(false);
    expect(verifyBtn.textContent).toBe("Verify");

    page.destroy?.();
  });

  it("shows a server-rejected code inside the opaque TOTP overlay, not just the hidden banner (F2)", async () => {
    // The TOTP overlay is opaque and covers the form panel's error banner, so
    // a rejection routed only there is invisible to the user.
    const onTotpSubmit = vi.fn().mockRejectedValue(new Error("Invalid TOTP"));
    const page = createConnectPage(makeCallbacks({ onTotpSubmit }), testProfiles);
    page.mount(container);

    page.showTotp();

    const totpInput = container.querySelector(".totp-overlay input") as HTMLInputElement;
    totpInput.value = "999999";
    (container.querySelector(".totp-overlay .btn-primary") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      const totpError = container.querySelector("[data-testid='totp-invalid']")!;
      expect(totpError.textContent).toBe("Invalid TOTP");
    });

    const totpInputAfter = container.querySelector(".totp-overlay input") as HTMLInputElement;
    expect(totpInputAfter.getAttribute("aria-invalid")).toBe("true");
    // The overlay stays up with the entered code intact for a retry.
    expect(
      container.querySelector(".totp-overlay")!.classList.contains("totp-overlay--hidden"),
    ).toBe(false);

    page.destroy?.();
  });

  it("TOTP submit refused for too many codes shows the lockout copy", async () => {
    const onTotpSubmit = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError(429, "RATE_LIMITED", "too many failed attempts, try again later"),
      );
    const page = createConnectPage(makeCallbacks({ onTotpSubmit }), testProfiles);
    page.mount(container);

    page.showTotp();

    const totpInput = container.querySelector(".totp-overlay input") as HTMLInputElement;
    totpInput.value = "999999";
    (container.querySelector(".totp-overlay .btn-primary") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(container.querySelector(".error-banner")!.textContent).toBe(
        "Too many incorrect codes. Try again later.",
      );
    });

    page.destroy?.();
  });

  // --- Password visibility toggle ---

  it("toggles password visibility when eye button is clicked", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    expect(passwordInput.type).toBe("password");

    const toggleBtn = container.querySelector(".password-toggle") as HTMLButtonElement;
    toggleBtn.click();
    expect(passwordInput.type).toBe("text");

    toggleBtn.click();
    expect(passwordInput.type).toBe("password");

    page.destroy?.();
  });

  // --- Register mode ---

  it("calls onRegister when in register mode with valid form", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onRegister }), testProfiles);
    page.mount(container);

    // Switch to register mode
    const toggleLink = container.querySelector(".form-switch button") as HTMLElement;
    toggleLink.click();

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    const inviteInput = container.querySelector("#invite") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "newuser";
    passwordInput.value = "password123";
    inviteInput.value = "INVITE-CODE";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      // The code is lower-cased before it is sent: server codes are lower-case
      // hex and redemption is case-sensitive.
      expect(onRegister).toHaveBeenCalledWith(
        "localhost:8443",
        "newuser",
        "password123",
        "invite-code",
      );
    });

    page.destroy?.();
  });

  it("accepts a pasted owncord:// invite link and sends just its code", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onRegister }), testProfiles);
    page.mount(container);

    const toggleLink = container.querySelector(".form-switch button") as HTMLElement;
    toggleLink.click();

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    const inviteInput = container.querySelector("#invite") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "newuser";
    passwordInput.value = "password123";
    inviteInput.value = "owncord://invite/AbCd1234";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(onRegister).toHaveBeenCalledWith(
        "localhost:8443",
        "newuser",
        "password123",
        "abcd1234",
      );
    });

    page.destroy?.();
  });

  it("sends just the code of a pasted link that carries the link's host", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onRegister }), testProfiles);
    page.mount(container);

    const toggleLink = container.querySelector(".form-switch button") as HTMLElement;
    toggleLink.click();

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    const inviteInput = container.querySelector("#invite") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "newuser";
    passwordInput.value = "password123";
    inviteInput.value = "owncord://invite/AbCd1234?host=chat.example.com";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(onRegister).toHaveBeenCalledWith(
        "localhost:8443",
        "newuser",
        "password123",
        "abcd1234",
      );
    });

    page.destroy?.();
  });

  it("shows error when register mode missing invite code", async () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    const toggleLink = container.querySelector(".form-switch button") as HTMLElement;
    toggleLink.click();

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "newuser";
    passwordInput.value = "password123";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const errorBanner = container.querySelector(".error-banner")!;
      expect(errorBanner.classList.contains("visible")).toBe(true);
      expect(errorBanner.textContent).toContain("Invite code is required");
    });

    page.destroy?.();
  });

  // --- Error handling in submit ---

  it("shows error when onLogin throws a string", async () => {
    const onLogin = vi.fn().mockRejectedValue("string error");
    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "testuser";
    passwordInput.value = "password123";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const errorBanner = container.querySelector(".error-banner")!;
      expect(errorBanner.textContent).toBe("string error");
    });

    page.destroy?.();
  });

  it("shows error when onLogin throws an object with message", async () => {
    const onLogin = vi.fn().mockRejectedValue({ message: "object error" });
    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "testuser";
    passwordInput.value = "password123";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const errorBanner = container.querySelector(".error-banner")!;
      expect(errorBanner.textContent).toBe("object error");
    });

    page.destroy?.();
  });

  it("shows stringified error when onLogin throws unknown type", async () => {
    const onLogin = vi.fn().mockRejectedValue(42);
    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "testuser";
    passwordInput.value = "password123";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const errorBanner = container.querySelector(".error-banner")!;
      expect(errorBanner.textContent).toBe("42");
    });

    page.destroy?.();
  });

  it("shows friendly copy for a transport failure instead of raw fetch text", async () => {
    const onLogin = vi.fn().mockRejectedValue(new TransportError("Failed to fetch"));
    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "testuser";
    passwordInput.value = "password123";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const errorBanner = container.querySelector(".error-banner")!;
      expect(errorBanner.textContent).toBe(
        "Couldn't reach this server — it may be offline. Check your connection and try again.",
      );
    });

    page.destroy?.();
  });

  // --- showNotice (P4-18): a non-error, informational message ---

  it("shows a pending-approval notice via showNotice, not the red error banner", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    page.showNotice("Registration received. An admin has to approve your account.");

    const notice = container.querySelector(".info-notice")!;
    expect(notice.classList.contains("visible")).toBe(true);
    expect(notice.textContent).toBe("Registration received. An admin has to approve your account.");
    // It is an informational status, not an alert.
    expect(notice.getAttribute("role")).toBe("status");
    expect(container.querySelector(".error-banner")!.classList.contains("visible")).toBe(false);

    page.destroy?.();
  });

  it("clears an info notice when the form next shows an error or goes idle", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    page.showNotice("Approval pending");
    expect(container.querySelector(".info-notice")!.classList.contains("visible")).toBe(true);

    page.showError("Connection refused");
    expect(container.querySelector(".info-notice")!.classList.contains("visible")).toBe(false);
    expect(container.querySelector(".error-banner")!.classList.contains("visible")).toBe(true);

    page.destroy?.();
  });

  it("truncates an over-long auth error to 200 chars plus ellipsis (anti-phishing cap)", async () => {
    const onLogin = vi.fn().mockRejectedValue(new Error("x".repeat(500)));
    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "testuser";
    passwordInput.value = "password123";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const errorBanner = container.querySelector(".error-banner")!;
      expect(errorBanner.textContent).toBe("x".repeat(200) + "...");
      expect(errorBanner.textContent).toHaveLength(203);
    });

    page.destroy?.();
  });

  // --- Empty username validation ---

  it("shows error when username is empty", async () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    passwordInput.value = "password123";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const errorBanner = container.querySelector(".error-banner")!;
      expect(errorBanner.textContent).toContain("Username is required");
    });

    page.destroy?.();
  });

  it("shows error when password is empty", async () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "testuser";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const errorBanner = container.querySelector(".error-banner")!;
      expect(errorBanner.textContent).toContain("Password is required");
    });

    page.destroy?.();
  });

  // --- Duplicate submit prevention ---

  it("ignores submit while already loading", async () => {
    let resolveLogin: () => void;
    const loginPromise = new Promise<void>((resolve) => {
      resolveLogin = resolve;
    });
    const onLogin = vi.fn().mockReturnValue(loginPromise);

    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "testuser";
    passwordInput.value = "password123";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(onLogin).toHaveBeenCalledTimes(1);
    });

    // Submit again while loading
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onLogin).toHaveBeenCalledTimes(1);

    resolveLogin!();
    page.destroy?.();
  });

  // --- Toggle mode clears error ---

  it("toggling mode clears existing error state", async () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    page.showError("Some error");
    const errorBanner = container.querySelector(".error-banner")!;
    expect(errorBanner.classList.contains("visible")).toBe(true);

    const toggleLink = container.querySelector(".form-switch button") as HTMLElement;
    toggleLink.click();

    expect(errorBanner.classList.contains("visible")).toBe(false);

    page.destroy?.();
  });

  // --- Toggle back to login ---

  it("toggling back to login shows correct text", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    const toggleLink = container.querySelector(".form-switch button") as HTMLElement;
    toggleLink.click(); // to register
    toggleLink.click(); // back to login

    const btnText = container.querySelector(".btn-text");
    expect(btnText?.textContent).toBe("Login");
    expect(toggleLink.textContent).toContain("Need an account?");

    page.destroy?.();
  });

  // --- Credential loaded guard (host mismatch) ---

  it("does not apply credentials when host has changed before onCredentialLoaded", async () => {
    mockLoadCredential.mockResolvedValue({ username: "loaded", token: "tok", hasPassword: true });
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    // Click server item to trigger credential loading
    const serverItem = container.querySelector(".server-item") as HTMLElement;
    serverItem.click();

    // Immediately change host
    const hostInput = container.querySelector("#host") as HTMLInputElement;
    hostInput.value = "different-host:8443";

    // Wait for credential loading to complete
    await new Promise((r) => setTimeout(r, 20));

    // Username should not be updated due to host mismatch guard
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    // The onServerClick call doesn't have a username in testProfiles, so it stays empty
    // The credential should NOT be applied because host changed
    expect(usernameInput.value).toBe("");

    page.destroy?.();
  });

  // --- Settings gear ---

  it("opens settings when gear button is clicked", async () => {
    const { openSettings } = await import("../../../src/stores/ui.store");
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    const gearBtn = container.querySelector(".settings-gear") as HTMLButtonElement;
    gearBtn.click();

    expect(openSettings).toHaveBeenCalledTimes(1);

    page.destroy?.();
  });

  // OC-0083: destroy() must clear settingsOpen — otherwise MainPage, which
  // mounts its own SettingsOverlay eagerly and shows it off a stale
  // settingsOpen === true, pops the settings panel open over the freshly
  // loaded app right after login.
  it("closes settings on destroy so the flag doesn't leak into the next page", async () => {
    const { closeSettings } = await import("../../../src/stores/ui.store");
    vi.mocked(closeSettings).mockClear();
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    page.destroy?.();

    expect(closeSettings).toHaveBeenCalledTimes(1);
  });

  // --- setCredentials with password sets remember checkbox ---

  it("a saved password checks the remember-password box and fills a placeholder", async () => {
    mockLoadCredential.mockResolvedValue({ username: "user", token: "tok", hasPassword: true });
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    const serverItem = container.querySelector(".server-item") as HTMLElement;
    serverItem.click();

    await vi.waitFor(() => {
      expect(page.getRememberPassword()).toBe(true);
    });

    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    expect(passwordInput.value).not.toBe("");
    expect(passwordInput.value).not.toBe("pass123");
    // The property that actually matters: the box is on the saved-password
    // path, not merely filled with something non-empty.
    expect(page.isUsingSavedPassword()).toBe(true);

    page.destroy?.();
  });

  // --- Status bar states ---

  it("status bar is hidden on idle/error/totp states and visible on loading/connecting", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    const statusBar = container.querySelector(".status-bar")!;

    // idle
    expect(statusBar.classList.contains("visible")).toBe(false);

    // connecting
    page.showConnecting();
    expect(statusBar.classList.contains("visible")).toBe(true);

    // back to idle
    page.resetToIdle();
    expect(statusBar.classList.contains("visible")).toBe(false);

    // totp
    page.showTotp();
    expect(statusBar.classList.contains("visible")).toBe(false);

    // error
    page.showError("err");
    expect(statusBar.classList.contains("visible")).toBe(false);

    page.destroy?.();
  });

  // --- Loading state button text ---

  it("shows correct button text during loading states", async () => {
    let resolveLogin: () => void;
    const loginPromise = new Promise<void>((resolve) => {
      resolveLogin = resolve;
    });
    const onLogin = vi.fn().mockReturnValue(loginPromise);

    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "testuser";
    passwordInput.value = "password123";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const btnText = container.querySelector(".btn-text")!;
      expect(btnText.textContent).toContain("Logging in");
    });

    resolveLogin!();
    page.destroy?.();
  });

  it("shows registering text in register mode during loading", async () => {
    let resolveRegister: () => void;
    const registerPromise = new Promise<void>((resolve) => {
      resolveRegister = resolve;
    });
    const onRegister = vi.fn().mockReturnValue(registerPromise);

    const page = createConnectPage(makeCallbacks({ onRegister }), testProfiles);
    page.mount(container);

    // Switch to register mode
    const toggleLink = container.querySelector(".form-switch button") as HTMLElement;
    toggleLink.click();

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    const inviteInput = container.querySelector("#invite") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "newuser";
    passwordInput.value = "password123";
    inviteInput.value = "CODE";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const btnText = container.querySelector(".btn-text")!;
      expect(btnText.textContent).toContain("Registering");
    });

    resolveRegister!();
    page.destroy?.();
  });

  // --- Auto-connect overlay hidden by default ---

  it("auto-connect overlay is hidden by default", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    const overlay = container.querySelector(".auto-connect-overlay")!;
    expect(overlay.classList.contains("auto-connect-overlay--hidden")).toBe(true);

    page.destroy?.();
  });

  // --- Uses default profiles when none provided ---

  it("uses default profiles when no initialProfiles provided", () => {
    const page = createConnectPage(makeCallbacks());
    page.mount(container);

    const serverItems = container.querySelectorAll(".server-item");
    expect(serverItems.length).toBe(1);

    const serverHost = container.querySelector(".srv-host");
    expect(serverHost?.textContent).toBe("localhost:8443");

    page.destroy?.();
  });

  // ── Registration mode awareness (B7-15a) ─────────────────────────────────
  //
  // LoginForm reads the host's registration mode through the ConnectPage
  // `getRegistrationMode` callback (fed from main.ts's per-host server-info
  // snapshot). `closed` refuses register with a stated reason; `open` and
  // `approval` submit without an invite code; `approval` also shows the
  // pending-approval notice up front; an unavailable mode falls back to
  // today's invite-required form.

  /** Fill the register form, leaving the invite field at `invite`. */
  function fillRegisterForm(el: HTMLDivElement, invite: string | null): HTMLFormElement {
    // The mode is keyed by host, so set it (and let the input handler re-derive)
    // before switching to register.
    const host = el.querySelector("#host") as HTMLInputElement;
    host.value = "localhost:8443";
    host.dispatchEvent(new Event("input", { bubbles: true }));
    const toggle = el.querySelector(".form-switch button") as HTMLElement;
    toggle.click();
    (el.querySelector("#username") as HTMLInputElement).value = "newuser";
    (el.querySelector("#password") as HTMLInputElement).value = "password123";
    if (invite !== null) {
      (el.querySelector("#invite") as HTMLInputElement).value = invite;
    }
    return el.querySelector(".connect-form") as HTMLFormElement;
  }

  /** Select a host and enter register mode, in the order a real user would. */
  function selectHostAndRegister(el: HTMLDivElement): void {
    const host = el.querySelector("#host") as HTMLInputElement;
    host.value = "localhost:8443";
    host.dispatchEvent(new Event("input", { bubbles: true }));
    (el.querySelector(".form-switch button") as HTMLElement).click();
  }

  describe("typed host probe (register mode)", () => {
    afterEach(() => vi.useRealTimers());

    function typeHost(el: HTMLDivElement, value: string): void {
      const host = el.querySelector("#host") as HTMLInputElement;
      host.value = value;
      host.dispatchEvent(new Event("input", { bubbles: true }));
    }

    it("register mode on a typed host probes its server-info and shows the open-registration form", () => {
      vi.useFakeTimers();
      const modes = new Map<string, "open">();
      const onHostSettled = vi.fn((host: string) => modes.set(host, "open"));
      const page = createConnectPage(
        makeCallbacks({ onHostSettled, getRegistrationMode: (h) => modes.get(h) ?? null }),
        testProfiles,
      );
      page.mount(container);
      (container.querySelector(".form-switch button") as HTMLElement).click();
      typeHost(container, "typed.example:8443");
      expect(onHostSettled).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(onHostSettled).toHaveBeenCalledExactlyOnceWith("typed.example:8443");
      // The probe lands through the page's compatibility path, which re-renders.
      page.updateCompatibility("typed.example:8443", "compatible", 1);
      expect(
        container
          .querySelector("#invite")!
          .closest(".form-group")!
          .classList.contains("form-group--hidden"),
      ).toBe(true);
      page.destroy?.();
    });

    it("does not probe in login mode", () => {
      vi.useFakeTimers();
      const onHostSettled = vi.fn();
      const page = createConnectPage(makeCallbacks({ onHostSettled }), testProfiles);
      page.mount(container);
      typeHost(container, "typed.example:8443");
      vi.advanceTimersByTime(1000);
      expect(onHostSettled).not.toHaveBeenCalled();
      page.destroy?.();
    });
  });

  it("invite mode requires an invite code and hides no notice", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(
      makeCallbacks({ onRegister, getRegistrationMode: () => "invite" }),
      testProfiles,
    );
    page.mount(container);

    const form = fillRegisterForm(container, null);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(container.querySelector(".error-banner")!.classList.contains("visible")).toBe(true);
    });
    expect(onRegister).not.toHaveBeenCalled();
    expect(container.querySelector(".registration-notice")!.classList.contains("visible")).toBe(
      false,
    );

    page.destroy?.();
  });

  it("open mode submits without an invite code", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(
      makeCallbacks({ onRegister, getRegistrationMode: () => "open" }),
      testProfiles,
    );
    page.mount(container);

    const form = fillRegisterForm(container, null);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(onRegister).toHaveBeenCalledWith("localhost:8443", "newuser", "password123", "");
    });

    page.destroy?.();
  });

  it("approval mode submits without a code and shows the pending-approval notice up front", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(
      makeCallbacks({ onRegister, getRegistrationMode: () => "approval" }),
      testProfiles,
    );
    page.mount(container);

    const form = fillRegisterForm(container, null);

    const notice = container.querySelector(".registration-notice")!;
    expect(notice.classList.contains("visible")).toBe(true);
    expect(notice.textContent).toContain("admin must approve");

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(onRegister).toHaveBeenCalledWith("localhost:8443", "newuser", "password123", "");
    });

    page.destroy?.();
  });

  it("closed mode disables register and states why", () => {
    const onRegister = vi.fn();
    const page = createConnectPage(
      makeCallbacks({ onRegister, getRegistrationMode: () => "closed" }),
      testProfiles,
    );
    page.mount(container);

    selectHostAndRegister(container);

    const submit = container.querySelector(".btn-primary[type='submit']") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const notice = container.querySelector(".registration-notice")!;
    expect(notice.classList.contains("visible")).toBe(true);
    expect(notice.textContent).toContain("Registration is closed");

    // Even a forced submit refuses and never reaches the callback.
    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onRegister).not.toHaveBeenCalled();

    page.destroy?.();
  });
  // B7-15c: the server-default retention window is disclosed at sign-up.
  it("discloses the retention window in register mode, not at login or when closed", () => {
    const retention = "By default this server deletes messages after 30 days.";
    const getRetentionNotice = vi.fn((host: string) =>
      host === "localhost:8443" ? retention : null,
    );
    let mode: import("../../../src/lib/types").RegistrationMode = "open";
    const page = createConnectPage(
      makeCallbacks({ getRegistrationMode: () => mode, getRetentionNotice }),
      testProfiles,
    );
    page.mount(container);
    const notice = container.querySelector(".registration-notice")!;
    const host = container.querySelector("#host") as HTMLInputElement;
    host.value = "localhost:8443";
    host.dispatchEvent(new Event("input", { bubbles: true }));
    expect(notice.textContent).not.toContain(retention);

    (container.querySelector(".form-switch button") as HTMLElement).click();
    expect(notice.classList.contains("visible")).toBe(true);
    expect(notice.textContent).toBe(retention);

    mode = "approval";
    host.dispatchEvent(new Event("input", { bubbles: true }));
    expect(notice.textContent).toContain("admin must approve");
    expect(notice.textContent).toContain(retention);

    mode = "closed";
    host.dispatchEvent(new Event("input", { bubbles: true }));
    expect(notice.textContent).toBe("Registration is closed on this server.");

    page.destroy?.();
  });

  it("an unavailable mode (no snapshot) still requires an invite code", async () => {
    // No `getRegistrationMode` callback at all — the older-server / failed-read
    // fallback. Registration must not be silently widened.
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onRegister }), testProfiles);
    page.mount(container);

    const form = fillRegisterForm(container, null);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const banner = container.querySelector(".error-banner")!;
      expect(banner.classList.contains("visible")).toBe(true);
      expect(banner.textContent).toContain("Invite code is required");
    });
    expect(onRegister).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("an unknown mode string (null from the parser) still requires an invite code", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(
      makeCallbacks({ onRegister, getRegistrationMode: () => null }),
      testProfiles,
    );
    page.mount(container);

    const form = fillRegisterForm(container, null);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(container.querySelector(".error-banner")!.textContent).toContain(
        "Invite code is required",
      );
    });
    expect(onRegister).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("re-derives the mode when server-info arrives after a host is selected", () => {
    let mode: import("../../../src/lib/types").RegistrationMode | null = null;
    const page = createConnectPage(
      makeCallbacks({ getRegistrationMode: () => mode }),
      testProfiles,
    );
    page.mount(container);

    (container.querySelector(".server-item") as HTMLElement).click();
    const toggle = container.querySelector(".form-switch button") as HTMLElement;
    toggle.click();
    expect(
      (container.querySelector(".btn-primary[type='submit']") as HTMLButtonElement).disabled,
    ).toBe(false);

    // A late snapshot flips the host to `closed`; updateCompatibility nudges
    // the form to re-read it.
    mode = "closed";
    page.updateCompatibility("localhost:8443", "compatible", 1);

    const submit = container.querySelector(".btn-primary[type='submit']") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(container.querySelector(".registration-notice")!.textContent).toContain(
      "Registration is closed",
    );

    page.destroy?.();
  });

  it("an invite link to another host re-derives the mode while already registering", () => {
    const page = createConnectPage(
      makeCallbacks({
        getRegistrationMode: (host) => (host === "localhost:8443" ? "open" : "closed"),
      }),
      testProfiles,
    );
    page.mount(container);

    selectHostAndRegister(container);
    const submit = container.querySelector(".btn-primary[type='submit']") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    page.applyInviteLink("abc123", "other.example:8443");

    expect(submit.disabled).toBe(true);
    expect(container.querySelector(".registration-notice")!.textContent).toContain(
      "Registration is closed",
    );

    page.destroy?.();
  });
});

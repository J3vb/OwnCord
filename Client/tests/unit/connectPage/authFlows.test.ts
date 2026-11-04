import { describe, it, expect, vi, afterEach } from "vitest";
import * as mocks from "../../helpers/connectPageMocks";
import { ApiClientError, TransportError } from "../../../src/lib/api";
import { createConnectPage } from "../../../src/pages/ConnectPage";
import {
  makeCallbacks,
  useConnectPageContainer,
  mountPage,
  qs,
  submitForm,
  setField,
  fillLogin,
  switchMode,
  waitForCall,
  waitForCalls,
  expectBannerVisible,
  signIn,
  expectBannerText,
  expectBannerContains,
  pendingLogin,
  mountTotp,
  clickVerify,
} from "../../helpers/connectPageHarness";

vi.mock("../../../src/lib/net/credentials", () => mocks.netCredentialsMock());
vi.mock("../../../src/features/settings/SettingsOverlay", () => mocks.settingsOverlayMock());
vi.mock("../../../src/stores/ui.store", () => mocks.uiStoreMock());

const { mockLoadCredential } = mocks;

describe("ConnectPage", () => {
  let container: HTMLDivElement;
  useConnectPageContainer((mounted) => {
    container = mounted;
  });

  it("TOTP submit rejects invalid code (not 6 digits)", () => {
    const onTotpSubmit = vi.fn().mockResolvedValue(undefined);
    const { page, totpInput } = mountTotp(container, { onTotpSubmit });
    totpInput.value = "abc";

    const verifyBtn = qs<HTMLButtonElement>(container, ".totp-overlay .btn-primary");
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
    const { page, totpInput } = mountTotp(container, { onTotpSubmit });
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
    const page = mountPage(container);

    page.showTotp();
    const totpOverlay = container.querySelector(".totp-overlay")!;
    expect(totpOverlay.classList.contains("totp-overlay--hidden")).toBe(false);

    const cancelBtn = qs<HTMLElement>(container, ".totp-back");
    cancelBtn.click();

    expect(totpOverlay.classList.contains("totp-overlay--hidden")).toBe(true);

    page.destroy?.();
  });

  it("TOTP Enter key submits the code", async () => {
    const onTotpSubmit = vi.fn().mockResolvedValue(undefined);
    const { page, totpInput } = mountTotp(container, { onTotpSubmit });
    totpInput.value = "654321";

    totpInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await waitForCall(onTotpSubmit, "654321");

    page.destroy?.();
  });

  it("TOTP submit shows error when callback throws", async () => {
    const onTotpSubmit = vi.fn().mockRejectedValue(new Error("Invalid TOTP"));
    const { page, totpInput } = mountTotp(container, { onTotpSubmit });
    totpInput.value = "999999";

    const verifyBtn = qs<HTMLButtonElement>(container, ".totp-overlay .btn-primary");
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
    const { page, totpInput } = mountTotp(container, { onTotpSubmit });
    totpInput.value = "999999";
    clickVerify(container);

    await vi.waitFor(() => {
      const totpError = container.querySelector("[data-testid='totp-invalid']")!;
      expect(totpError.textContent).toBe("Invalid TOTP");
    });

    const totpInputAfter = qs<HTMLInputElement>(container, ".totp-overlay input");
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
    const { page, totpInput } = mountTotp(container, { onTotpSubmit });
    totpInput.value = "999999";
    clickVerify(container);

    await vi.waitFor(() => {
      expect(container.querySelector(".error-banner")!.textContent).toBe(
        "Too many incorrect codes. Try again later.",
      );
    });

    page.destroy?.();
  });

  // --- Password visibility toggle ---

  it("toggles password visibility when eye button is clicked", () => {
    const page = mountPage(container);

    const passwordInput = qs<HTMLInputElement>(container, "#password");
    expect(passwordInput.type).toBe("password");

    const toggleBtn = qs<HTMLButtonElement>(container, ".password-toggle");
    toggleBtn.click();
    expect(passwordInput.type).toBe("text");

    toggleBtn.click();
    expect(passwordInput.type).toBe("password");

    page.destroy?.();
  });

  // --- Register mode ---

  it("calls onRegister when in register mode with valid form", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = mountPage(container, { onRegister });

    // Switch to register mode
    switchMode(container);

    fillLogin(container, "localhost:8443", "newuser", "password123");
    setField(container, "#invite", "INVITE-CODE");

    submitForm(container);

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
    const page = mountPage(container, { onRegister });

    switchMode(container);

    fillLogin(container, "localhost:8443", "newuser", "password123");
    setField(container, "#invite", "owncord://invite/AbCd1234");

    submitForm(container);

    await waitForCall(onRegister, "localhost:8443", "newuser", "password123", "abcd1234");

    page.destroy?.();
  });

  it("sends just the code of a pasted link that carries the link's host", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = mountPage(container, { onRegister });

    switchMode(container);

    fillLogin(container, "localhost:8443", "newuser", "password123");
    setField(container, "#invite", "owncord://invite/AbCd1234?host=chat.example.com");

    submitForm(container);

    await waitForCall(onRegister, "localhost:8443", "newuser", "password123", "abcd1234");

    page.destroy?.();
  });

  it("shows error when register mode missing invite code", async () => {
    const page = mountPage(container);

    switchMode(container);

    signIn(container, "localhost:8443", "newuser", "password123");

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
    const page = mountPage(container, { onLogin });

    signIn(container, "localhost:8443", "testuser", "password123");

    await expectBannerText(container, "string error");

    page.destroy?.();
  });

  it("shows error when onLogin throws an object with message", async () => {
    const onLogin = vi.fn().mockRejectedValue({ message: "object error" });
    const page = mountPage(container, { onLogin });

    signIn(container, "localhost:8443", "testuser", "password123");

    await expectBannerText(container, "object error");

    page.destroy?.();
  });

  it("shows stringified error when onLogin throws unknown type", async () => {
    const onLogin = vi.fn().mockRejectedValue(42);
    const page = mountPage(container, { onLogin });

    signIn(container, "localhost:8443", "testuser", "password123");

    await expectBannerText(container, "42");

    page.destroy?.();
  });

  it("shows friendly copy for a transport failure instead of raw fetch text", async () => {
    const onLogin = vi.fn().mockRejectedValue(new TransportError("Failed to fetch"));
    const page = mountPage(container, { onLogin });

    signIn(container, "localhost:8443", "testuser", "password123");

    await expectBannerText(
      container,
      "Couldn't reach this server — it may be offline. Check your connection and try again.",
    );

    page.destroy?.();
  });

  // --- showNotice (P4-18): a non-error, informational message ---

  it("shows a pending-approval notice via showNotice, not the red error banner", () => {
    const page = mountPage(container);

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
    const page = mountPage(container);

    page.showNotice("Approval pending");
    expect(container.querySelector(".info-notice")!.classList.contains("visible")).toBe(true);

    page.showError("Connection refused");
    expect(container.querySelector(".info-notice")!.classList.contains("visible")).toBe(false);
    expect(container.querySelector(".error-banner")!.classList.contains("visible")).toBe(true);

    page.destroy?.();
  });

  it("truncates an over-long auth error to 200 chars plus ellipsis (anti-phishing cap)", async () => {
    const onLogin = vi.fn().mockRejectedValue(new Error("x".repeat(500)));
    const page = mountPage(container, { onLogin });

    signIn(container, "localhost:8443", "testuser", "password123");

    await expectBannerText(container, "x".repeat(200) + "...");
    expect(qs(container, ".error-banner").textContent).toHaveLength(203);

    page.destroy?.();
  });

  // --- Empty username validation ---

  it("shows error when username is empty", async () => {
    const page = mountPage(container);

    const hostInput = qs<HTMLInputElement>(container, "#host");
    const passwordInput = qs<HTMLInputElement>(container, "#password");

    hostInput.value = "localhost:8443";
    passwordInput.value = "password123";

    submitForm(container);

    await expectBannerContains(container, "Username is required");

    page.destroy?.();
  });

  it("shows error when password is empty", async () => {
    const page = mountPage(container);

    const hostInput = qs<HTMLInputElement>(container, "#host");
    const usernameInput = qs<HTMLInputElement>(container, "#username");

    hostInput.value = "localhost:8443";
    usernameInput.value = "testuser";

    submitForm(container);

    await expectBannerContains(container, "Password is required");

    page.destroy?.();
  });

  // --- Duplicate submit prevention ---

  it("ignores submit while already loading", async () => {
    const { onLogin, resolveLogin } = pendingLogin();

    const page = mountPage(container, { onLogin });

    signIn(container, "localhost:8443", "testuser", "password123");

    await waitForCalls(onLogin, 1);

    // Submit again while loading
    submitForm(container);
    expect(onLogin).toHaveBeenCalledTimes(1);

    resolveLogin();
    page.destroy?.();
  });

  // --- Toggle mode clears error ---

  it("toggling mode clears existing error state", async () => {
    const page = mountPage(container);

    page.showError("Some error");
    const errorBanner = container.querySelector(".error-banner")!;
    expect(errorBanner.classList.contains("visible")).toBe(true);

    switchMode(container);

    expect(errorBanner.classList.contains("visible")).toBe(false);

    page.destroy?.();
  });

  // --- Toggle back to login ---

  it("toggling back to login shows correct text", () => {
    const page = mountPage(container);

    const toggleLink = qs<HTMLElement>(container, ".form-switch button");
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
    const page = mountPage(container);

    // Click server item to trigger credential loading
    const serverItem = qs<HTMLElement>(container, ".server-item");
    serverItem.click();

    // Immediately change host
    const hostInput = qs<HTMLInputElement>(container, "#host");
    hostInput.value = "different-host:8443";

    // Wait for credential loading to complete
    await new Promise((r) => setTimeout(r, 20));

    // Username should not be updated due to host mismatch guard
    const usernameInput = qs<HTMLInputElement>(container, "#username");
    // The onServerClick call doesn't have a username in testProfiles, so it stays empty
    // The credential should NOT be applied because host changed
    expect(usernameInput.value).toBe("");

    page.destroy?.();
  });

  // --- Settings gear ---

  it("opens settings when gear button is clicked", async () => {
    const { openSettings } = await import("../../../src/stores/ui.store");
    const page = mountPage(container);

    const gearBtn = qs<HTMLButtonElement>(container, ".settings-gear");
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
    const page = mountPage(container);

    page.destroy?.();

    expect(closeSettings).toHaveBeenCalledTimes(1);
  });

  // --- setCredentials with password sets remember checkbox ---

  it("a saved password checks the remember-password box and fills a placeholder", async () => {
    mockLoadCredential.mockResolvedValue({ username: "user", token: "tok", hasPassword: true });
    const page = mountPage(container);

    const serverItem = qs<HTMLElement>(container, ".server-item");
    serverItem.click();

    await vi.waitFor(() => {
      expect(page.getRememberPassword()).toBe(true);
    });

    const passwordInput = qs<HTMLInputElement>(container, "#password");
    expect(passwordInput.value).not.toBe("");
    expect(passwordInput.value).not.toBe("pass123");
    // The property that actually matters: the box is on the saved-password
    // path, not merely filled with something non-empty.
    expect(page.isUsingSavedPassword()).toBe(true);

    page.destroy?.();
  });

  // --- Status bar states ---

  it("status bar is hidden on idle/error/totp states and visible on loading/connecting", () => {
    const page = mountPage(container);

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
    const { onLogin, resolveLogin } = pendingLogin();

    const page = mountPage(container, { onLogin });

    signIn(container, "localhost:8443", "testuser", "password123");

    await vi.waitFor(() => {
      const btnText = container.querySelector(".btn-text")!;
      expect(btnText.textContent).toContain("Logging in");
    });

    resolveLogin();
    page.destroy?.();
  });

  it("shows registering text in register mode during loading", async () => {
    let resolveRegister: () => void;
    const registerPromise = new Promise<void>((resolve) => {
      resolveRegister = resolve;
    });
    const onRegister = vi.fn().mockReturnValue(registerPromise);

    const page = mountPage(container, { onRegister });

    // Switch to register mode
    switchMode(container);

    fillLogin(container, "localhost:8443", "newuser", "password123");
    setField(container, "#invite", "CODE");

    submitForm(container);

    await vi.waitFor(() => {
      const btnText = container.querySelector(".btn-text")!;
      expect(btnText.textContent).toContain("Registering");
    });

    resolveRegister!();
    page.destroy?.();
  });

  // --- Auto-connect overlay hidden by default ---

  it("auto-connect overlay is hidden by default", () => {
    const page = mountPage(container);

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
      const page = mountPage(container, {
        onHostSettled,
        getRegistrationMode: (h) => modes.get(h) ?? null,
      });
      switchMode(container);
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
      const page = mountPage(container, { onHostSettled });
      typeHost(container, "typed.example:8443");
      vi.advanceTimersByTime(1000);
      expect(onHostSettled).not.toHaveBeenCalled();
      page.destroy?.();
    });
  });

  it("invite mode requires an invite code and hides no notice", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = mountPage(container, { onRegister, getRegistrationMode: () => "invite" });

    const form = fillRegisterForm(container, null);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await expectBannerVisible(container);
    expect(onRegister).not.toHaveBeenCalled();
    expect(container.querySelector(".registration-notice")!.classList.contains("visible")).toBe(
      false,
    );

    page.destroy?.();
  });

  it("open mode submits without an invite code", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = mountPage(container, { onRegister, getRegistrationMode: () => "open" });

    const form = fillRegisterForm(container, null);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await waitForCall(onRegister, "localhost:8443", "newuser", "password123", "");

    page.destroy?.();
  });

  it("approval mode submits without a code and shows the pending-approval notice up front", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = mountPage(container, { onRegister, getRegistrationMode: () => "approval" });

    const form = fillRegisterForm(container, null);

    const notice = container.querySelector(".registration-notice")!;
    expect(notice.classList.contains("visible")).toBe(true);
    expect(notice.textContent).toContain("admin must approve");

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitForCall(onRegister, "localhost:8443", "newuser", "password123", "");

    page.destroy?.();
  });

  it("closed mode disables register and states why", () => {
    const onRegister = vi.fn();
    const page = mountPage(container, { onRegister, getRegistrationMode: () => "closed" });

    selectHostAndRegister(container);

    const submit = qs<HTMLButtonElement>(container, ".btn-primary[type='submit']");
    expect(submit.disabled).toBe(true);
    const notice = container.querySelector(".registration-notice")!;
    expect(notice.classList.contains("visible")).toBe(true);
    expect(notice.textContent).toContain("Registration is closed");

    // Even a forced submit refuses and never reaches the callback.
    submitForm(container);
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
    const page = mountPage(container, { getRegistrationMode: () => mode, getRetentionNotice });
    const notice = container.querySelector(".registration-notice")!;
    const host = qs<HTMLInputElement>(container, "#host");
    host.value = "localhost:8443";
    host.dispatchEvent(new Event("input", { bubbles: true }));
    expect(notice.textContent).not.toContain(retention);

    switchMode(container);
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
    const page = mountPage(container, { onRegister });

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
    const page = mountPage(container, { onRegister, getRegistrationMode: () => null });

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
    const page = mountPage(container, { getRegistrationMode: () => mode });

    qs<HTMLElement>(container, ".server-item").click();
    switchMode(container);
    expect(qs<HTMLButtonElement>(container, ".btn-primary[type='submit']").disabled).toBe(false);

    // A late snapshot flips the host to `closed`; updateCompatibility nudges
    // the form to re-read it.
    mode = "closed";
    page.updateCompatibility("localhost:8443", "compatible", 1);

    const submit = qs<HTMLButtonElement>(container, ".btn-primary[type='submit']");
    expect(submit.disabled).toBe(true);
    expect(container.querySelector(".registration-notice")!.textContent).toContain(
      "Registration is closed",
    );

    page.destroy?.();
  });

  it("an invite link to another host re-derives the mode while already registering", () => {
    const page = mountPage(container, {
      getRegistrationMode: (host) => (host === "localhost:8443" ? "open" : "closed"),
    });

    selectHostAndRegister(container);
    const submit = qs<HTMLButtonElement>(container, ".btn-primary[type='submit']");
    expect(submit.disabled).toBe(false);

    page.applyInviteLink("abc123", "other.example:8443");

    expect(submit.disabled).toBe(true);
    expect(container.querySelector(".registration-notice")!.textContent).toContain(
      "Registration is closed",
    );

    page.destroy?.();
  });
});

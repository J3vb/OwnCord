import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/connectPageMocks";
import { ApiClientError, TLS_CERT_CODE } from "../../../src/lib/api";
import { createConnectPage } from "../../../src/pages/ConnectPage";
import type { ConnectPageCallbacks } from "../../../src/pages/ConnectPage";
import { makeCallbacks, testProfiles, dropFocusToBody } from "../../helpers/connectPageHarness";

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

  it("renders the connect page with form elements", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    expect(container.querySelector(".connect-page")).not.toBeNull();
    expect(container.querySelector(".connect-form")).not.toBeNull();
    expect(container.querySelector("#host")).not.toBeNull();
    expect(container.querySelector("#username")).not.toBeNull();
    expect(container.querySelector("#password")).not.toBeNull();

    page.destroy?.();
  });

  it("renders server profiles in the server panel", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    const serverItems = container.querySelectorAll(".server-item");
    expect(serverItems.length).toBe(1);

    const serverName = container.querySelector(".srv-name");
    expect(serverName?.textContent).toBe("Test Server");

    page.destroy?.();
  });

  it("fills host input when a server profile is clicked", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    const serverItem = container.querySelector(".server-item") as HTMLElement;
    serverItem.click();

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    expect(hostInput.value).toBe("localhost:8443");

    page.destroy?.();
  });

  it("does not throw an unhandled rejection when loadCredential rejects on a server click", async () => {
    // ServerPanel's click handler fires an unawaited loadCredential() to
    // auto-fill the password box; a rejection there must be caught, not left
    // to become an unhandled rejection.
    mockLoadCredential.mockRejectedValue(new Error("keychain locked"));

    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    const serverItem = container.querySelector(".server-item") as HTMLElement;
    serverItem.click();

    await vi.waitFor(() => {
      expect(mockLoadCredential).toHaveBeenCalledWith("localhost:8443");
    });
    // Give the rejected promise's catch handler a turn to run before the
    // test ends, or an unhandled-rejection would surface after this test.
    await new Promise((resolve) => setTimeout(resolve, 0));

    page.destroy?.();
  });

  it("shows error when submitting empty form", async () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    // Clear any default host value
    const hostInput = container.querySelector("#host") as HTMLInputElement;
    hostInput.value = "";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    // Wait for async handler
    await vi.waitFor(() => {
      const errorBanner = container.querySelector(".error-banner");
      expect(errorBanner!.classList.contains("visible")).toBe(true);
    });

    page.destroy?.();
  });

  it("shows validation error for short password", async () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "testuser";
    passwordInput.value = "short";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const errorBanner = container.querySelector(".error-banner");
      expect(errorBanner!.classList.contains("visible")).toBe(true);
      expect(errorBanner!.textContent).toContain("at least 8 characters");
    });
    // A field error is announced once: through the focused field's
    // description, not also through a live alert.
    const errorBanner = container.querySelector(".error-banner")!;
    expect(errorBanner.hasAttribute("role")).toBe(false);
    expect(passwordInput.getAttribute("aria-describedby")).toBe(errorBanner.id);
    expect(document.activeElement).toBe(passwordInput);

    page.destroy?.();
  });

  it("announces a field error as an alert when that field already has focus", async () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    (container.querySelector("#host") as HTMLInputElement).value = "localhost:8443";
    (container.querySelector("#username") as HTMLInputElement).value = "testuser";
    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    passwordInput.value = "short";
    passwordInput.focus();

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    const errorBanner = container.querySelector(".error-banner")!;
    await vi.waitFor(() => {
      expect(errorBanner.textContent).toContain("at least 8 characters");
    });
    expect(errorBanner.getAttribute("role")).toBe("alert");
    expect(passwordInput.getAttribute("aria-describedby")).toBe(errorBanner.id);
    expect(document.activeElement).toBe(passwordInput);

    page.destroy?.();
  });

  it("returns focus to the password field after the server rejects a login", async () => {
    const onLogin = vi.fn().mockRejectedValue(new Error("Invalid credentials"));
    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    (container.querySelector("#host") as HTMLInputElement).value = "localhost:8443";
    (container.querySelector("#username") as HTMLInputElement).value = "testuser";
    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    passwordInput.value = "long-enough-password";
    passwordInput.focus();

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(passwordInput.disabled).toBe(true);
    dropFocusToBody();

    const errorBanner = container.querySelector(".error-banner")!;
    await vi.waitFor(() => {
      expect(errorBanner.textContent).toContain("Invalid credentials");
    });
    expect(errorBanner.getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe(passwordInput);

    page.destroy?.();
  });

  describe("sign-in refused by an unconfirmed certificate", () => {
    const certRefusal = (): ApiClientError =>
      new ApiClientError(502, TLS_CERT_CODE, "certificate not confirmed");

    function submitLogin(host: string): void {
      (container.querySelector("#host") as HTMLInputElement).value = host;
      (container.querySelector("#username") as HTMLInputElement).value = "testuser";
      (container.querySelector("#password") as HTMLInputElement).value = "long-enough-password";
      const form = container.querySelector(".connect-form") as HTMLFormElement;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }

    async function refusedThen(
      onLogin: ConnectPageCallbacks["onLogin"],
      host: string,
    ): Promise<ReturnType<typeof createConnectPage>> {
      const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
      page.mount(container);
      submitLogin(host);
      await vi.waitFor(() => {
        expect(container.querySelector(".error-banner")!.textContent).not.toBe("");
      });
      expect(onLogin).toHaveBeenCalledTimes(1);
      return page;
    }

    it("resubmits once when that host's certificate is accepted", async () => {
      const onLogin = vi
        .fn<ConnectPageCallbacks["onLogin"]>()
        .mockRejectedValueOnce(certRefusal())
        .mockResolvedValue(undefined);
      const page = await refusedThen(onLogin, "Chat.Example:8443");

      page.resubmitAfterCertAccept("chat.example:8443");
      await vi.waitFor(() => expect(onLogin).toHaveBeenCalledTimes(2));
      // The typed capitals are not kept: host names are case-insensitive.
      expect(onLogin).toHaveBeenLastCalledWith(
        "chat.example:8443",
        "testuser",
        "long-enough-password",
      );

      page.resubmitAfterCertAccept("chat.example:8443");
      await Promise.resolve();
      expect(onLogin).toHaveBeenCalledTimes(2);
      page.destroy?.();
    });

    it("leaves the form alone for another host's certificate or once the host was changed", async () => {
      const onLogin = vi.fn<ConnectPageCallbacks["onLogin"]>().mockRejectedValue(certRefusal());
      const page = await refusedThen(onLogin, "chat.example:8443");

      page.resubmitAfterCertAccept("other.example:8443");
      await Promise.resolve();
      expect(onLogin).toHaveBeenCalledTimes(1);

      (container.querySelector("#host") as HTMLInputElement).value = "other.example:8443";
      page.resubmitAfterCertAccept("chat.example:8443");
      await Promise.resolve();
      expect(onLogin).toHaveBeenCalledTimes(1);
      page.destroy?.();
    });

    it("does not send an edit the user made after the refusal", async () => {
      const onLogin = vi.fn<ConnectPageCallbacks["onLogin"]>().mockRejectedValue(certRefusal());
      const page = await refusedThen(onLogin, "chat.example:8443");

      const passwordInput = container.querySelector("#password") as HTMLInputElement;
      passwordInput.value = "half-typed";
      passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
      page.resubmitAfterCertAccept("chat.example:8443");
      await Promise.resolve();
      expect(onLogin).toHaveBeenCalledTimes(1);
      page.destroy?.();
    });

    it("does not turn a registration switched to Login mid-request into a login", async () => {
      let refuse!: (err: unknown) => void;
      const onRegister = vi.fn<ConnectPageCallbacks["onRegister"]>(
        () =>
          new Promise<void>((_resolve, reject) => {
            refuse = reject;
          }),
      );
      const onLogin = vi.fn<ConnectPageCallbacks["onLogin"]>().mockResolvedValue(undefined);
      const page = createConnectPage(
        makeCallbacks({ onLogin, onRegister, getRegistrationMode: () => "open" }),
        testProfiles,
      );
      page.mount(container);
      const toggle = container.querySelector(".form-switch button") as HTMLElement;
      toggle.click();
      submitLogin("chat.example:8443");
      await vi.waitFor(() => expect(onRegister).toHaveBeenCalledTimes(1));

      toggle.click();
      refuse(certRefusal());
      await vi.waitFor(() => {
        expect(container.querySelector(".error-banner")!.textContent).not.toBe("");
      });

      page.resubmitAfterCertAccept("chat.example:8443");
      await Promise.resolve();
      expect(onLogin).not.toHaveBeenCalled();
      expect(onRegister).toHaveBeenCalledTimes(1);
      page.destroy?.();
    });

    it("does not resubmit a sign-in the server refused for another reason", async () => {
      const onLogin = vi
        .fn<ConnectPageCallbacks["onLogin"]>()
        .mockRejectedValue(new ApiClientError(401, "UNAUTHORIZED", "invalid credentials"));
      const page = await refusedThen(onLogin, "chat.example:8443");

      page.resubmitAfterCertAccept("chat.example:8443");
      await Promise.resolve();
      expect(onLogin).toHaveBeenCalledTimes(1);
      page.destroy?.();
    });
  });

  // ── Saved-password login (OCV-001) ───────────────────────────────────────
  //
  // The plaintext password no longer crosses IPC, so a remembered password is
  // shown as a placeholder and submitted through the Rust backend instead.
  // Submission branches on internal state, never on the field's text — the
  // ordinary saved-password path never sends the placeholder as literal text.
  // A pasted-back copy of the placeholder is a separate case (below):
  // register mode refuses it outright, login mode just treats it as an
  // ordinary (almost certainly wrong) typed password.

  it("submits a remembered password through the backend, not as form text", async () => {
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const onLoginWithSavedPassword = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(
      makeCallbacks({ onLogin, onLoginWithSavedPassword }),
      testProfiles,
    );
    page.mount(container);

    (container.querySelector(".server-item") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(onLoginWithSavedPassword).toHaveBeenCalledWith("localhost:8443", "saveduser");
    });
    expect(onLogin).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("falls back to a normal login once the user edits the remembered password", async () => {
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const onLoginWithSavedPassword = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(
      makeCallbacks({ onLogin, onLoginWithSavedPassword }),
      testProfiles,
    );
    page.mount(container);

    (container.querySelector(".server-item") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });

    // An edit drops the placeholder outright — the field must never mix
    // placeholder text with typed characters.
    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    passwordInput.dispatchEvent(new Event("beforeinput", { bubbles: true, cancelable: true }));
    expect(passwordInput.value).toBe("");
    expect(page.isUsingSavedPassword()).toBe(false);

    passwordInput.value = "typed-password";
    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith("localhost:8443", "saveduser", "typed-password");
    });
    expect(onLoginWithSavedPassword).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("does not drop the placeholder on caret movement alone", async () => {
    // ArrowLeft moves the caret without editing the field, so the placeholder
    // must survive it — unlike an actual edit.
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    (container.querySelector(".server-item") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });

    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    const value = passwordInput.value;
    passwordInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));

    expect(passwordInput.value).toBe(value);
    expect(page.isUsingSavedPassword()).toBe(true);

    page.destroy?.();
  });

  it("falls back to a normal login once a beforeinput edit clears the placeholder", async () => {
    // Covers edits that never fire keydown/paste — drag-and-drop and
    // autofill both mutate the value via beforeinput.
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const onLoginWithSavedPassword = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(
      makeCallbacks({ onLogin, onLoginWithSavedPassword }),
      testProfiles,
    );
    page.mount(container);

    (container.querySelector(".server-item") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });

    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    passwordInput.dispatchEvent(new Event("beforeinput", { bubbles: true, cancelable: true }));
    expect(page.isUsingSavedPassword()).toBe(false);

    passwordInput.value = "dropped-in-password";
    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith("localhost:8443", "saveduser", "dropped-in-password");
    });
    expect(onLoginWithSavedPassword).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("falls back to a normal login when a password manager replaces the value without beforeinput", async () => {
    // A password manager (and some webview autofill implementations) sets
    // the value and fires only `input`, never `beforeinput`. The `input`
    // listener is the backstop that must still clear the placeholder.
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const onLoginWithSavedPassword = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(
      makeCallbacks({ onLogin, onLoginWithSavedPassword }),
      testProfiles,
    );
    page.mount(container);

    (container.querySelector(".server-item") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });

    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    passwordInput.value = "manager-filled-password";
    passwordInput.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    expect(page.isUsingSavedPassword()).toBe(false);

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith(
        "localhost:8443",
        "saveduser",
        "manager-filled-password",
      );
    });
    expect(onLoginWithSavedPassword).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("logs in with the pasted placeholder text after editing a saved-password field (login)", async () => {
    // Reveal the field, copy the bullets, paste them back: `beforeinput`
    // clears `usingSavedPassword` and blanks the field before the paste
    // lands, so the field ends up holding the placeholder string as literal
    // text with `usingSavedPassword === false`. Login mode does not check the
    // placeholder string at all — the account's real password could in
    // principle be exactly those bullets, and rejecting it here would lock
    // the owner out. Submitting it simply reaches onLogin like any other
    // typed password; if it's not the real password, auth fails normally.
    const SAVED_PASSWORD_PLACEHOLDER = "•".repeat(12);
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const onLoginWithSavedPassword = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(
      makeCallbacks({ onLogin, onLoginWithSavedPassword }),
      testProfiles,
    );
    page.mount(container);

    (container.querySelector(".server-item") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });

    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    passwordInput.dispatchEvent(new Event("beforeinput", { bubbles: true, cancelable: true }));
    passwordInput.value = SAVED_PASSWORD_PLACEHOLDER;
    passwordInput.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    expect(page.isUsingSavedPassword()).toBe(false);

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith(
        "localhost:8443",
        "saveduser",
        SAVED_PASSWORD_PLACEHOLDER,
      );
    });
    expect(onLoginWithSavedPassword).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("rejects the placeholder pasted back in as literal text (register)", async () => {
    // Same round trip as the login case, but in Register mode the check is
    // unconditional: this is the path that would otherwise create an account
    // whose password is a fixed, publicly known constant.
    const SAVED_PASSWORD_PLACEHOLDER = "•".repeat(12);
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onRegister }), testProfiles);
    page.mount(container);

    (container.querySelector(".server-item") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });

    const toggle = container.querySelector(".form-switch button") as HTMLElement;
    toggle.click();
    expect(page.isUsingSavedPassword()).toBe(false);

    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    passwordInput.value = SAVED_PASSWORD_PLACEHOLDER;
    passwordInput.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));

    const inviteInput = container.querySelector("#invite") as HTMLInputElement;
    inviteInput.value = "invite-code";
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    usernameInput.value = "newuser";
    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(container.querySelector(".error-banner")!.classList.contains("visible")).toBe(true);
    });
    expect(onRegister).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("still submits a normal saved-password login (guards the placeholder check)", async () => {
    // The new placeholder check must not fire on the ordinary saved-password
    // path, where the field legitimately holds the placeholder text while
    // `usingSavedPassword` is true.
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const onLoginWithSavedPassword = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(
      makeCallbacks({ onLogin, onLoginWithSavedPassword }),
      testProfiles,
    );
    page.mount(container);

    (container.querySelector(".server-item") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(onLoginWithSavedPassword).toHaveBeenCalledWith("localhost:8443", "saveduser");
    });
    expect(onLogin).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("submits the bullet string as a real password when no placeholder was ever shown (login)", async () => {
    // Login mode never checks the placeholder string, so a user whose real
    // password happens to be exactly those twelve bullets can log in with it,
    // whether or not a saved password was ever shown on this form.
    const SAVED_PASSWORD_PLACEHOLDER = "•".repeat(12);
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "testuser";
    passwordInput.value = SAVED_PASSWORD_PLACEHOLDER;

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith(
        "localhost:8443",
        "testuser",
        SAVED_PASSWORD_PLACEHOLDER,
      );
    });

    page.destroy?.();
  });

  it("rejects the placeholder string in register mode with no prior saved-password selection at all", async () => {
    // Stateless: the check does not depend on any credential ever having
    // been loaded or shown on this form. This is the case the old latch
    // missed, because nothing had ever armed it.
    const SAVED_PASSWORD_PLACEHOLDER = "•".repeat(12);
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onRegister }), testProfiles);
    page.mount(container);

    const toggle = container.querySelector(".form-switch button") as HTMLElement;
    toggle.click();

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    const usernameInput = container.querySelector("#username") as HTMLInputElement;
    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    const inviteInput = container.querySelector("#invite") as HTMLInputElement;

    hostInput.value = "localhost:8443";
    usernameInput.value = "newuser";
    passwordInput.value = SAVED_PASSWORD_PLACEHOLDER;
    inviteInput.value = "invite-code";

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(container.querySelector(".error-banner")!.classList.contains("visible")).toBe(true);
    });
    expect(onRegister).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("logs in with the bullet string after switching to a server with no saved password", async () => {
    // No lockout in any ordering: selecting server A (saved password) then
    // server B (no saved password) and typing the twelve-bullet string as
    // B's real password must reach onLogin like any other login-mode
    // password — login mode never checks it.
    const SAVED_PASSWORD_PLACEHOLDER = "•".repeat(12);
    mockLoadCredential
      .mockResolvedValueOnce({ username: "saveduser", token: "tok", hasPassword: true })
      .mockResolvedValueOnce({ username: "otheruser", token: "tok", hasPassword: false });

    const onLogin = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    page.selectServer("server-a:8443", "saveduser");
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });

    page.selectServer("server-b:8443", "otheruser");
    await vi.waitFor(() => {
      const usernameInput = container.querySelector("#username") as HTMLInputElement;
      expect(usernameInput.value).toBe("otheruser");
    });
    expect(page.isUsingSavedPassword()).toBe(false);

    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    passwordInput.value = SAVED_PASSWORD_PLACEHOLDER;
    passwordInput.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith(
        "server-b:8443",
        "otheruser",
        SAVED_PASSWORD_PLACEHOLDER,
      );
    });

    page.destroy?.();
  });

  it("drops the saved password when switching to a server with no saved username", async () => {
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const onLoginWithSavedPassword = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(
      makeCallbacks({ onLogin, onLoginWithSavedPassword }),
      testProfiles,
    );
    page.mount(container);

    page.selectServer("server-a:8443", "saveduser");
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });

    // An Add Server profile has no username, so no credential load resets the form.
    page.selectServer("server-b:8443");
    expect(page.isUsingSavedPassword()).toBe(false);
    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    expect(passwordInput.value).toBe("");

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(onLoginWithSavedPassword).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("drops the saved password when the user types a different host", async () => {
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const onLoginWithSavedPassword = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onLoginWithSavedPassword }), testProfiles);
    page.mount(container);

    page.selectServer("server-a:8443", "saveduser");
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });

    const hostInput = container.querySelector("#host") as HTMLInputElement;
    hostInput.value = "server-c:8443";
    hostInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(page.isUsingSavedPassword()).toBe(false);
    expect((container.querySelector("#password") as HTMLInputElement).value).toBe("");

    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(onLoginWithSavedPassword).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("keeps the saved password when the same server is selected again", async () => {
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    page.selectServer("server-a:8443", "saveduser");
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });
    page.selectServer("server-a:8443");
    expect(page.isUsingSavedPassword()).toBe(true);

    page.destroy?.();
  });

  it("rejects the pasted placeholder in Register after reselecting the same host", async () => {
    // The exact sequence that slipped through the old latch: select the
    // saved-password host (arms it), switch to Register, then re-click the
    // SAME server row — which used to reset the latch via setCredentials'
    // else branch, since it runs for Register too. The stateless check does
    // not care about any of that history.
    const SAVED_PASSWORD_PLACEHOLDER = "•".repeat(12);
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onRegister }), testProfiles);
    page.mount(container);

    const serverItem = container.querySelector(".server-item") as HTMLElement;
    serverItem.click();
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });

    const toggle = container.querySelector(".form-switch button") as HTMLElement;
    toggle.click();
    expect(page.isUsingSavedPassword()).toBe(false);

    // Reselect the same host while already in Register mode.
    serverItem.click();
    await vi.waitFor(() => {
      expect((container.querySelector("#username") as HTMLInputElement).value).toBe("saveduser");
    });
    expect(page.isUsingSavedPassword()).toBe(false);

    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    passwordInput.dispatchEvent(new Event("beforeinput", { bubbles: true, cancelable: true }));
    passwordInput.value = SAVED_PASSWORD_PLACEHOLDER;
    passwordInput.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));

    const inviteInput = container.querySelector("#invite") as HTMLInputElement;
    inviteInput.value = "invite-code";
    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(container.querySelector(".error-banner")!.classList.contains("visible")).toBe(true);
    });
    expect(onRegister).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("never carries a remembered password into registration", async () => {
    // Regression: the placeholder is a fixed, publicly known constant. If it
    // survived a switch to Register it would be submitted as the NEW account's
    // password, because only the login branch consults `usingSavedPassword`.
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onRegister }), testProfiles);
    page.mount(container);

    (container.querySelector(".server-item") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });

    // Switch to Register without touching the password field.
    const toggle = container.querySelector(".form-switch button") as HTMLElement;
    toggle.click();

    expect(page.isUsingSavedPassword()).toBe(false);
    const passwordInput = container.querySelector("#password") as HTMLInputElement;
    expect(passwordInput.value).toBe("");

    // Submitting now must be rejected for a missing password, not sent.
    const inviteInput = container.querySelector("#invite") as HTMLInputElement;
    inviteInput.value = "invite-code";
    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(container.querySelector(".error-banner")!.classList.contains("visible")).toBe(true);
    });
    expect(onRegister).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("never arms the placeholder when a server is picked while registering", async () => {
    // The ordering the toggle-time clear does NOT cover: the form is already
    // in Register mode when the credential load lands. Clicking a server row
    // does not force the form back to login, so setCredentials must refuse to
    // arm the placeholder itself.
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onRegister }), testProfiles);
    page.mount(container);

    // Switch to Register FIRST, then pick the saved server.
    (container.querySelector(".form-switch button") as HTMLElement).click();
    (container.querySelector(".server-item") as HTMLElement).click();

    await vi.waitFor(() => {
      expect((container.querySelector("#username") as HTMLInputElement).value).toBe("saveduser");
    });

    expect(page.isUsingSavedPassword()).toBe(false);
    expect((container.querySelector("#password") as HTMLInputElement).value).toBe("");

    (container.querySelector("#invite") as HTMLInputElement).value = "invite-code";
    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(container.querySelector(".error-banner")!.classList.contains("visible")).toBe(true);
    });
    expect(onRegister).not.toHaveBeenCalled();

    page.destroy?.();
  });

  it("never arms the placeholder when the load resolves after switching to register", async () => {
    // The race the toggle-time clear also misses: the credential load is
    // in flight when the user switches, and re-arms the placeholder when it
    // lands. Resolve it manually so the ordering is deterministic.
    let resolveCredential: (v: unknown) => void = () => {};
    mockLoadCredential.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCredential = resolve;
        }),
    );
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onRegister }), testProfiles);
    page.mount(container);

    // Click the server (load starts), switch to Register, THEN let it land.
    (container.querySelector(".server-item") as HTMLElement).click();
    (container.querySelector(".form-switch button") as HTMLElement).click();
    resolveCredential({ username: "saveduser", token: "tok", hasPassword: true });

    await vi.waitFor(() => {
      expect((container.querySelector("#username") as HTMLInputElement).value).toBe("saveduser");
    });

    expect(page.isUsingSavedPassword()).toBe(false);
    expect((container.querySelector("#password") as HTMLInputElement).value).toBe("");

    page.destroy?.();
  });

  it("does not report a saved password as form text", async () => {
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    (container.querySelector(".server-item") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(page.isUsingSavedPassword()).toBe(true);
    });

    // "" means "nothing new to save", which makes save_credential preserve
    // the stored password instead of clearing it.
    expect(page.getPassword()).toBe("");

    page.destroy?.();
  });

  it("calls onLogin with form values on valid submit", async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
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
      expect(onLogin).toHaveBeenCalledWith("localhost:8443", "testuser", "password123");
    });

    page.destroy?.();
  });

  it("toggles between login and register mode", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    // Initially in login mode — invite group hidden
    const inviteGroup = container.querySelector("#invite")!.closest(".form-group") as HTMLElement;
    expect(inviteGroup.classList.contains("form-group--hidden")).toBe(true);

    // Click toggle link
    const toggleLink = container.querySelector(".form-switch button") as HTMLElement;
    toggleLink.click();

    // Now in register mode — invite group visible
    expect(inviteGroup.classList.contains("form-group--hidden")).toBe(false);

    // Submit button text changes
    const btnText = container.querySelector(".btn-text");
    expect(btnText?.textContent).toBe("Register");

    page.destroy?.();
  });

  it("shows TOTP overlay when showTotp is called", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    const totpOverlay = container.querySelector(".totp-overlay")!;
    expect(totpOverlay.classList.contains("totp-overlay--hidden")).toBe(true);

    page.showTotp();
    expect(totpOverlay.classList.contains("totp-overlay--hidden")).toBe(false);

    page.destroy?.();
  });

  it("shows error message via showError", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    page.showError("Connection refused");

    const errorBanner = container.querySelector(".error-banner");
    expect(errorBanner!.classList.contains("visible")).toBe(true);
    expect(errorBanner!.textContent).toBe("Connection refused");
    expect(errorBanner!.getAttribute("role")).toBe("alert");
    for (const input of container.querySelectorAll(".connect-form input")) {
      expect(input.getAttribute("aria-describedby")).not.toBe(errorBanner!.id);
    }

    page.destroy?.();
  });

  it("resets to idle state via resetToIdle", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    page.showError("Some error");
    page.resetToIdle();

    const errorBanner = container.querySelector(".error-banner");
    expect(errorBanner!.classList.contains("visible")).toBe(false);

    const submitBtn = container.querySelector(".btn-primary") as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    page.destroy?.();
  });
});

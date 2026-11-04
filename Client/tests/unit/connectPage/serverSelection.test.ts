import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/connectPageMocks";
import { createConnectPage } from "../../../src/pages/ConnectPage";
import type { SimpleProfile } from "../../../src/pages/ConnectPage";
import { uiStore, setTransientError } from "../../../src/stores/ui.store";
import {
  makeCallbacks,
  useConnectPageContainer,
  savedCredential,
  mountPage,
  qs,
  submitForm,
  waitForCall,
  pendingLogin,
  mountTotp,
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

  it("disables form inputs during loading state", async () => {
    const { onLogin, resolveLogin } = pendingLogin();

    const page = mountPage(container, { onLogin });

    const hostInput = qs<HTMLInputElement>(container, "#host");
    const usernameInput = qs<HTMLInputElement>(container, "#username");
    const passwordInput = qs<HTMLInputElement>(container, "#password");

    hostInput.value = "localhost:8443";
    usernameInput.value = "testuser";
    passwordInput.value = "password123";

    submitForm(container);

    await vi.waitFor(() => {
      expect(hostInput.disabled).toBe(true);
      expect(usernameInput.disabled).toBe(true);
      expect(passwordInput.disabled).toBe(true);
    });

    resolveLogin();

    page.destroy?.();
  });

  it("cleans up on destroy", () => {
    const page = mountPage(container);

    expect(container.querySelector(".connect-page")).not.toBeNull();

    page.destroy?.();
    expect(container.querySelector(".connect-page")).toBeNull();
  });

  // --- selectServer / auto-login flow ---

  it("selectServer sets host and loads credentials asynchronously", async () => {
    mockLoadCredential.mockResolvedValue(savedCredential());
    const page = mountPage(container);

    page.selectServer("localhost:8443", "initialuser");

    const hostInput = qs<HTMLInputElement>(container, "#host");
    expect(hostInput.value).toBe("localhost:8443");

    // Wait for async credential loading
    await vi.waitFor(() => {
      const usernameInput = qs<HTMLInputElement>(container, "#username");
      expect(usernameInput.value).toBe("saveduser");
    });

    // The field reads as filled so the "Remember password" tick keeps its
    // promise, but it holds a placeholder — the plaintext never leaves Rust.
    const passwordInput = qs<HTMLInputElement>(container, "#password");
    expect(passwordInput.value).not.toBe("");
    expect(passwordInput.value).not.toBe("savedpass");
    expect(page.isUsingSavedPassword()).toBe(true);

    page.destroy?.();
  });

  it("selectServer does not load the stored credential for a profile that opted out of remembering", async () => {
    mockLoadCredential.mockClear();
    mockLoadCredential.mockResolvedValue(savedCredential());
    const page = mountPage(container);

    page.selectServer("localhost:8443", "initialuser", false, false);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockLoadCredential).not.toHaveBeenCalled();
    expect(page.isUsingSavedPassword()).toBe(false);

    page.destroy?.();
  });

  it("selectServer sets credentials without password when username is provided", () => {
    const page = mountPage(container);

    page.selectServer("localhost:8443", "myuser");

    const usernameInput = qs<HTMLInputElement>(container, "#username");
    expect(usernameInput.value).toBe("myuser");

    page.destroy?.();
  });

  it("selectServer without username does not set credentials", () => {
    const page = mountPage(container);

    page.selectServer("localhost:8443");

    const usernameInput = qs<HTMLInputElement>(container, "#username");
    expect(usernameInput.value).toBe("");

    page.destroy?.();
  });

  it("selectServer ignores credential load when host has changed", async () => {
    mockLoadCredential.mockImplementation(async () => {
      // Simulate delay
      await new Promise((r) => setTimeout(r, 10));
      return { username: "staleuser", token: "tok", password: "stalepass" };
    });

    const page = mountPage(container);

    page.selectServer("localhost:8443");
    // Immediately change the host to something else
    const hostInput = qs<HTMLInputElement>(container, "#host");
    hostInput.value = "other-server:8443";

    // Wait for async to finish
    await new Promise((r) => setTimeout(r, 50));

    // Username should NOT be set because host changed
    const usernameInput = qs<HTMLInputElement>(container, "#username");
    expect(usernameInput.value).toBe("");

    page.destroy?.();
  });

  it("selectServer handles credential load failure gracefully", async () => {
    mockLoadCredential.mockRejectedValue(new Error("Tauri not available"));
    const page = mountPage(container);

    // Should not throw
    page.selectServer("localhost:8443");
    await new Promise((r) => setTimeout(r, 20));

    const hostInput = qs<HTMLInputElement>(container, "#host");
    expect(hostInput.value).toBe("localhost:8443");

    page.destroy?.();
  });

  // --- showConnecting / showAutoConnecting ---

  it("showConnecting disables form and shows connecting text", () => {
    const page = mountPage(container);

    page.showConnecting();

    const submitBtn = qs<HTMLButtonElement>(container, ".btn-primary");
    expect(submitBtn.disabled).toBe(true);
    const btnText = container.querySelector(".btn-text")!;
    expect(btnText.textContent).toContain("Connecting");

    const statusBar = container.querySelector(".status-bar")!;
    expect(statusBar.classList.contains("visible")).toBe(true);

    page.destroy?.();
  });

  it("showAutoConnecting shows overlay with server name and calls cancel callback", () => {
    const onAutoLoginCancel = vi.fn();
    const page = mountPage(container, { onAutoLoginCancel });

    page.showAutoConnecting("My Server");

    const overlay = container.querySelector(".auto-connect-overlay")!;
    expect(overlay.classList.contains("auto-connect-overlay--hidden")).toBe(false);

    const serverName = container.querySelector(".auto-connect-server")!;
    expect(serverName.textContent).toBe("My Server");

    // Click cancel
    const cancelBtn = qs<HTMLElement>(container, ".auto-connect-cancel");
    cancelBtn.click();

    expect(onAutoLoginCancel).toHaveBeenCalledTimes(1);
    expect(overlay.classList.contains("auto-connect-overlay--hidden")).toBe(true);

    page.destroy?.();
  });

  // --- showServerWait (P2-T7) ---

  it("showServerWait shows the waiting line with a keyboard-reachable Cancel", () => {
    const onAutoLoginCancel = vi.fn();
    const page = mountPage(container, { onAutoLoginCancel });

    page.showServerWait("Home Server", "localhost:8443");

    const wait = container.querySelector<HTMLElement>(".server-wait")!;
    expect(wait.hidden).toBe(false);
    expect(wait.getAttribute("role")).toBe("status");
    expect(wait.textContent).toContain("Waiting for Home Server…");
    // The form stays usable beneath it: the wait is not a blocking overlay.
    expect(qs<HTMLInputElement>(container, "#host").disabled).toBe(false);

    const cancel = wait.querySelector<HTMLButtonElement>("button")!;
    expect(cancel.textContent).toBe("Cancel");
    expect(cancel.type).toBe("button");
    expect(cancel.disabled).toBe(false);
    expect(cancel.tabIndex).toBe(0);
    cancel.focus();
    expect(document.activeElement).toBe(cancel);

    cancel.click();
    expect(onAutoLoginCancel).toHaveBeenCalledTimes(1);
    expect(wait.hidden).toBe(true);

    page.destroy?.();
  });

  it("typing into the form cancels the server wait", () => {
    const onAutoLoginCancel = vi.fn();
    const page = mountPage(container, { onAutoLoginCancel });
    page.showServerWait("Home Server", "localhost:8443");

    const username = qs<HTMLInputElement>(container, "#username");
    username.value = "a";
    username.dispatchEvent(new Event("input", { bubbles: true }));
    username.value = "al";
    username.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onAutoLoginCancel).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLElement>(".server-wait")!.hidden).toBe(true);

    page.destroy?.();
  });

  it("picking another server cancels the server wait; the same server keeps it", () => {
    const onAutoLoginCancel = vi.fn();
    const profiles: SimpleProfile[] = [
      { name: "Server A", host: "a.example:8443" },
      { name: "Server B", host: "b.example:8443" },
    ];
    const page = createConnectPage(makeCallbacks({ onAutoLoginCancel }), profiles);
    page.mount(container);
    page.showServerWait("Server A", "a.example:8443");
    const [serverA, serverB] = container.querySelectorAll<HTMLElement>(".server-item");
    const wait = container.querySelector<HTMLElement>(".server-wait")!;

    serverA!.click();
    expect(onAutoLoginCancel).not.toHaveBeenCalled();
    expect(wait.hidden).toBe(false);

    serverB!.click();
    expect(onAutoLoginCancel).toHaveBeenCalledTimes(1);
    expect(wait.hidden).toBe(true);

    page.destroy?.();
  });

  it("toggling a checkbox leaves the server wait running", () => {
    const onAutoLoginCancel = vi.fn();
    const page = mountPage(container, { onAutoLoginCancel });
    page.showServerWait("Home Server", "localhost:8443");

    for (const id of ["#auto-connect", "#remember-password"]) {
      container.querySelector<HTMLInputElement>(id)!.click();
    }

    expect(onAutoLoginCancel).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLElement>(".server-wait")!.hidden).toBe(false);

    page.destroy?.();
  });

  it("hideServerWait hides the waiting line without cancelling", () => {
    const onAutoLoginCancel = vi.fn();
    const page = mountPage(container, { onAutoLoginCancel });
    page.showServerWait("Home Server", "localhost:8443");

    page.hideServerWait();

    expect(container.querySelector<HTMLElement>(".server-wait")!.hidden).toBe(true);
    expect(onAutoLoginCancel).not.toHaveBeenCalled();

    page.destroy?.();
  });

  // --- refreshProfiles ---

  it("refreshProfiles re-renders the server profile list", () => {
    const page = mountPage(container);

    expect(container.querySelectorAll(".server-item").length).toBe(1);

    page.refreshProfiles([
      { name: "Server A", host: "a.com:8443" },
      { name: "Server B", host: "b.com:8443" },
    ]);

    expect(container.querySelectorAll(".server-item").length).toBe(2);

    page.destroy?.();
  });

  // --- updateHealthStatus ---

  it("updateHealthStatus updates health elements for a known host", () => {
    const page = mountPage(container);

    page.updateHealthStatus("localhost:8443", {
      status: "online",
      latencyMs: 42,
      version: null,
      onlineUsers: 5,
    });

    const dot = container.querySelector(".srv-status-dot")!;
    expect(dot.className).toContain("online");
    const latency = container.querySelector(".srv-latency")!;
    expect(latency.textContent).toBe("42ms response time");
    const onlineUsers = container.querySelector(".srv-online-users")!;
    expect(onlineUsers.textContent).toBe("5 online");

    page.destroy?.();
  });

  // --- getRememberPassword / getPassword ---

  it("getRememberPassword returns checkbox state", () => {
    const page = mountPage(container);

    // Default: Remember password starts unticked.
    expect(page.getRememberPassword()).toBe(false);

    const checkbox = qs<HTMLInputElement>(container, "#remember-password");
    checkbox.checked = true;
    expect(page.getRememberPassword()).toBe(true);

    page.destroy?.();
  });

  // --- getAutoConnect ---

  it("getAutoConnect returns checkbox state", () => {
    const page = mountPage(container);

    // Default: Auto connect (stay signed in) starts ticked.
    expect(page.getAutoConnect()).toBe(true);

    const checkbox = qs<HTMLInputElement>(container, "#auto-connect");
    checkbox.checked = false;
    expect(page.getAutoConnect()).toBe(false);
    checkbox.checked = true;
    expect(page.getAutoConnect()).toBe(true);

    page.destroy?.();
  });

  it("ticking auto-connect no longer forces or disables remember password", () => {
    const page = mountPage(container);

    const autoConnectCheckbox = qs<HTMLInputElement>(container, "#auto-connect");
    const rememberCheckbox = qs<HTMLInputElement>(container, "#remember-password");

    autoConnectCheckbox.checked = false;
    autoConnectCheckbox.dispatchEvent(new Event("change"));
    autoConnectCheckbox.checked = true;
    autoConnectCheckbox.dispatchEvent(new Event("change"));

    expect(rememberCheckbox.checked).toBe(false);
    expect(rememberCheckbox.disabled).toBe(false);
    expect(page.getRememberPassword()).toBe(false);

    page.destroy?.();
  });

  it("unticking auto-connect leaves remember password as the user set it", () => {
    const page = mountPage(container);

    const autoConnectCheckbox = qs<HTMLInputElement>(container, "#auto-connect");
    const rememberCheckbox = qs<HTMLInputElement>(container, "#remember-password");

    rememberCheckbox.checked = true;
    autoConnectCheckbox.checked = false;
    autoConnectCheckbox.dispatchEvent(new Event("change"));

    expect(rememberCheckbox.disabled).toBe(false);
    expect(rememberCheckbox.checked).toBe(true);

    page.destroy?.();
  });

  describe("saved profile sets both boxes", () => {
    const savedProfile = (autoConnect: boolean, rememberPassword: boolean) => [
      {
        id: "p1",
        name: "Saved",
        host: "saved.example:8443",
        username: "alice",
        autoConnect,
        rememberPassword,
      },
    ];
    const boxes = () => ({
      auto: qs<HTMLInputElement>(container, "#auto-connect").checked,
      remember: qs<HTMLInputElement>(container, "#remember-password").checked,
    });

    it.each([
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ])("server click: autoConnect=%s rememberPassword=%s", (auto, remember) => {
      const page = createConnectPage(makeCallbacks(), savedProfile(auto, remember));
      page.mount(container);
      // Start from the opposite state so a no-op would be caught.
      page.selectServer("other:1", undefined, !auto, !remember);
      qs<HTMLElement>(container, ".server-item").click();
      expect(boxes()).toEqual({ auto, remember });
      page.destroy?.();
    });

    it.each([
      [false, false],
      [true, false],
      [true, true],
    ])("selectServer: autoConnect=%s rememberPassword=%s", (auto, remember) => {
      const page = createConnectPage(makeCallbacks(), savedProfile(auto, remember));
      page.mount(container);
      page.selectServer("saved.example:8443", "alice", auto, remember);
      expect(boxes()).toEqual({ auto, remember });
      page.destroy?.();
    });

    it("a typed host matching a saved profile applies that profile's flags", () => {
      const page = createConnectPage(makeCallbacks(), savedProfile(false, false));
      page.mount(container);
      expect(boxes()).toEqual({ auto: true, remember: false });
      const host = qs<HTMLInputElement>(container, "#host");
      host.value = "saved.example:8443";
      host.dispatchEvent(new Event("input"));
      expect(boxes()).toEqual({ auto: false, remember: false });
      // The user's later edit is not overridden by further typing in the host.
      qs<HTMLInputElement>(container, "#auto-connect").checked = true;
      host.dispatchEvent(new Event("input"));
      expect(boxes()).toEqual({ auto: true, remember: false });
      page.destroy?.();
    });

    it("a host typed before profiles load takes the saved flags when they arrive", () => {
      const page = createConnectPage(makeCallbacks(), []);
      page.mount(container);
      const host = qs<HTMLInputElement>(container, "#host");
      host.value = "saved.example:8443";
      host.dispatchEvent(new Event("input"));
      expect(boxes()).toEqual({ auto: true, remember: false });
      page.refreshProfiles(savedProfile(false, false));
      expect(boxes()).toEqual({ auto: false, remember: false });
      page.destroy?.();
    });

    it("a host with no profile gets the defaults", () => {
      const page = mountPage(container);
      page.selectServer("other:1", undefined, false, true);
      page.selectServer("brand-new:1");
      expect(boxes()).toEqual({ auto: true, remember: false });
      page.destroy?.();
    });
  });

  it("getPassword returns password input value", () => {
    const page = mountPage(container);

    const passwordInput = qs<HTMLInputElement>(container, "#password");
    passwordInput.value = "mypassword";
    expect(page.getPassword()).toBe("mypassword");

    page.destroy?.();
  });

  // --- Incompatible epoch state (B7-12) ---

  describe("incompatible state", () => {
    it("shows the notice for a selected client-older server, naming the client", () => {
      const page = mountPage(container);

      page.updateCompatibility("localhost:8443", "client-older", 2);
      qs<HTMLElement>(container, ".server-item").click();

      const notice = container.querySelector(".incompatible-notice")!;
      expect(notice.classList.contains("visible")).toBe(true);
      expect(notice.textContent).toContain("update the client");
      expect(container.querySelector(".incompatible-notice-update")).not.toBeNull();

      page.destroy?.();
    });

    it("mounts the notice inside the form panel, directly above the form", () => {
      const page = mountPage(container);

      // A direct child of the flex-row .connect-page would claim its own column.
      const notice = container.querySelector(".incompatible-notice")!;
      expect(notice.parentElement!.classList.contains("form-container")).toBe(true);
      expect(notice.nextElementSibling!.classList.contains("connect-form")).toBe(true);

      page.destroy?.();
    });

    it("keeps the notice hidden for a compatible server", () => {
      const page = mountPage(container);

      page.updateCompatibility("localhost:8443", "compatible", 1);
      qs<HTMLElement>(container, ".server-item").click();

      expect(container.querySelector(".incompatible-notice")!.classList.contains("visible")).toBe(
        false,
      );

      page.destroy?.();
    });

    it("badges a background-probe server without showing the notice", () => {
      const page = mountPage(container);

      // The 15 s background probe only reaches updateCompatibility — it must
      // never raise the notice for a profile the user has not selected.
      page.updateCompatibility("localhost:8443", "client-older", 2);

      expect(container.querySelector(".srv-compat-badge")!.textContent).toBe(
        "Client update needed",
      );
      expect(container.querySelector(".incompatible-notice")!.classList.contains("visible")).toBe(
        false,
      );

      page.destroy?.();
    });

    it("gives server-older its own wording and no client-update exit", () => {
      const page = mountPage(container);

      page.updateCompatibility("localhost:8443", "server-older", 0);
      qs<HTMLElement>(container, ".server-item").click();

      const notice = container.querySelector(".incompatible-notice")!;
      expect(notice.classList.contains("visible")).toBe(true);
      expect(notice.textContent).toContain("update the server");
      expect(container.querySelector(".incompatible-notice-update")).toBeNull();
      expect(container.querySelector(".incompatible-notice-leave")).not.toBeNull();

      page.destroy?.();
    });

    it("the update exit asks the host to mount the updater", () => {
      const onUpdateClient = vi.fn();
      const page = mountPage(container, { onUpdateClient });

      page.showIncompatible("localhost:8443", 2, 1);
      qs<HTMLElement>(container, ".incompatible-notice-update").click();

      expect(onUpdateClient).toHaveBeenCalledWith("localhost:8443");

      page.destroy?.();
    });

    it("Choose another server clears the protocol-refusal error", async () => {
      const page = mountPage(container);

      setTransientError("Server protocol is newer than this client");
      await vi.waitFor(() =>
        expect(container.querySelector(".error-banner")!.classList.contains("visible")).toBe(true),
      );
      page.showIncompatible("localhost:8443", 2, 1);
      expect(container.querySelector(".error-banner")!.classList.contains("visible")).toBe(true);

      qs<HTMLElement>(container, ".incompatible-notice-leave").click();
      expect(container.querySelector(".error-banner")!.classList.contains("visible")).toBe(false);

      page.destroy?.();
    });

    it("Choose another server keeps an unrelated error", async () => {
      const page = mountPage(container);

      setTransientError("Server protocol is newer than this client");
      await vi.waitFor(() =>
        expect(container.querySelector(".error-banner")!.classList.contains("visible")).toBe(true),
      );
      page.showIncompatible("localhost:8443", 2, 1);
      // A later, unrelated failure replaces the refusal banner.
      page.showError("Invalid username or password");

      qs<HTMLElement>(container, ".incompatible-notice-leave").click();
      const banner = container.querySelector(".error-banner")!;
      expect(banner.classList.contains("visible")).toBe(true);
      expect(banner.textContent).toContain("Invalid username or password");

      page.destroy?.();
    });

    it("the leave exit dismisses the notice and leaves the server rows usable", () => {
      const page = mountPage(container);

      page.showIncompatible("localhost:8443", 2, 1);
      expect(container.querySelector(".incompatible-notice")!.classList.contains("visible")).toBe(
        true,
      );

      qs<HTMLElement>(container, ".incompatible-notice-leave").click();
      expect(container.querySelector(".incompatible-notice")!.classList.contains("visible")).toBe(
        false,
      );

      // The list is untouched: clicking the row still fills the form.
      qs<HTMLElement>(container, ".server-item").click();
      const hostInput = qs<HTMLInputElement>(container, "#host");
      expect(hostInput.value).toBe("localhost:8443");

      page.destroy?.();
    });

    it("renders the notice for a WS-refusal host via showIncompatible", () => {
      const page = mountPage(container);

      page.showIncompatible("server-a.example:8443", 2, 1);

      const notice = container.querySelector(".incompatible-notice")!;
      expect(notice.classList.contains("visible")).toBe(true);
      expect(notice.textContent).toContain("server-a.example:8443");

      page.destroy?.();
    });
  });

  // --- Pending transient error display ---

  it("shows pending transient error on mount and clears it", () => {
    setTransientError("Already connected from another client");

    const page = mountPage(container);

    const errorBanner = container.querySelector(".error-banner")!;
    expect(errorBanner.classList.contains("visible")).toBe(true);
    expect(errorBanner.textContent).toBe("Already connected from another client");

    // Transient error should be cleared
    expect(uiStore.getState().transientError).toBeNull();

    page.destroy?.();
  });

  // B4_conn_ipc-6: a WS auth_error, cert-mismatch reject, or credential-save
  // warning can set transientError AFTER this page is already mounted — a
  // one-time getState() read at mount would silently drop it.
  it("shows a transient error set after mount, not just one already pending at mount time", () => {
    const page = mountPage(container);

    // No error yet at mount time.
    expect(container.querySelector(".error-banner")!.classList.contains("visible")).toBe(false);

    setTransientError("Your session expired — sign in again.");
    uiStore.flush();

    const errorBanner = container.querySelector(".error-banner")!;
    expect(errorBanner.classList.contains("visible")).toBe(true);
    expect(errorBanner.textContent).toBe("Your session expired — sign in again.");
    expect(uiStore.getState().transientError).toBeNull();

    page.destroy?.();
  });

  // B4_conn_ipc-15: a transient error set while this page was mounted (e.g. a
  // background credential-save failure fired after a successful login moved
  // on to MainPage) must not survive to resurface at the NEXT mount — which
  // only happens after a later logout, where it would misleadingly read as a
  // fresh login failure.
  it("clears a transient error on destroy so it cannot resurface as a bogus login error later", () => {
    const page = mountPage(container);

    // Set while mounted but not yet observed (no flush before destroy) —
    // mirrors a background failure landing just as the page is torn down.
    setTransientError("Could not save credentials — auto-login won't work");
    page.destroy?.();

    expect(uiStore.getState().transientError).toBeNull();
  });

  // --- TOTP overlay interactions ---

  it("TOTP submit calls onTotpSubmit with 6-digit code", async () => {
    const onTotpSubmit = vi.fn().mockResolvedValue(undefined);
    const { page, totpInput } = mountTotp(container, { onTotpSubmit });
    totpInput.value = "123456";

    const verifyBtn = qs<HTMLButtonElement>(container, ".totp-overlay .btn-primary");
    verifyBtn.click();

    await waitForCall(onTotpSubmit, "123456");

    page.destroy?.();
  });
});

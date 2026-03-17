import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConnectPage } from "../../src/pages/ConnectPage";
import type { ConnectPageCallbacks, ServerProfile } from "../../src/pages/ConnectPage";
import { uiStore } from "../../src/stores/ui.store";

// Mock SettingsOverlay so we don't pull in all its dependencies
vi.mock("../../src/components/SettingsOverlay", () => ({
  createSettingsOverlay: () => ({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

// Mock ui.store actions
vi.mock("../../src/stores/ui.store", async () => {
  const actual = await vi.importActual<typeof import("../../src/stores/ui.store")>(
    "../../src/stores/ui.store",
  );
  return {
    ...actual,
    openSettings: vi.fn(),
    closeSettings: vi.fn(),
  };
});

function makeCallbacks(overrides: Partial<ConnectPageCallbacks> = {}): ConnectPageCallbacks {
  return {
    onLogin: vi.fn().mockResolvedValue(undefined),
    onRegister: vi.fn().mockResolvedValue(undefined),
    onTotpSubmit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const testProfiles: ServerProfile[] = [
  { name: "Test Server", host: "localhost:8443" },
];

describe("ConnectPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
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
    const toggleLink = container.querySelector(".form-switch a") as HTMLElement;
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

  it("disables form inputs during loading state", async () => {
    let resolveLogin: () => void;
    const loginPromise = new Promise<void>((resolve) => { resolveLogin = resolve; });
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
      expect(hostInput.disabled).toBe(true);
      expect(usernameInput.disabled).toBe(true);
      expect(passwordInput.disabled).toBe(true);
    });

    resolveLogin!();

    page.destroy?.();
  });

  it("cleans up on destroy", () => {
    const page = createConnectPage(makeCallbacks(), testProfiles);
    page.mount(container);

    expect(container.querySelector(".connect-page")).not.toBeNull();

    page.destroy?.();
    expect(container.querySelector(".connect-page")).toBeNull();
  });
});

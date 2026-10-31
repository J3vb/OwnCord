/**
 * The portal's sign-in form (WP 6.13e1): the connect page with a fixed host.
 * Runs in the `web` project, where `__OWNCORD_WEB__` is true and the platform
 * registry is the browser one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.stubGlobal("isSecureContext", true);
});
vi.mock("../../src/features/settings/SettingsOverlay", () => ({
  createSettingsOverlay: () => ({ mount: vi.fn(), destroy: vi.fn() }),
}));

import { createConnectPage } from "../../src/pages/ConnectPage";
import type { ConnectPageCallbacks } from "../../src/pages/ConnectPage";
import { portalText } from "../../src/i18n/portal";

const HOST = location.host;

function makeCallbacks(overrides: Partial<ConnectPageCallbacks> = {}): ConnectPageCallbacks {
  return {
    onLogin: vi.fn().mockResolvedValue(undefined),
    onLoginWithSavedPassword: vi.fn().mockResolvedValue(undefined),
    onRegister: vi.fn().mockResolvedValue(undefined),
    onTotpSubmit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  container.remove();
});

function mountPortal(overrides: Partial<ConnectPageCallbacks> = {}) {
  const callbacks = makeCallbacks(overrides);
  const page = createConnectPage(callbacks, [{ name: "chat.example", host: HOST }]);
  page.mount(container);
  return { page, callbacks };
}

function field(id: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`#${id}`)!;
}

function hidden(el: Element): boolean {
  return el.closest(".form-group")!.classList.contains("form-group--hidden");
}

describe("portal sign-in form", () => {
  it("no host or remember fields", () => {
    mountPortal();
    expect(field("host").value).toBe(HOST);
    expect(hidden(field("host"))).toBe(true);
    expect(hidden(field("remember-password"))).toBe(true);
    expect(field("remember-password").checked).toBe(false);
    // The server list is built but not mounted: a portal has one server.
    expect(container.querySelector(".server-panel")).toBeNull();
    expect(container.querySelector(".server-list")).toBeNull();
  });

  it("stay signed in checked by default", () => {
    const { page } = mountPortal();
    const checkbox = field("auto-connect");
    expect(checkbox.checked).toBe(true);
    expect(hidden(checkbox)).toBe(false);
    const label = container.querySelector(`label[for="auto-connect"]`)!;
    expect(label.textContent).toBe(portalText("login.stayLoggedIn"));
    expect(label.textContent).toBe("Stay signed in");
    expect(page.getAutoConnect()).toBe(true);
    expect(page.getRememberPassword()).toBe(false);
  });

  it("invite host ignored", () => {
    const { page } = mountPortal();
    page.applyInviteLink("INVITE-CODE", "evil.example:1");
    page.selectServer("evil.example:1", "mallory", true, true);
    expect(field("host").value).toBe(HOST);
    expect(field("invite").value).toBe("INVITE-CODE");
    // A profile that asks to remember a password is not honoured either.
    expect(field("remember-password").checked).toBe(false);
  });

  it("username/password autocomplete", () => {
    mountPortal();
    expect(field("username").getAttribute("autocomplete")).toBe("username");
    expect(field("password").getAttribute("autocomplete")).toBe("current-password");
  });

  it("TOTP step shows and submits", async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const onTotpSubmit = vi.fn().mockResolvedValue(undefined);
    const { page } = mountPortal({ onLogin, onTotpSubmit });

    field("username").value = "casey";
    field("password").value = "correct horse";
    container.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledWith(HOST, "casey", "correct horse"));

    page.showTotp();
    const overlay = container.querySelector(".totp-overlay")!;
    expect(overlay.classList.contains("totp-overlay--hidden")).toBe(false);
    const codeInput = overlay.querySelector("input")!;
    codeInput.value = "123456";
    overlay.querySelector<HTMLButtonElement>(".btn-primary")!.click();
    await vi.waitFor(() => expect(onTotpSubmit).toHaveBeenCalledWith("123456"));
    // The host is still the page's own after the challenge.
    expect(field("host").value).toBe(HOST);
  });

  it("one heading: the card's subtitle names the server, the host until its name arrives", () => {
    const names = new Map<string, string>();
    const { page } = mountPortal({ getServerName: (h) => names.get(h) ?? null });
    expect(container.querySelector(".portal-header")).toBeNull();
    expect(container.querySelectorAll(".brand-name, .form-logo h1")).toHaveLength(1);
    const subtitle = container.querySelector(".form-logo p")!;
    expect(subtitle.textContent).toBe(portalText("login.subtitle", { server: HOST }));
    names.set(HOST, "Casey's Place");
    page.updateCompatibility(HOST, "compatible", 1);
    expect(subtitle.textContent).toBe(portalText("login.subtitle", { server: "Casey's Place" }));
  });
});

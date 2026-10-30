import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/connectPageMocks";
import { createConnectPage } from "../../../src/pages/ConnectPage";
import type { SimpleProfile } from "../../../src/pages/ConnectPage";
import { canonicalServerHost } from "../../../src/lib/net/hostNormalize";
import { makeCallbacks } from "../../helpers/connectPageHarness";

vi.mock("../../../src/lib/net/credentials", () => mocks.netCredentialsMock());
vi.mock("../../../src/components/SettingsOverlay", () => mocks.settingsOverlayMock());
vi.mock("../../../src/stores/ui.store", () => mocks.uiStoreMock());

describe("canonicalServerHost", () => {
  it("trims and lowercases a typed address", () => {
    expect(canonicalServerHost("  Chat.Example.COM:8443 ")).toBe("chat.example.com:8443");
    expect(canonicalServerHost("[FD00::1]:8443")).toBe("[fd00::1]:8443");
  });

  it("keeps the spelling of a saved host that differs only in case", () => {
    expect(canonicalServerHost("chat.example.com", ["Chat.Example.com"])).toBe("Chat.Example.com");
  });

  it("drops the scheme and path of a pasted link", () => {
    expect(canonicalServerHost("https://Chat.Example.com:8443/channels/2?x=1")).toBe(
      "chat.example.com:8443",
    );
    expect(canonicalServerHost("wss://[FD00::1]:8443/api/v1/ws")).toBe("[fd00::1]:8443");
    expect(canonicalServerHost("chat.example.com/")).toBe("chat.example.com");
  });

  it("returns an empty string for a blank box", () => {
    expect(canonicalServerHost("   ", ["a"])).toBe("");
  });
});

describe("connect page server address case", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function submit(profiles: SimpleProfile[], typedHost: string) {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onLogin }), profiles);
    page.mount(container);
    const host = container.querySelector("#host") as HTMLInputElement;
    host.value = typedHost;
    host.dispatchEvent(new Event("input"));
    (container.querySelector("#username") as HTMLInputElement).value = "alice";
    (container.querySelector("#password") as HTMLInputElement).value = "password123";
    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return { page, onLogin, host };
  }

  it("signs in to the lowercased host when the address was typed with capitals", async () => {
    const { page, onLogin } = submit([], "Chat.Example.com:8443");
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalled());
    expect(onLogin).toHaveBeenCalledWith("chat.example.com:8443", "alice", "password123");
    page.destroy?.();
  });

  it("matches a saved server typed in another case and keeps its saved spelling", async () => {
    const { page, onLogin } = submit([{ name: "Home", host: "Home.Lan:8443" }], "home.lan:8443");
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalled());
    expect(onLogin).toHaveBeenCalledWith("Home.Lan:8443", "alice", "password123");
    page.destroy?.();
  });

  it("shows the lowercased address once the box loses focus", () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const page = createConnectPage(makeCallbacks({ onLogin }), []);
    page.mount(container);
    const host = container.querySelector("#host") as HTMLInputElement;
    host.value = " MyServer.com ";
    host.dispatchEvent(new Event("change"));
    expect(host.value).toBe("myserver.com");
    page.destroy?.();
  });

  it("signs in to the host of a pasted link", async () => {
    const { page, onLogin, host } = submit([], "https://Chat.Example.com/");
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalled());
    expect(onLogin).toHaveBeenCalledWith("chat.example.com", "alice", "password123");
    host.dispatchEvent(new Event("change"));
    expect(host.value).toBe("chat.example.com");
    page.destroy?.();
  });

  it("says what is wrong with an address that is not one, without sending it", async () => {
    const { page, onLogin, host } = submit([], "chat example com");
    await vi.waitFor(() =>
      expect(container.querySelector(".error-banner")!.textContent).toContain(
        "That is not a server address",
      ),
    );
    expect(onLogin).not.toHaveBeenCalled();
    expect(host.getAttribute("aria-invalid")).toBe("true");
    page.destroy?.();
  });

  it("asks password managers for a new password only when registering", () => {
    const page = createConnectPage(makeCallbacks(), []);
    page.mount(container);
    const password = container.querySelector("#password") as HTMLInputElement;
    const toggle = container.querySelector(".form-switch button") as HTMLButtonElement;
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    toggle.click();
    expect(password.getAttribute("autocomplete")).toBe("new-password");
    toggle.click();
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    page.destroy?.();
  });

  it("does not focus the address on a touch screen, so the keyboard stays down", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({ matches: query === "(pointer: coarse)" }) as MediaQueryList) as typeof window.matchMedia;
    try {
      const page = createConnectPage(makeCallbacks(), []);
      page.mount(container);
      expect(document.activeElement).not.toBe(container.querySelector("#host"));
      page.destroy?.();
    } finally {
      window.matchMedia = original;
    }
  });

  it("focuses the address on a desktop", () => {
    const page = createConnectPage(makeCallbacks(), []);
    page.mount(container);
    expect(document.activeElement).toBe(container.querySelector("#host"));
    page.destroy?.();
  });

  it("tells phone keyboards not to capitalise or correct the address", () => {
    const page = createConnectPage(makeCallbacks(), []);
    page.mount(container);
    const host = container.querySelector("#host") as HTMLInputElement;
    expect(host.getAttribute("autocapitalize")).toBe("none");
    expect(host.getAttribute("autocorrect")).toBe("off");
    expect(host.getAttribute("spellcheck")).toBe("false");
    expect(host.getAttribute("inputmode")).toBe("url");
    for (const id of ["#username", "#invite"]) {
      const input = container.querySelector(id) as HTMLInputElement;
      expect(input.getAttribute("autocapitalize")).toBe("none");
      expect(input.getAttribute("autocorrect")).toBe("off");
    }
    page.destroy?.();
  });
});

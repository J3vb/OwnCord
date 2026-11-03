import { describe, it, expect, vi, beforeEach } from "vitest";
import * as mocks from "../../helpers/connectPageMocks";
import { useConnectPageContainer, mountPage, qs } from "../../helpers/connectPageHarness";

const host = vi.hoisted(() => ({ android: true }));

vi.mock("../../../src/lib/hostPlatform", () => ({
  isAndroidHost: () => host.android,
}));
vi.mock("../../../src/lib/net/credentials", () => mocks.netCredentialsMock());
vi.mock("../../../src/features/settings/SettingsOverlay", () => mocks.settingsOverlayMock());
vi.mock("../../../src/stores/ui.store", () => mocks.uiStoreMock());

const optedOutProfile = [
  { name: "Home", host: "home:8443", username: "me", autoConnect: false, rememberPassword: false },
];

describe("ConnectPage sign-in boxes on the Android app", () => {
  let container: HTMLDivElement;
  useConnectPageContainer((mounted) => {
    container = mounted;
  });
  beforeEach(() => {
    host.android = true;
  });

  it("shows one ticked Stay signed in box and hides Auto connect", () => {
    const page = mountPage(container);
    const stay = qs(container, "#remember-password");
    expect(stay.checked).toBe(true);
    expect(qs(container, "label[for='remember-password']").textContent).toContain("Stay signed in");
    expect(
      qs(container, "#auto-connect")
        .closest(".form-group")
        ?.classList.contains("form-group--hidden"),
    ).toBe(true);
    expect(page.getRememberPassword()).toBe(true);
    expect(page.getAutoConnect()).toBe(true);
    page.destroy?.();
  });

  it("keeps the sign-in by default for a saved server that had both boxes off", () => {
    const page = mountPage(container, {}, optedOutProfile);
    qs<HTMLElement>(container, ".server-item").click();
    expect(page.getRememberPassword()).toBe(true);
    expect(page.getAutoConnect()).toBe(true);
    page.destroy?.();
  });

  it("an untick on a shared device keeps nothing", () => {
    const page = mountPage(container);
    const stay = qs(container, "#remember-password");
    stay.click();
    expect(stay.checked).toBe(false);
    expect(page.getRememberPassword()).toBe(false);
    expect(page.getAutoConnect()).toBe(false);
    page.destroy?.();
  });

  it("leaves the desktop boxes as they were", () => {
    host.android = false;
    const page = mountPage(container, {}, optedOutProfile);
    expect(qs(container, "label[for='remember-password']").textContent).toBe("Remember password");
    expect(qs(container, "#remember-password").checked).toBe(false);
    qs<HTMLElement>(container, ".server-item").click();
    expect(page.getRememberPassword()).toBe(false);
    expect(page.getAutoConnect()).toBe(false);
    page.destroy?.();
  });
});

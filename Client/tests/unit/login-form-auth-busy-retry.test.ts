// P5-S02: a login burst makes the server queue bcrypt, and when its queue is
// full it answers 429 AUTH_BUSY with Retry-After. The connect page retries
// that refusal by itself — typed and saved password alike — for a bounded
// time, showing that it is retrying, and gives up with the busy copy after
// the bound. A per-IP 429 (RATE_LIMITED) is not retried.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClientError } from "../../src/lib/api";
import { createConnectPage } from "../../src/pages/ConnectPage";
import type { ConnectPageCallbacks, SimpleProfile } from "../../src/pages/ConnectPage";
import { connectText } from "../../src/i18n/connect";

const mockLoadCredential = vi.fn().mockResolvedValue(null);
vi.mock("../../src/lib/credentials", () => ({
  loadCredential: (...args: unknown[]) => mockLoadCredential(...args),
}));

vi.mock("../../src/components/SettingsOverlay", () => ({
  createSettingsOverlay: () => ({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

const BUSY_MESSAGE = "too many authentication attempts in progress, try again later";

function busy(retryAfterMs?: number): ApiClientError {
  return new ApiClientError(429, "AUTH_BUSY", BUSY_MESSAGE, retryAfterMs);
}

function makeCallbacks(overrides: Partial<ConnectPageCallbacks> = {}): ConnectPageCallbacks {
  return {
    onLogin: vi.fn().mockResolvedValue(undefined),
    onLoginWithSavedPassword: vi.fn().mockResolvedValue(undefined),
    onRegister: vi.fn().mockResolvedValue(undefined),
    onTotpSubmit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const testProfiles: SimpleProfile[] = [{ name: "Test Server", host: "localhost:8443" }];

describe("LoginForm retries a busy server", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLoadCredential.mockResolvedValue(null);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  function submitTyped(): void {
    (container.querySelector("#host") as HTMLInputElement).value = "localhost:8443";
    (container.querySelector("#username") as HTMLInputElement).value = "testuser";
    (container.querySelector("#password") as HTMLInputElement).value = "long-enough-password";
    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  const busyLine = (): HTMLElement => container.querySelector(".auth-busy-retry") as HTMLElement;
  const busyShown = (): boolean => !busyLine().hidden;
  const banner = (): HTMLElement => container.querySelector(".error-banner") as HTMLElement;

  it("retries a typed-password login on AUTH_BUSY until it succeeds", async () => {
    const onLogin = vi
      .fn()
      .mockRejectedValueOnce(busy(2000))
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce(undefined);
    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    submitTyped();
    await vi.advanceTimersByTimeAsync(0);
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(busyShown()).toBe(true);
    expect(busyLine().getAttribute("role")).toBe("status");
    expect(busyLine().textContent).toContain(connectText("login.serverBusyRetrying"));
    expect(banner().classList.contains("visible")).toBe(false);

    // Retry-After is honoured: nothing before it has passed.
    await vi.advanceTimersByTimeAsync(1900);
    expect(onLogin).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onLogin).toHaveBeenCalledTimes(3);
    expect(banner().classList.contains("visible")).toBe(false);
    expect(busyShown()).toBe(false);

    page.destroy?.();
  });

  it("gives up after the retry bound and shows the busy copy", async () => {
    const onLogin = vi.fn().mockRejectedValue(busy(1000));
    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    submitTyped();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(banner().classList.contains("visible")).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(banner().classList.contains("visible")).toBe(true);
    expect(banner().textContent).toBe(connectText("error.authBusy"));
    expect(busyShown()).toBe(false);
    const calls = onLogin.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    // Bounded: Retry-After is a second, jitter only adds to it.
    expect(calls).toBeLessThanOrEqual(61);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onLogin).toHaveBeenCalledTimes(calls);

    page.destroy?.();
  });

  it("Cancel stops retrying and returns to the form", async () => {
    const onLogin = vi.fn().mockRejectedValue(busy(5000));
    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    submitTyped();
    await vi.advanceTimersByTimeAsync(0);
    expect(busyShown()).toBe(true);
    (busyLine().querySelector("button") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(busyShown()).toBe(false);
    expect(banner().classList.contains("visible")).toBe(false);
    const submit = container.querySelector(
      ".connect-form button[type=submit]",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    page.destroy?.();
  });

  it("does not retry a per-IP RATE_LIMITED refusal", async () => {
    const onLogin = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError(429, "RATE_LIMITED", "too many requests, please slow down", 30_000),
      );
    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    submitTyped();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(banner().classList.contains("visible")).toBe(true);

    page.destroy?.();
  });

  it("retries a saved-password login on AUTH_BUSY", async () => {
    mockLoadCredential.mockResolvedValue({
      username: "saveduser",
      token: "tok",
      hasPassword: true,
    });
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const onLoginWithSavedPassword = vi
      .fn()
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce(undefined);
    const page = createConnectPage(
      makeCallbacks({ onLogin, onLoginWithSavedPassword }),
      testProfiles,
    );
    page.mount(container);

    (container.querySelector(".server-item") as HTMLElement).click();
    await vi.waitFor(() => expect(page.isUsingSavedPassword()).toBe(true));
    const form = container.querySelector(".connect-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onLoginWithSavedPassword).toHaveBeenCalledTimes(2);
    expect(onLoginWithSavedPassword).toHaveBeenLastCalledWith("localhost:8443", "saveduser");
    expect(onLogin).not.toHaveBeenCalled();
    expect(banner().classList.contains("visible")).toBe(false);

    page.destroy?.();
  });
});

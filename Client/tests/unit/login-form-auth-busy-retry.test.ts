// P5-S02: a login burst makes the server queue bcrypt, and when its queue is
// full it answers 429 AUTH_BUSY with Retry-After. The connect page retries
// that refusal by itself — typed and saved password alike — for a bounded
// time, showing that it is retrying, and gives up with the busy copy after
// the bound. Retries stay at least 15 s apart so one client never spends the
// per-IP login limit (5 a minute, refused attempts included). A per-IP 429
// (RATE_LIMITED) is not retried.
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
    vi.restoreAllMocks();
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
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onLogin = vi
      .fn()
      .mockRejectedValueOnce(busy(20_000))
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

    // A Retry-After above the floor is honoured: nothing before it has passed.
    await vi.advanceTimersByTimeAsync(19_900);
    expect(onLogin).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(onLogin).toHaveBeenCalledTimes(2);
    // No Retry-After: the 15 s floor applies.
    await vi.advanceTimersByTimeAsync(13_900);
    expect(onLogin).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
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
    await vi.advanceTimersByTimeAsync(40_000);
    expect(banner().classList.contains("visible")).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(banner().classList.contains("visible")).toBe(true);
    expect(banner().textContent).toBe(connectText("error.authBusy"));
    expect(busyShown()).toBe(false);
    const calls = onLogin.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onLogin).toHaveBeenCalledTimes(calls);

    page.destroy?.();
  });

  it.each([
    ["typed", undefined],
    ["typed with a short Retry-After", 1000],
    ["saved", undefined],
  ] as const)(
    "keeps a %s-password login under the per-IP limit in any 60 s",
    async (path, retryAfterMs) => {
      // No jitter: the tightest spacing the retry can produce.
      vi.spyOn(Math, "random").mockReturnValue(0);
      const saved = path === "saved";
      if (saved) {
        mockLoadCredential.mockResolvedValue({
          username: "saveduser",
          token: "tok",
          hasPassword: true,
        });
      }
      const attempts: number[] = [];
      const refuse = vi.fn(() => {
        attempts.push(Date.now());
        return Promise.reject(busy(retryAfterMs));
      });
      const page = createConnectPage(
        makeCallbacks(saved ? { onLoginWithSavedPassword: refuse } : { onLogin: refuse }),
        testProfiles,
      );
      page.mount(container);

      if (saved) {
        (container.querySelector(".server-item") as HTMLElement).click();
        await vi.waitFor(() => expect(page.isUsingSavedPassword()).toBe(true));
        const form = container.querySelector(".connect-form") as HTMLFormElement;
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      } else {
        submitTyped();
      }
      await vi.advanceTimersByTimeAsync(180_000);

      expect(attempts.length).toBeGreaterThan(1);
      // The login route allows 5 per IP per minute, refused attempts included.
      for (const t of attempts) {
        expect(attempts.filter((a) => a <= t && a > t - 60_000).length).toBeLessThan(5);
      }
      expect(Math.max(...attempts) - Math.min(...attempts)).toBeLessThan(60_000);
      expect(banner().textContent).toBe(connectText("error.authBusy"));

      page.destroy?.();
    },
  );

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

  it("Cancel during a retry in flight sends no further retry and returns to the form", async () => {
    let refuseInFlight: ((err: unknown) => void) | undefined;
    const onLogin = vi
      .fn()
      .mockRejectedValueOnce(busy())
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            refuseInFlight = reject;
          }),
      )
      .mockRejectedValue(busy());
    const page = createConnectPage(makeCallbacks({ onLogin }), testProfiles);
    page.mount(container);

    submitTyped();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(onLogin).toHaveBeenCalledTimes(2);
    expect(busyShown()).toBe(true);

    (busyLine().querySelector("button") as HTMLButtonElement).click();
    expect(busyShown()).toBe(false);
    refuseInFlight?.(busy());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onLogin).toHaveBeenCalledTimes(2);
    expect(banner().classList.contains("visible")).toBe(false);
    const submit = container.querySelector(
      ".connect-form button[type=submit]",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    page.destroy?.();
  });

  it.each([
    ["picking another server", "card", false],
    ["picking another server", "card", true],
    ["opening an invite link", "invite", false],
    ["opening an invite link", "invite", true],
  ] as const)(
    "%s (%s, in flight: %s) stops the retry and ends the attempt",
    async (_label, trigger, inFlight) => {
      let refuseInFlight: ((err: unknown) => void) | undefined;
      const onLogin = vi.fn().mockRejectedValueOnce(busy());
      if (inFlight) {
        onLogin.mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              refuseInFlight = reject;
            }),
        );
      }
      onLogin.mockRejectedValue(busy());
      const onAutoLoginCancel = vi.fn(() => refuseInFlight?.(new Error("session ended")));
      const page = createConnectPage(makeCallbacks({ onLogin, onAutoLoginCancel }), [
        ...testProfiles,
        { name: "Other Server", host: "other.example:8443" },
      ]);
      page.mount(container);

      submitTyped();
      await vi.advanceTimersByTimeAsync(inFlight ? 16_000 : 0);
      expect(onLogin).toHaveBeenCalledTimes(inFlight ? 2 : 1);
      expect(busyShown()).toBe(true);

      if (trigger === "card") {
        (container.querySelectorAll(".server-item")[1] as HTMLElement).click();
      } else {
        page.applyInviteLink("INVITE-CODE", "other.example:8443");
      }
      expect(onAutoLoginCancel).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(onLogin).toHaveBeenCalledTimes(inFlight ? 2 : 1);
      expect(busyShown()).toBe(false);
      expect(banner().classList.contains("visible")).toBe(false);
      expect((container.querySelector("#host") as HTMLInputElement).value).toBe(
        "other.example:8443",
      );
      const submit = container.querySelector(
        ".connect-form button[type=submit]",
      ) as HTMLButtonElement;
      expect(submit.disabled).toBe(false);

      page.destroy?.();
    },
  );

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

    await vi.advanceTimersByTimeAsync(16_000);
    expect(onLoginWithSavedPassword).toHaveBeenCalledTimes(2);
    expect(onLoginWithSavedPassword).toHaveBeenLastCalledWith("localhost:8443", "saveduser");
    expect(onLogin).not.toHaveBeenCalled();
    expect(banner().classList.contains("visible")).toBe(false);

    page.destroy?.();
  });
});

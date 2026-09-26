// B7-15b: the 2FA box takes an emergency recovery code as well as a TOTP
// code, and the connect page offers account recovery with a kit secret or an
// owner-issued recovery credential.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConnectPage } from "../../src/pages/ConnectPage";
import type { ConnectPageCallbacks, SimpleProfile } from "../../src/pages/ConnectPage";

vi.mock("../../src/lib/credentials", () => ({
  loadCredential: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/components/SettingsOverlay", () => ({
  createSettingsOverlay: () => ({ mount: vi.fn(), destroy: vi.fn() }),
}));

function makeCallbacks(overrides: Partial<ConnectPageCallbacks> = {}): ConnectPageCallbacks {
  return {
    onLogin: vi.fn().mockResolvedValue(undefined),
    onLoginWithSavedPassword: vi.fn().mockResolvedValue(undefined),
    onRegister: vi.fn().mockResolvedValue(undefined),
    onTotpSubmit: vi.fn().mockResolvedValue(undefined),
    onRecover: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const profiles: SimpleProfile[] = [{ name: "Test Server", host: "localhost:8443" }];
const KIT = "K7QF-3M2X-9PLA-ZB5A-QW2E-TT7Y-AAAA-BBBB";

/** What Chromium does to a focused control once it is disabled; jsdom does not. */
function dropFocusToBody(): void {
  const sink = document.createElement("button");
  document.body.appendChild(sink);
  sink.focus();
  sink.remove();
}

describe("LoginForm 2FA box accepts an emergency recovery code", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => container.remove());

  function open(onTotpSubmit = vi.fn().mockResolvedValue(undefined)) {
    const page = createConnectPage(makeCallbacks({ onTotpSubmit }), profiles);
    page.mount(container);
    page.showTotp();
    const card = container.querySelector(".totp-overlay .totp-card")!;
    return {
      page,
      card,
      input: card.querySelector("input") as HTMLInputElement,
      verify: card.querySelector(".btn-primary") as HTMLButtonElement,
      onTotpSubmit,
    };
  }

  it("lets an 11-character code be typed and says so", () => {
    const { page, card, input } = open();
    expect(input.getAttribute("maxlength")).toBe("11");
    expect(input.getAttribute("inputmode")).toBe("text");
    const pattern = new RegExp(`^(?:${input.getAttribute("pattern")})$`);
    expect(pattern.test("123456")).toBe(true);
    expect(pattern.test("ABCDE-FGHJK")).toBe(true);
    expect(card.textContent).toContain("emergency recovery code");
    page.destroy?.();
  });

  it.each(["123456", "ABCDE-FGHJK", "abcdefghjk"])("submits %s", async (code) => {
    const { page, input, verify, onTotpSubmit } = open();
    input.value = code;
    verify.click();
    await vi.waitFor(() => expect(onTotpSubmit).toHaveBeenCalledWith(code));
    page.destroy?.();
  });

  it.each(["12345", "ABCD-EFGH", "ABCDE--FGHJK", "ABCDE_FGHJK"])("refuses %s", (code) => {
    const { page, input, verify, onTotpSubmit } = open();
    input.value = code;
    verify.click();
    expect(onTotpSubmit).not.toHaveBeenCalled();
    page.destroy?.();
  });

  it("keeps the overlay open after a wrong recovery code and sends a double Enter once", async () => {
    let reject!: (e: Error) => void;
    const onTotpSubmit = vi.fn(
      () =>
        new Promise<void>((_resolve, rej) => {
          reject = rej;
        }),
    );
    const { page, input, verify } = open(onTotpSubmit);
    input.value = "ABCDE-FGHJK";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onTotpSubmit).toHaveBeenCalledTimes(1);
    reject(new Error("invalid two-factor code"));
    await vi.waitFor(() => expect(verify.disabled).toBe(false));
    const overlay = container.querySelector(".totp-overlay")!;
    expect(overlay.classList.contains("totp-overlay--hidden")).toBe(false);
    page.destroy?.();
  });

  it("returns focus to Verify after a rejected code submitted from the button", async () => {
    const onTotpSubmit = vi.fn().mockRejectedValue(new Error("invalid two-factor code"));
    const { page, input, verify } = open(onTotpSubmit);
    input.value = "123456";
    verify.focus();
    verify.click();
    expect(verify.disabled).toBe(true);
    dropFocusToBody();
    await vi.waitFor(() => expect(verify.disabled).toBe(false));
    expect(document.activeElement).toBe(verify);
    page.destroy?.();
  });
});

describe("Account recovery from the connect page", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => container.remove());

  async function mountPage(onRecover: ConnectPageCallbacks["onRecover"]) {
    const page = createConnectPage(makeCallbacks({ onRecover }), profiles);
    page.mount(container);
    const q = <T extends Element>(sel: string) => container.querySelector(sel) as T;
    q<HTMLInputElement>("#host").value = "chat.example:8443";
    q<HTMLInputElement>("#username").value = "alice";
    q<HTMLAnchorElement>('[data-testid="recover-account-link"]').click();
    // The overlay module is imported on first use.
    await vi.waitFor(() => expect(q('[data-testid="recover-overlay"]')).not.toBeNull());
    return {
      page,
      overlay: q<HTMLDivElement>('[data-testid="recover-overlay"]'),
      username: q<HTMLInputElement>("#recover-username"),
      secret: q<HTMLInputElement>("#recover-secret"),
      password: q<HTMLInputElement>("#recover-password"),
      submit: q<HTMLButtonElement>('[data-testid="recover-submit"]'),
      cancel: q<HTMLButtonElement>('[data-testid="recover-cancel"]'),
      error: q<HTMLDivElement>('[data-testid="recover-error"]'),
    };
  }

  it("names both kinds of secret the field accepts", async () => {
    const f = await mountPage(vi.fn().mockResolvedValue(undefined));
    expect(f.overlay.classList.contains("totp-overlay--hidden")).toBe(false);
    expect(container.querySelector('label[for="recover-secret"]')!.textContent).toBe(
      "Recovery kit secret or a recovery credential from your server owner",
    );
    // The username carries over from the login form.
    expect(f.username.value).toBe("alice");
    f.page.destroy?.();
  });

  it("recovers with host, username, secret and new password, then wipes them", async () => {
    const onRecover = vi.fn().mockResolvedValue(undefined);
    const f = await mountPage(onRecover);
    f.secret.value = ` ${KIT} `;
    f.password.value = "N3w-Str0ng!";
    f.submit.click();
    f.submit.click();
    await vi.waitFor(() => expect(f.overlay.classList.contains("totp-overlay--hidden")).toBe(true));
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(onRecover).toHaveBeenCalledWith("chat.example:8443", "alice", KIT, "N3w-Str0ng!");
    expect(f.secret.value).toBe("");
    expect(f.password.value).toBe("");
    f.page.destroy?.();
  });

  it("keeps the overlay and the secret after a refused attempt, and shows why", async () => {
    const onRecover = vi.fn().mockRejectedValue(new Error("invalid credentials"));
    const f = await mountPage(onRecover);
    f.secret.value = KIT;
    f.password.value = "N3w-Str0ng!";
    f.submit.click();
    await vi.waitFor(() => expect(f.error.textContent).toBe("invalid credentials"));
    expect(f.overlay.classList.contains("totp-overlay--hidden")).toBe(false);
    expect(f.submit.disabled).toBe(false);
    expect(f.secret.value).toBe(KIT);
    f.page.destroy?.();
  });

  it("returns focus to the submit button after a refused attempt", async () => {
    const f = await mountPage(vi.fn().mockRejectedValue(new Error("invalid credentials")));
    f.secret.value = KIT;
    f.password.value = "N3w-Str0ng!";
    f.submit.focus();
    f.submit.click();
    expect(f.submit.disabled).toBe(true);
    dropFocusToBody();
    await vi.waitFor(() => expect(f.error.textContent).toBe("invalid credentials"));
    expect(document.activeElement).toBe(f.submit);
    f.page.destroy?.();
  });

  it.each([
    ["", "N3w-Str0ng!", /recovery kit secret/],
    [KIT, "short", /at least 8/],
  ])("validates before sending (secret %j)", async (secret, pw, message) => {
    const onRecover = vi.fn();
    const f = await mountPage(onRecover);
    f.secret.value = secret;
    f.password.value = pw;
    f.submit.click();
    expect(onRecover).not.toHaveBeenCalled();
    expect(f.error.textContent).toMatch(message);
    f.page.destroy?.();
  });

  it("wipes the secret on cancel", async () => {
    const f = await mountPage(vi.fn());
    f.secret.value = KIT;
    f.password.value = "N3w-Str0ng!";
    f.cancel.click();
    expect(f.overlay.classList.contains("totp-overlay--hidden")).toBe(true);
    expect(f.secret.value).toBe("");
    expect(f.password.value).toBe("");
    f.page.destroy?.();
  });
});

import { expect, vi } from "vitest";
import type { Mock } from "vitest";
import { createConnectPage } from "../../src/pages/ConnectPage";
import type { ConnectPageCallbacks, SimpleProfile } from "../../src/pages/ConnectPage";
import { mockLoadCredential } from "./connectPageMocks";
import { useMountContainer } from "./mountContainer";

export function makeCallbacks(overrides: Partial<ConnectPageCallbacks> = {}): ConnectPageCallbacks {
  return {
    onLogin: vi.fn().mockResolvedValue(undefined),
    onLoginWithSavedPassword: vi.fn().mockResolvedValue(undefined),
    onRegister: vi.fn().mockResolvedValue(undefined),
    onTotpSubmit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export const testProfiles: SimpleProfile[] = [{ name: "Test Server", host: "localhost:8443" }];

/** What Chromium does to a focused control once it is disabled; jsdom does not. */
export function dropFocusToBody(): void {
  const sink = document.createElement("button");
  document.body.appendChild(sink);
  sink.focus();
  sink.remove();
}

export type ConnectPageHandle = ReturnType<typeof createConnectPage>;

/**
 * Registers the per-test container and resets the credential loader so every
 * test starts with no saved credential. `bind` receives each new container.
 */
export function useConnectPageContainer(bind: (container: HTMLDivElement) => void): void {
  useMountContainer((container) => {
    mockLoadCredential.mockReset();
    mockLoadCredential.mockResolvedValue(null);
    bind(container);
  });
}

/** A fresh credential record with a remembered password. */
export function savedCredential(overrides: Record<string, unknown> = {}): {
  username: string;
  token: string;
  hasPassword: boolean;
} {
  return { username: "saveduser", token: "tok", hasPassword: true, ...overrides };
}

/** Creates a connect page over the shared test profiles and mounts it. */
export function mountPage(
  container: HTMLElement,
  overrides: Partial<ConnectPageCallbacks> = {},
  profiles: SimpleProfile[] = testProfiles,
): ConnectPageHandle {
  const page = createConnectPage(makeCallbacks(overrides), profiles);
  page.mount(container);
  return page;
}

/** Typed lookup that fails with the selector when the element is missing. */
export function qs<T extends Element = HTMLInputElement>(
  container: ParentNode,
  selector: string,
): T {
  const el = container.querySelector<T>(selector);
  if (el === null) throw new Error(`element not found: ${selector}`);
  return el;
}

export function submitForm(container: ParentNode): void {
  qs<HTMLFormElement>(container, ".connect-form").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
}

/** Sets a field's value without firing events. */
export function setField(container: ParentNode, selector: string, value: string): void {
  qs(container, selector).value = value;
}

/** Sets a field's value and fires `input` on it, as typing or a paste would. */
export function inputField(container: ParentNode, selector: string, value: string): void {
  const el = qs(container, selector);
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
}

export function fillLogin(
  container: ParentNode,
  host: string,
  username: string,
  password: string,
): void {
  setField(container, "#host", host);
  setField(container, "#username", username);
  setField(container, "#password", password);
}

/** Flips the form between login and register through the footer switch. */
export function switchMode(container: ParentNode): HTMLElement {
  const toggle = qs<HTMLElement>(container, ".form-switch button");
  toggle.click();
  return toggle;
}

/** Clicks the first server item and waits until the saved password is in use. */
export async function pickSavedServer(
  container: ParentNode,
  page: ConnectPageHandle,
): Promise<void> {
  qs<HTMLElement>(container, ".server-item").click();
  await vi.waitFor(() => {
    expect(page.isUsingSavedPassword()).toBe(true);
  });
}

/** Mounts a page whose first profile resolves to a remembered password. */
export async function mountWithSavedPassword(
  container: HTMLElement,
  overrides: Partial<ConnectPageCallbacks> = {},
): Promise<{
  page: ConnectPageHandle;
  onLogin: Mock;
  onLoginWithSavedPassword: Mock;
  onRegister: Mock;
}> {
  mockLoadCredential.mockResolvedValue(savedCredential());
  const onLogin = vi.fn().mockResolvedValue(undefined);
  const onLoginWithSavedPassword = vi.fn().mockResolvedValue(undefined);
  const onRegister = vi.fn().mockResolvedValue(undefined);
  const page = mountPage(container, {
    onLogin,
    onLoginWithSavedPassword,
    onRegister,
    ...overrides,
  });
  await pickSavedServer(container, page);
  return { page, onLogin, onLoginWithSavedPassword, onRegister };
}

/** Dispatches a bubbling, cancelable event of `type` on `target`. */
export function fire(target: EventTarget, type: string): void {
  target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
}

/** Sets a field's value then fires `input`, as typing or a paste would. */
export function typeInto(field: HTMLInputElement, value: string): void {
  field.value = value;
  fire(field, "input");
}

/** Waits until `fn` has been called with exactly these arguments. */
export async function waitForCall(fn: unknown, ...args: unknown[]): Promise<void> {
  await vi.waitFor(() => {
    expect(fn).toHaveBeenCalledWith(...args);
  });
}

/** Waits until `fn` has been called `times` times. */
export async function waitForCalls(fn: unknown, times: number): Promise<void> {
  await vi.waitFor(() => {
    expect(fn).toHaveBeenCalledTimes(times);
  });
}

/** Waits until the form's error banner is showing. */
export async function expectBannerVisible(container: ParentNode): Promise<void> {
  await vi.waitFor(() => {
    expect(qs(container, ".error-banner").classList.contains("visible")).toBe(true);
  });
}

/** Fills the login fields and submits the form. */
export function signIn(
  container: ParentNode,
  host: string,
  username: string,
  password: string,
): void {
  fillLogin(container, host, username, password);
  submitForm(container);
}

/** Waits until the error banner reads exactly `text`. */
export async function expectBannerText(container: ParentNode, text: string): Promise<void> {
  await vi.waitFor(() => {
    expect(qs(container, ".error-banner").textContent).toBe(text);
  });
}

/** Waits until the error banner contains `text`. */
export async function expectBannerContains(container: ParentNode, text: string): Promise<void> {
  await vi.waitFor(() => {
    expect(qs(container, ".error-banner").textContent).toContain(text);
  });
}

/** An `onLogin` spy that stays pending until `resolveLogin` is called. */
export function pendingLogin(): { onLogin: Mock; resolveLogin: () => void } {
  let resolveLogin: () => void = () => {};
  const loginPromise = new Promise<void>((resolve) => {
    resolveLogin = resolve;
  });
  return { onLogin: vi.fn().mockReturnValue(loginPromise), resolveLogin };
}

/** Mounts a page and opens its two-factor overlay. */
export function mountTotp(
  container: HTMLElement,
  overrides: Partial<ConnectPageCallbacks> = {},
): { page: ConnectPageHandle; totpInput: HTMLInputElement } {
  const page = mountPage(container, overrides);
  page.showTotp();
  return { page, totpInput: qs(container, ".totp-overlay input") };
}

export function clickVerify(container: ParentNode): void {
  qs<HTMLButtonElement>(container, ".totp-overlay .btn-primary").click();
}

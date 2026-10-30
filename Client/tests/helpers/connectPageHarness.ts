import { vi } from "vitest";
import type { ConnectPageCallbacks, SimpleProfile } from "../../src/pages/ConnectPage";

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

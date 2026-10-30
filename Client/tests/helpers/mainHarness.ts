import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { mockInvoke, emitTauriEvent } from "../unit/helpers/ws-mocks";
import { expectConsole } from "./console";
import { clearAuth } from "@stores/auth.store";
import { createApiClient } from "@lib/api";
import { createConnectPage } from "@pages/ConnectPage";
import {
  deepLink,
  mockLogin,
  mockRegister,
  createdApiClients,
  capturedConnectCallbacks,
  createdConnectPages,
  setStartupInvokes,
} from "./mainMocks";

export const latestConnectPage = () =>
  vi.mocked(createdConnectPages.at(-1) as ReturnType<typeof createConnectPage>, true);

export const startupApiClient = () => createdApiClients[0] as ReturnType<typeof createApiClient>;

/** Drive a full login → WS connect → auth_ok cycle through the captured
 *  ConnectPage callback and the real ws.ts client living inside main.ts. */
export async function loginAndReachAuthOk(
  host: string,
  username: string,
  authOkPayload: { user: unknown; server_name: string; motd: string },
): Promise<void> {
  mockLogin.mockResolvedValue({ token: "test-token", requires_2fa: false });
  await capturedConnectCallbacks.onLogin!(host, username, "hunter2");
  await vi.advanceTimersByTimeAsync(10);
  emitTauriEvent("ws-state", "open");
  emitTauriEvent("ws-message", JSON.stringify({ type: "auth_ok", payload: authOkPayload }));
}

// main.ts hands its deep-link callback to the plugin once, at module load; a
// test's mockClear must not lose it.
export let deepLinkHandler: ((urls: readonly string[]) => void) | undefined;

/** Sign in on `host`, reach the main page, and return the deep-link handler. */
export async function signedInWithDeepLinkHandler(
  host: string,
  serverName: string,
): Promise<(urls: readonly string[]) => void> {
  await loginAndReachAuthOk(host, "alex", {
    user: { id: 1, username: "alex", avatar: null, role: "member" },
    server_name: serverName,
    motd: "",
  });
  expectConsole("warn", /\[main\] Credential delete failed/);
  emitTauriEvent("ws-message", JSON.stringify({ type: "ready", payload: {} }));
  await vi.advanceTimersByTimeAsync(800);
  deepLinkHandler ??= deepLink.handler as (urls: readonly string[]) => void;
  expect(deepLinkHandler).toBeTypeOf("function");
  return deepLinkHandler;
}

/** Wait for the lazily imported confirm dialog (and its catalog) to show `text`. */
export async function dialogShows(text: string): Promise<void> {
  await vi.waitFor(() => expect(dialogEl()?.textContent ?? "").toContain(text));
}

export const dialogEl = () => document.querySelector('[data-testid="invite-join-dialog"]');

export const clickDialog = (button: "confirm" | "cancel") =>
  document.querySelector<HTMLButtonElement>(`[data-testid="invite-join-${button}"]`)!.click();

/** Registers the shared beforeAll/beforeEach/afterEach for every main.ts test file. */
export function useMainHarness(): void {
  beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import("../../src/main");
    // Flush the microtask the mocked (async) listen() call resolves on, so the
    // "status-change" handler main.ts registers at module load is actually in
    // eventHandlers before any test fires it.
    await Promise.resolve();
    await Promise.resolve();
    setStartupInvokes(mockInvoke.mock.calls.map((call) => call[0]));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset().mockResolvedValue(undefined);
    mockRegister.mockReset();
    localStorage.clear();
    clearAuth();
  });

  afterEach(async () => {
    // ws.ts arms its app-lifetime wake-probe listeners (window online,
    // document visibilitychange) on auth_ok, and releases them on
    // disconnect(). clearAuth() drives main.ts's isAuthenticated subscriber,
    // which calls ws.disconnect(); the advance flushes the microtask-deferred
    // store notification that runs it.
    clearAuth();
    await vi.advanceTimersByTimeAsync(10);
  });
}

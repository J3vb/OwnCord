/**
 * Records the app's outgoing native calls from inside the page so a mocked spec
 * can assert on the exact requests: every `plugin:http|fetch` (method, URL and
 * decoded body) and every `ws_send` (the raw frame).
 *
 * Install `captureCalls` as a `wrappers` entry of `buildTauriMockScript`, so it
 * runs after the mock has set up `__TAURI_INTERNALS__.invoke`, then read the
 * log back with `getCapturedCalls`, `fetchCalls` or the `waitFor…` pollers.
 */
import { expect, type Page } from "@playwright/test";

export interface CapturedCall {
  readonly cmd: string;
  readonly method?: string;
  readonly url?: string;
  readonly body?: string | null;
  readonly message?: string;
}

interface CaptureWindow {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
  __capturedCalls: CapturedCall[];
}

interface InvokeArgs {
  clientConfig?: { method?: string; url?: string; data?: unknown };
  message?: string;
}

/**
 * Runs in the page, serialised by `buildTauriMockScript`, so it must stay
 * self-contained: no imports, no module-level names.
 */
export function captureCalls(): void {
  const w = window as unknown as CaptureWindow;
  const internals = w.__TAURI_INTERNALS__;
  const orig = internals.invoke;
  w.__capturedCalls = [];
  internals.invoke = async (cmd: string, args?: unknown) => {
    const a = args as InvokeArgs | undefined;
    if (cmd === "plugin:http|fetch") {
      const cfg = a?.clientConfig ?? {};
      let body: string | null = null;
      if (Array.isArray(cfg.data)) {
        try {
          body = new TextDecoder().decode(new Uint8Array(cfg.data));
        } catch {
          body = null;
        }
      }
      w.__capturedCalls.push({ cmd, method: cfg.method, url: cfg.url, body });
    } else if (cmd === "ws_send") {
      w.__capturedCalls.push({ cmd, message: a?.message });
    }
    return orig(cmd, args);
  };
}

/** Every call captured so far, HTTP and WebSocket alike. */
export async function getCapturedCalls(page: Page): Promise<CapturedCall[]> {
  return page.evaluate(() => {
    return ((window as unknown as CaptureWindow).__capturedCalls ?? []) as CapturedCall[];
  });
}

/** The captured HTTP requests only. */
export async function fetchCalls(page: Page): Promise<CapturedCall[]> {
  return (await getCapturedCalls(page)).filter((c) => c.cmd === "plugin:http|fetch");
}

async function pollFor(
  read: () => Promise<CapturedCall[]>,
  predicate: (call: CapturedCall) => boolean,
  timeout: number,
): Promise<CapturedCall> {
  let found: CapturedCall | undefined;
  await expect(async () => {
    found = (await read()).find(predicate);
    expect(found).toBeDefined();
  }).toPass({ timeout });
  return found!;
}

/** Poll until a captured call matches, and return it. Avoids racing the async send. */
export function waitForCapturedCall(
  page: Page,
  predicate: (call: CapturedCall) => boolean,
  timeout = 5_000,
): Promise<CapturedCall> {
  return pollFor(() => getCapturedCalls(page), predicate, timeout);
}

/** Poll until a captured HTTP request matches, and return it. */
export function waitForFetchCall(
  page: Page,
  predicate: (call: CapturedCall) => boolean,
  timeout = 5_000,
): Promise<CapturedCall> {
  return pollFor(() => fetchCalls(page), predicate, timeout);
}

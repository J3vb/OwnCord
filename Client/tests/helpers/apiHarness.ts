import { afterEach, beforeEach, vi, type Mock } from "vitest";
import { createApiClient, type OnUnauthorized } from "../../src/lib/api";

export function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

export function errorResponse(status: number, code: string, message: string): Response {
  return {
    ok: false,
    status,
    statusText: message,
    json: () => Promise.resolve({ error: code, message }),
    headers: new Headers(),
  } as unknown as Response;
}

/** Error response whose body is an empty JSON object. */
export function emptyBodyErrorResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({}),
    headers: new Headers(),
  } as unknown as Response;
}

/** Error response whose json() throws (simulates non-JSON body). */
export function brokenJsonErrorResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: () => Promise.reject(new SyntaxError("Unexpected token")),
    headers: new Headers(),
  } as unknown as Response;
}

export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * A fresh client per test against the mocked fetch: `mockFetch` is reset, then
 * `setup` runs, then `bind` receives the client and its unauthorized spy.
 * `teardown` runs after each test.
 */
export function useApiClient(opts: {
  mockFetch: Mock;
  host: string;
  token: string;
  setup?: () => void;
  teardown: () => void;
  bind: (api: ApiClient, onUnauthorized: Mock<OnUnauthorized>) => void;
}): void {
  beforeEach(() => {
    opts.mockFetch.mockReset();
    opts.setup?.();
    const onUnauthorized = vi.fn<OnUnauthorized>();
    opts.bind(
      createApiClient({ host: opts.host, token: opts.token }, onUnauthorized),
      onUnauthorized,
    );
  });
  afterEach(opts.teardown);
}

/** Readers for the Nth fetch invocation's URL and init. */
export function fetchCallReaders(mockFetch: Mock) {
  return {
    url: (n = 0): string => mockFetch.mock.calls[n]?.[0] as string,
    init: (n = 0): RequestInit => mockFetch.mock.calls[n]?.[1] as RequestInit,
  };
}

/** The default suite client: localhost:8443 with a test token, mocks restored afterwards. */
export function useDefaultApiClient(
  mockFetch: Mock,
  bind: (api: ApiClient, onUnauthorized: Mock<OnUnauthorized>) => void,
): void {
  useApiClient({
    mockFetch,
    host: "localhost:8443",
    token: "test-token",
    teardown: () => vi.restoreAllMocks(),
    bind,
  });
}

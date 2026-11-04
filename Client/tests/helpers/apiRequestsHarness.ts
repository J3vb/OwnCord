import type { Mock } from "vitest";
import { createApiClient, type OnUnauthorized } from "../../src/lib/api";
import { fetchCallReaders, jsonResponse, useApiClient } from "./apiHarness";

export type Api = ReturnType<typeof createApiClient>;

export const okResponse = (data: unknown = {}, status = 200): Response =>
  jsonResponse(data, status);

export function failResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: false,
    status,
    statusText: "Status Text",
    json: () => Promise.resolve(body),
    headers: new Headers(headers),
  } as unknown as Response;
}

export const BASE = "https://host.test:8443/api/v1";

/** The requests-suite client: proxy and progress handlers reset, fetch answering ok. */
export function useRequestsClient(
  mocks: {
    mockFetch: Mock;
    proxy: { impl: (host: string) => PromiseLike<string> };
    progressHandlers: { clear(): void };
  },
  teardown: () => void,
  bind: (api: Api, onUnauthorized: Mock<OnUnauthorized>) => void,
): void {
  useApiClient({
    mockFetch: mocks.mockFetch,
    host: "host.test:8443",
    token: "tok-1",
    setup: () => {
      mocks.proxy.impl = (host) => Promise.resolve(`https://${host}`);
      mocks.progressHandlers.clear();
      mocks.mockFetch.mockImplementation(() => Promise.resolve(okResponse({})));
    },
    teardown,
    bind,
  });
}

/** Readers for the Nth request: URL, init, headers and the parsed JSON body. */
export function requestReaders(mockFetch: Mock) {
  const { url, init } = fetchCallReaders(mockFetch);
  return {
    callUrl: url,
    callInit: init,
    callHeaders: (n = 0): Record<string, string> => init(n).headers as Record<string, string>,
    callBody: (n = 0): unknown => JSON.parse(init(n).body as string),
  };
}

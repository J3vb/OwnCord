import { vi } from "vitest";

export const { mockFetch, proxy, progressHandlers } = {
  mockFetch: vi.fn(),
  progressHandlers: new Set<(e: { payload: unknown }) => void>(),
  proxy: {
    impl: (host: string): PromiseLike<string> => Promise.resolve(`https://${host}`),
  },
};

export function pluginHttpMock() {
  return { fetch: mockFetch };
}

export function apiEventMock() {
  return {
    listen: (_event: string, handler: (e: { payload: unknown }) => void) => {
      progressHandlers.add(handler);
      return Promise.resolve(() => progressHandlers.delete(handler));
    },
  };
}

export function netHttpProxyMock() {
  return {
    ensureHttpProxy: (host: string) => proxy.impl(host),
    stopHttpProxy: () => Promise.resolve(),
  };
}

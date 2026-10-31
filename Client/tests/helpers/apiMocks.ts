import { vi } from "vitest";

// Mock the Tauri HTTP plugin — vi.hoisted ensures the fn is available when
// vi.mock's factory runs (hoisted above all imports).
export const { mockFetch } = {
  mockFetch: vi.fn(),
};

export function pluginHttpMock() {
  return {
    fetch: mockFetch,
  };
}

// Mock the Rust HTTP TOFU proxy so ensureHttpProxy resolves synchronously to a
// stable origin. Returning `https://{host}` keeps the URL assertions below
// unchanged — the proxy indirection is exercised by the Rust unit tests and by
// httpProxy's own tests, not here.
export function netHttpProxyMock() {
  return {
    ensureHttpProxy: (host: string) => Promise.resolve(`https://${host}`),
    stopHttpProxy: () => Promise.resolve(),
  };
}

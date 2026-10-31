import { vi } from "vitest";

export { consentExternalMock } from "./mediaMocks";
export { loggerMock } from "./loggerMock";

const LOOPBACK_ORIGIN = "http://127.0.0.1:9999";

export function httpPluginMock(fetch: unknown) {
  return { fetch };
}

/** The TOFU proxy resolves a server host to a fixed loopback origin. */
export function httpProxyMock(ensureHttpProxy: unknown = () => Promise.resolve(LOOPBACK_ORIGIN)) {
  return { ensureHttpProxy, stopHttpProxy: () => Promise.resolve() };
}

export function authStoreMock(getToken: unknown) {
  return { getToken, authStore: { getState: () => ({ uploadPolicy: null }) } };
}

export function externalContentMock(preview: unknown, image: unknown) {
  return { externalContent: { preview, image } };
}

export function dialogMock(save: unknown = vi.fn()) {
  return { save };
}

export function fsMock(writeFile: unknown = vi.fn()) {
  return { writeFile };
}

export function iconsMock() {
  return { createIcon: () => document.createElement("span") };
}

export function mediaVisibilityMock(observeMedia: unknown = vi.fn()) {
  return { observeMedia };
}

export function contentMediaMock() {
  return { openImageLightbox: vi.fn() };
}

/** An IndexedDB whose open() fails, so cache reads fall through to the network. */
export function failingIndexedDb() {
  return {
    open: () => {
      const req: Record<string, unknown> = {
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      Promise.resolve().then(() => {
        const fn = req.onerror as ((ev: Event) => void) | null;
        fn?.(new Event("error"));
      });
      return req;
    },
  };
}

/** A fetch Response stand-in carrying a three-byte PNG body. */
export function imageResponse() {
  return {
    ok: true,
    headers: { get: () => "image/png" },
    arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
  };
}

export const fetchMock = vi.fn();
export const getTokenMock = vi.fn();
export const ensureHttpProxyMock = vi.fn();
export const brokerImageMock = vi.fn();

export function resetServerMocks(): void {
  fetchMock.mockReset();
  getTokenMock.mockReset();
  ensureHttpProxyMock.mockReset();
}

/** A signed-in (or, with null, signed-out) viewer whose server answers every file with a PNG. */
export function arrangeServerImage(token: string | null): void {
  getTokenMock.mockReturnValue(token);
  ensureHttpProxyMock.mockResolvedValue("http://127.0.0.1:49812");
  fetchMock.mockResolvedValue(imageResponse());
}

/** Answers an IDBOpenDBRequest stand-in: an upgrade, then success, on the next microtask. */
export function settleOpenRequest(req: Record<string, unknown>): void {
  Promise.resolve().then(() => {
    const upgrade = req.onupgradeneeded as ((ev: Event) => void) | null;
    upgrade?.(new Event("upgradeneeded"));
    const success = req.onsuccess as ((ev: Event) => void) | null;
    success?.(new Event("success"));
  });
}

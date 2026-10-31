import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be set up before any import that references them.
// ---------------------------------------------------------------------------

export const { previewMock, imageMock, observeMediaMock, loadPrefMock } = {
  previewMock: vi.fn(),
  imageMock: vi.fn(),
  observeMediaMock: vi.fn(),
  loadPrefMock: vi.fn(),
};

// B9-8: this suite exercises content the viewer has already consented to;
// the consent gate itself is proven in src/features/content-consent/external.test.ts.
export async function consentExternalMock(importOriginal: <T>() => Promise<T>) {
  return {
    ...(await importOriginal<typeof import("../../src/features/content-consent/external")>()),
    externalAllowed: () => true,
  };
}

export function desktopExternalContentMock() {
  return {
    externalContent: { preview: previewMock, image: imageMock },
  };
}

export function loggerMock() {
  return {
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
}

export function prefsMediaVisibilityMock() {
  return {
    observeMedia: observeMediaMock,
  };
}

export function iconsMock() {
  return {
    createIcon: (name: string, size: number) => {
      const el = document.createElement("span");
      el.setAttribute("data-icon", name);
      el.setAttribute("data-size", String(size));
      return el;
    },
  };
}

export async function prefsPreferencesMock(importOriginal: <T>() => Promise<T>) {
  return {
    ...(await importOriginal<typeof import("../../src/lib/prefs/preferences")>()),
    loadPref: loadPrefMock,
    savePref: vi.fn(),
  };
}

// The real broker wrapper (fetchExternalImage + its FIFO cache) runs against
// the mocked broker above; only isSafeUrl is pinned to a plain http(s) check.
export async function listAttachmentsMock(importOriginal: <T>() => Promise<T>) {
  return {
    ...(await importOriginal<typeof import("../../src/components/message-list/attachments")>()),
    isSafeUrl: (url: string) => {
      try {
        const parsed = new URL(url, "https://placeholder");
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
  };
}

export function listEmbedsMock() {
  return {
    renderGenericLinkPreview: (url: string) => {
      const el = document.createElement("div");
      el.className = "msg-embed-link";
      el.textContent = url;
      return el;
    },
    clearEmbedCaches: () => {},
  };
}

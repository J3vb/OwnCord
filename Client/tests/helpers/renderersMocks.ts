import { vi } from "vitest";

// B7-16: every external image and oEmbed title comes from the native broker.
export const { previewMock, imageMock, consent } = {
  previewMock: vi.fn(),
  imageMock: vi.fn(),
  consent: { allowed: true },
};

// B9-8: this suite exercises content the viewer has already consented to;
// the consent gate itself is proven in src/features/content-consent/external.test.ts.
export async function consentExternalMock(importOriginal: <T>() => Promise<T>) {
  return {
    ...(await importOriginal<typeof import("../../src/features/content-consent/external")>()),
    externalAllowed: () => consent.allowed,
  };
}

export function desktopExternalContentMock() {
  return {
    externalContent: { preview: previewMock, image: imageMock },
  };
}

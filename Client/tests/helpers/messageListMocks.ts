import { vi } from "vitest";

// jsdom does not provide ResizeObserver — stub it so MessageList can mount.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {
      /* noop */
    }
    unobserve(): void {
      /* noop */
    }
    disconnect(): void {
      /* noop */
    }
  } as unknown as typeof ResizeObserver;
}

// An avatar change repaints through createAvatarElement, which fetches the
// picture bytes through the authenticated attachment path. Stub just that fetch
// so the swap can be observed; the URL resolution stays real.
export const { fetchImageAsObjectUrlMock } = {
  fetchImageAsObjectUrlMock: vi.fn(() => Promise.resolve("data:image/png;base64,AAAA")),
};

export async function listAttachmentsMock(importOriginal: <T>() => Promise<T>) {
  const actual =
    await importOriginal<typeof import("../../src/features/messaging/content/attachments")>();
  return { ...actual, fetchImageAsObjectUrl: fetchImageAsObjectUrlMock };
}

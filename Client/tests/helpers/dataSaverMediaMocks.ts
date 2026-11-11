import { vi } from "vitest";

export const dataSaverImage = vi.fn();
export const dataSaverExternalImage = vi.fn();
export const dataSaverPreview = vi.fn();

export async function dataSaverCacheMock(importOriginal: <T>() => Promise<T>) {
  const actual =
    await importOriginal<typeof import("../../src/features/messaging/content/attachmentCache")>();
  return {
    ...actual,
    fetchImageAsObjectUrl: dataSaverImage,
    loadExternalImage: dataSaverExternalImage,
    previewExternal: dataSaverPreview,
    recoverEvictedImage: vi.fn(),
    getFileLink: vi.fn().mockResolvedValue(null),
  };
}

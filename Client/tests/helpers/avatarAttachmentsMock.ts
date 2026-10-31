import type { Mock } from "vitest";

/**
 * The attachments module with only the network fetch stubbed: isSafeUrl and
 * resolveServerUrl are reimplemented (not mocked away) so the
 * raw-src-vs-authenticated-fetch distinction a suite exercises stays honest.
 */
export function avatarAttachmentsMock(fetchImageAsObjectUrl: Mock) {
  return {
    fetchImageAsObjectUrl,
    // No cached bytes: every avatar here is a still picture.
    cachedImageBytes: () => null,
    recoverEvictedImage: () => {},
    isSafeUrl: (url: string) => url.startsWith("https://") || url.startsWith("http://"),
    resolveServerUrl: (url: string) => (url.startsWith("http") ? url : `https://server.test${url}`),
  };
}

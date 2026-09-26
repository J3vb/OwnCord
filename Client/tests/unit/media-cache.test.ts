import { beforeEach, describe, expect, it, vi } from "vitest";

const { previewMock, imageMock } = vi.hoisted(() => ({
  previewMock: vi.fn<any>(),
  imageMock: vi.fn<any>(),
}));

// B9-8: this suite exercises content the viewer has already consented to;
// the consent gate itself is proven in src/features/content-consent/external.test.ts.
vi.mock("../../src/features/content-consent/external", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/content-consent/external")>()),
  externalAllowed: () => true,
}));

vi.mock("../../src/platform/desktop/externalContent", () => ({
  externalContent: { preview: previewMock, image: imageMock },
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../src/components/message-list/attachments", () => ({
  isSafeUrl: () => true,
  externalPartition: () => "test#0",
  previewExternal: (url: string) =>
    (previewMock as (partition: string, url: string) => unknown)("test#0", url),
  clearExternalImageCache: () => {},
  fetchExternalImage: () => Promise.resolve(null),
  recoverEvictedImage: () => {},
}));

vi.mock("../../src/components/message-list/embeds", () => ({
  renderGenericLinkPreview: vi.fn(),
  clearEmbedCaches: vi.fn(),
}));

import { clearMediaCaches, renderYouTubeEmbed } from "../../src/components/message-list/media";

function oembedResponse(title: string) {
  return { ok: true, value: { title, description: null, siteName: null, image: null } };
}

describe("media cache clearing", () => {
  beforeEach(() => {
    previewMock.mockReset();
    imageMock.mockReset();
    clearMediaCaches();
    document.body.innerHTML = "";
  });

  it("replaces a stale loading title with a fallback when the cache is cleared mid-fetch", async () => {
    let resolveFetch: ((value: ReturnType<typeof oembedResponse>) => void) | undefined;
    previewMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const element = renderYouTubeEmbed("abc123", "https://www.youtube.com/watch?v=abc123");
    document.body.appendChild(element);

    const title = element.querySelector(".msg-embed-yt-title") as HTMLAnchorElement;
    expect(title.textContent).toBe("Loading...");

    clearMediaCaches();
    resolveFetch?.(oembedResponse("Loaded title"));

    await vi.waitFor(() => {
      expect(title.textContent).toBe("YouTube Video");
    });
  });
});

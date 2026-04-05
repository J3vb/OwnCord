import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn<any>(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: fetchMock,
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../src/components/message-list/attachments", () => ({
  isSafeUrl: () => true,
}));

vi.mock("../../src/components/message-list/embeds", () => ({
  renderGenericLinkPreview: vi.fn(),
}));

import { clearMediaCaches, renderYouTubeEmbed } from "../../src/components/message-list/media";

function oembedResponse(title: string) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({ title }),
  };
}

describe("media cache clearing", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearMediaCaches();
    document.body.innerHTML = "";
  });

  it("replaces a stale loading title with a fallback when the cache is cleared mid-fetch", async () => {
    let resolveFetch: ((value: ReturnType<typeof oembedResponse>) => void) | undefined;
    fetchMock.mockImplementationOnce(
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

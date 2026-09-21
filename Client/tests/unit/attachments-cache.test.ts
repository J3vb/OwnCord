import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, putSpy, brokerImageMock } = vi.hoisted(() => ({
  fetchMock: vi.fn<any>(),
  putSpy: vi.fn<(value: string, key: string) => void>(),
  brokerImageMock: vi.fn<any>(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: fetchMock,
}));

// These caches hold server content only (B7-16): the URLs below are the
// configured server's, reached through the (mocked) TOFU proxy.
vi.mock("@lib/httpProxy", () => ({
  ensureHttpProxy: vi.fn().mockResolvedValue("http://127.0.0.1:49812"),
}));
vi.mock("@stores/auth.store", () => ({ getToken: () => null }));
vi.mock("../../src/platform/desktop/externalContent", () => ({
  externalContent: { preview: vi.fn(), image: brokerImageMock },
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: vi.fn() }));
vi.mock("@lib/icons", () => ({ createIcon: () => document.createElement("span") }));
vi.mock("@lib/media-visibility", () => ({ observeMedia: vi.fn() }));
vi.mock("../../src/components/message-list/media", () => ({ openImageLightbox: vi.fn() }));

vi.stubGlobal("indexedDB", {
  open: () => {
    const db = {
      objectStoreNames: { contains: () => true },
      createObjectStore: vi.fn(),
      close: vi.fn(),
      transaction: () => {
        const tx: Record<string, unknown> = {
          oncomplete: null,
          onabort: null,
          onerror: null,
          objectStore: () => ({
            get: () => {
              const req: Record<string, unknown> = {
                onsuccess: null,
                onerror: null,
                result: undefined,
              };
              Promise.resolve().then(() => {
                const fn = req.onsuccess as ((ev: Event) => void) | null;
                fn?.(new Event("success"));
              });
              return req;
            },
            put: (value: string, key: string) => {
              putSpy(value, key);
            },
          }),
        };
        Promise.resolve().then(() => {
          const fn = tx.oncomplete as ((ev: Event) => void) | null;
          fn?.(new Event("complete"));
        });
        return tx;
      },
    };

    const req: Record<string, unknown> = {
      result: db,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };
    Promise.resolve().then(() => {
      const upgrade = req.onupgradeneeded as ((ev: Event) => void) | null;
      upgrade?.(new Event("upgradeneeded"));
      const success = req.onsuccess as ((ev: Event) => void) | null;
      success?.(new Event("success"));
    });
    return req;
  },
});

import {
  clearAttachmentCaches,
  EXTERNAL_IMAGE_CACHE_MAX,
  clearExternalImageCache,
  fetchExternalImage,
  fetchImageAsDataUrl,
  renderAttachment,
  setServerHost,
} from "../../src/components/message-list/attachments";

function imageResponse() {
  return {
    ok: true,
    headers: { get: () => "image/png" },
    arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
  };
}

describe("attachment cache clearing", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    putSpy.mockReset();
    clearAttachmentCaches();
    setServerHost("example.com");
    document.body.innerHTML = "";
  });

  it("never writes an external image into the memory or IndexedDB cache", async () => {
    clearExternalImageCache();
    brokerImageMock.mockResolvedValue({ ok: true, value: new Blob(["x"], { type: "image/png" }) });
    URL.createObjectURL = vi.fn(() => "blob:external-1");
    URL.revokeObjectURL = vi.fn();

    await expect(fetchImageAsDataUrl("https://cdn.elsewhere.example/a.png")).resolves.toBe(
      "blob:external-1",
    );

    expect(brokerImageMock).toHaveBeenCalledWith(expect.any(String), {
      url: "https://cdn.elsewhere.example/a.png",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("does not repopulate caches from an in-flight fetch after clear", async () => {
    let resolveFetch: ((value: ReturnType<typeof imageResponse>) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const pending = fetchImageAsDataUrl("https://example.com/image.png");
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    clearAttachmentCaches();
    resolveFetch?.(imageResponse());

    await expect(pending).resolves.toBeNull();
    expect(putSpy).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(imageResponse());
    await fetchImageAsDataUrl("https://example.com/image.png");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps replacement requests deduplicated after a clear", async () => {
    let resolveFirst: ((value: ReturnType<typeof imageResponse>) => void) | undefined;
    let resolveSecond: ((value: ReturnType<typeof imageResponse>) => void) | undefined;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );

    const first = fetchImageAsDataUrl("https://example.com/image.png");
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    clearAttachmentCaches();

    const second = fetchImageAsDataUrl("https://example.com/image.png");
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    resolveFirst?.(imageResponse());
    await expect(first).resolves.toBeNull();

    const third = fetchImageAsDataUrl("https://example.com/image.png");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveSecond?.(imageResponse());
    await Promise.all([second, third]);
  });

  it("stops showing a loading placeholder when a mid-fetch clear invalidates the result", async () => {
    let resolveFetch: ((value: ReturnType<typeof imageResponse>) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const element = renderAttachment({
      id: "att-1",
      url: "https://example.com/image.png",
      filename: "image.png",
      size: 1,
      mime: "image/png",
    });
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const placeholder = element.querySelector(".placeholder-img") as HTMLElement;
    expect(placeholder.classList.contains("loading")).toBe(true);

    clearAttachmentCaches();
    resolveFetch?.(imageResponse());

    await vi.waitFor(() => {
      expect(placeholder.classList.contains("loading")).toBe(false);
    });
  });

  it("bounds broker-fetched blob: URLs FIFO at EXTERNAL_IMAGE_CACHE_MAX", async () => {
    // These copies live in the webview, outside the broker's byte budget, so
    // the FIFO cap is the only thing bounding them.
    clearExternalImageCache();
    brokerImageMock.mockReset();
    brokerImageMock.mockResolvedValue({ ok: true, value: new Blob(["x"]) });
    let next = 0;
    URL.createObjectURL = vi.fn(() => `blob:fifo-${++next}`);
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    const url = (i: number): string => `https://cdn.elsewhere.example/${i}.png`;

    for (let i = 1; i <= EXTERNAL_IMAGE_CACHE_MAX; i++) {
      await fetchExternalImage({ url: url(i) });
    }
    expect(revoke).not.toHaveBeenCalled(); // exactly at the cap: nothing evicted

    await fetchExternalImage({ url: url(EXTERNAL_IMAGE_CACHE_MAX + 1) });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:fifo-1"); // the oldest goes first

    const calls = brokerImageMock.mock.calls.length;
    await fetchExternalImage({ url: url(2) }); // still cached
    expect(brokerImageMock.mock.calls.length).toBe(calls);
    await fetchExternalImage({ url: url(1) }); // evicted: asked for again
    expect(brokerImageMock.mock.calls.length).toBe(calls + 1);
  });
});

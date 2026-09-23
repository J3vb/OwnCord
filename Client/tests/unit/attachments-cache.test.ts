import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, putSpy, brokerImageMock, idbData } = vi.hoisted(() => ({
  fetchMock: vi.fn<any>(),
  putSpy: vi.fn<(value: string, key: string) => void>(),
  brokerImageMock: vi.fn<any>(),
  /** The stub's durable store: what survives an app restart. */
  idbData: new Map<string, string>(),
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
          objectStore: () => {
            const request = (result: unknown): Record<string, unknown> => {
              const req: Record<string, unknown> = { onsuccess: null, onerror: null, result };
              Promise.resolve().then(() => {
                const fn = req.onsuccess as ((ev: Event) => void) | null;
                fn?.(new Event("success"));
              });
              return req;
            };
            return {
              get: (key: string) => request(idbData.get(key)),
              getAllKeys: () => request([...idbData.keys()]),
              put: (value: string, key: string) => {
                putSpy(value, key);
                idbData.set(key, value);
              },
              delete: (key: string) => {
                idbData.delete(key);
              },
            };
          },
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
  recoverEvictedImage,
  renderAttachment,
  setAttachmentCacheScope,
  setServerHost,
  pruneAttachmentCacheScope,
} from "../../src/components/message-list/attachments";
import { createAvatarElement } from "../../src/lib/avatar";

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
    idbData.clear();
    clearAttachmentCaches();
    setServerHost("example.com");
    setAttachmentCacheScope("example.com#1");
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

  it("re-requests an on-screen image whose blob: URL the FIFO cap evicted", async () => {
    clearExternalImageCache();
    brokerImageMock.mockReset();
    brokerImageMock.mockResolvedValue({ ok: true, value: new Blob(["x"]) });
    let next = 0;
    URL.createObjectURL = vi.fn(() => `blob:live-${++next}`);
    URL.revokeObjectURL = vi.fn();
    const url = (i: number): string => `https://cdn.elsewhere.example/${i}.png`;

    const img = document.createElement("img");
    const otherError = vi.fn();
    recoverEvictedImage(img, { url: url(0) });
    img.addEventListener("error", otherError);
    img.src = (await fetchExternalImage({ url: url(0) }))!;
    expect(img.src).toBe("blob:live-1");

    // A still-live URL that fails is a real failure: nothing to recover.
    img.dispatchEvent(new Event("error"));
    expect(otherError).toHaveBeenCalledTimes(1);

    for (let i = 1; i <= EXTERNAL_IMAGE_CACHE_MAX; i++) {
      await fetchExternalImage({ url: url(i) });
    }
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:live-1");

    // The element reloads its revoked URL (a GIF unfreeze, a lazy load).
    img.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(img.src).toBe(`blob:live-${EXTERNAL_IMAGE_CACHE_MAX + 2}`));
    expect(otherError).toHaveBeenCalledTimes(1); // recovered, not reported

    // When the broker can no longer serve it, the failure reaches the element.
    for (let i = EXTERNAL_IMAGE_CACHE_MAX + 1; i <= 2 * EXTERNAL_IMAGE_CACHE_MAX; i++) {
      await fetchExternalImage({ url: url(i) });
    }
    brokerImageMock.mockResolvedValue({ ok: false, failure: "unavailable" });
    img.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(otherError).toHaveBeenCalledTimes(2));
  });

  it("re-requests an image the manual cache clear revoked", async () => {
    clearExternalImageCache();
    brokerImageMock.mockReset();
    brokerImageMock.mockResolvedValue({ ok: true, value: new Blob(["x"]) });
    let next = 0;
    URL.createObjectURL = vi.fn(() => `blob:clear-${++next}`);
    URL.revokeObjectURL = vi.fn();
    const source = { url: "https://cdn.elsewhere.example/still-shown.gif" };

    const img = document.createElement("img");
    recoverEvictedImage(img, source);
    img.src = (await fetchExternalImage(source))!;
    clearExternalImageCache();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:clear-1");

    img.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(img.src).toBe("blob:clear-2"));
  });

  it("re-requests an external avatar whose blob: URL the FIFO cap evicted", async () => {
    clearExternalImageCache();
    brokerImageMock.mockReset();
    brokerImageMock.mockResolvedValue({ ok: true, value: new Blob(["x"]) });
    let next = 0;
    URL.createObjectURL = vi.fn(() => `blob:avatar-${++next}`);
    URL.revokeObjectURL = vi.fn();

    const avatar = createAvatarElement(
      {
        username: "ext",
        avatar: "https://cdn.elsewhere.example/avatar.png",
      },
      { className: "avatar" },
    );
    document.body.appendChild(avatar);
    await vi.waitFor(() => expect(avatar.querySelector("img")).not.toBeNull());
    const img = avatar.querySelector("img")!;
    expect(img.src).toBe("blob:avatar-1");

    for (let i = 1; i <= EXTERNAL_IMAGE_CACHE_MAX; i++) {
      await fetchExternalImage({ url: `https://cdn.elsewhere.example/${i}.png` });
    }
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:avatar-1");

    img.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(img.src).toBe(`blob:avatar-${EXTERNAL_IMAGE_CACHE_MAX + 2}`));
  });
});

// B7-13: the server-content caches belong to one signed-in account. Every key
// already names the host, so the failures are the ones a host key cannot
// catch: a departed server's bytes left on disk, and a second account on the
// same host served the first account's bytes.
describe("attachment cache profile isolation (B7-13)", () => {
  function bytesResponse(bytes: number[]) {
    return {
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from(bytes).buffer),
    };
  }

  /** What a profile switch does: auth clears, then the next page mounts. */
  function switchTo(host: string, scope: string): void {
    setAttachmentCacheScope(null);
    setServerHost(host);
    setAttachmentCacheScope(scope);
  }

  beforeEach(() => {
    fetchMock.mockReset();
    idbData.clear();
    setAttachmentCacheScope(null);
  });

  it("prunes the previous server's entries from the durable store on a switch", async () => {
    switchTo("a.example", "a.example#1");
    fetchMock.mockResolvedValueOnce(bytesResponse([1]));
    await fetchImageAsDataUrl("https://a.example/api/v1/files/1");
    await vi.waitFor(() => expect(idbData.size).toBe(1));

    switchTo("b.example", "b.example#1");

    await vi.waitFor(() => expect([...idbData.keys()]).toEqual([]));
  });

  it("does not serve a different account on the same host the previous account's bytes", async () => {
    const url = "https://example.com/api/v1/files/7";
    switchTo("example.com", "example.com#1");
    fetchMock.mockResolvedValueOnce(bytesResponse([1]));
    const first = await fetchImageAsDataUrl(url);
    await vi.waitFor(() => expect(idbData.size).toBe(1));

    switchTo("example.com", "example.com#2");
    fetchMock.mockResolvedValueOnce(bytesResponse([2]));
    const second = await fetchImageAsDataUrl(url);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(idbData.size).toBe(1));
    expect([...idbData.values()]).toEqual([second]);
  });

  // B7-15c: a self-deleted account's images leave the disk; other accounts'
  // entries (including one whose id shares a prefix) stay.
  it("prunes only the deleted account's entries", async () => {
    idbData.set("example.com#1|https://example.com/api/v1/files/1", "data:a");
    idbData.set("example.com#10|https://example.com/api/v1/files/2", "data:b");
    idbData.set("other.example#1|https://other.example/api/v1/files/3", "data:c");

    await pruneAttachmentCacheScope("example.com#1");

    await vi.waitFor(() =>
      expect([...idbData.keys()].toSorted()).toEqual([
        "example.com#10|https://example.com/api/v1/files/2",
        "other.example#1|https://other.example/api/v1/files/3",
      ]),
    );
  });

  it("keeps the same account's entries across a sign-out and back in", async () => {
    const url = "https://example.com/api/v1/files/9";
    switchTo("example.com", "example.com#1");
    fetchMock.mockResolvedValueOnce(bytesResponse([9]));
    const first = await fetchImageAsDataUrl(url);
    await vi.waitFor(() => expect(idbData.size).toBe(1));

    switchTo("example.com", "example.com#1");

    await expect(fetchImageAsDataUrl(url)).resolves.toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

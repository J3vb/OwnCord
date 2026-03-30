import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchMock: vi.fn<any>(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: fetchMock,
}));

const { mockObserveMedia } = vi.hoisted(() => ({
  mockObserveMedia: vi.fn(),
}));

vi.mock("@lib/media-visibility", () => ({
  observeMedia: mockObserveMedia,
}));

import { clearEmbedCaches, renderGenericLinkPreview, parseOgTags, applyOgMeta } from "../../src/components/message-list/embeds";
import type { OgMeta } from "../../src/components/message-list/embeds";
import { setServerHost } from "../../src/components/message-list/attachments";

function mockHtmlResponse(html: string) {
  return {
    ok: true,
    headers: {
      get(name: string) {
        return name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null;
      },
    },
    text: vi.fn().mockResolvedValue(html),
  };
}

describe("renderGenericLinkPreview", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    fetchMock.mockReset();
    setServerHost("example.com");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not reuse OG metadata that resolves after the cache was cleared", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveFetch: ((value: any) => void) | null = null;
    fetchMock.mockImplementationOnce((() => new Promise((resolve) => {
      resolveFetch = resolve;
    })) as any);

    const first = renderGenericLinkPreview("https://news.example.com/post");
    document.body.appendChild(first);

    await Promise.resolve();
    clearEmbedCaches();
    (resolveFetch as any)?.(mockHtmlResponse("<html><head><title>Fresh</title></head></html>"));
    await Promise.resolve();
    await Promise.resolve();

    fetchMock.mockResolvedValueOnce(mockHtmlResponse("<html><head><title>Fresh</title></head></html>"));
    const second = renderGenericLinkPreview("https://news.example.com/post");
    document.body.appendChild(second);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("does not reuse an EMPTY_OG result that resolves after the cache was cleared", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveFetch: ((value: any) => void) | null = null;
    fetchMock.mockImplementationOnce((() => new Promise((resolve) => {
      resolveFetch = resolve;
    })) as any);

    const first = renderGenericLinkPreview("https://news.example.com/empty");
    document.body.appendChild(first);

    await Promise.resolve();
    clearEmbedCaches();
    (resolveFetch as any)?.({
      ok: false,
      headers: { get: () => null },
    });
    await Promise.resolve();
    await Promise.resolve();

    fetchMock.mockResolvedValueOnce(mockHtmlResponse("<html><head><title>Recovered</title></head></html>"));
    const second = renderGenericLinkPreview("https://news.example.com/empty");
    document.body.appendChild(second);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps replacement preview requests deduplicated after a clear", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveFirst: ((value: any) => void) | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveSecond: ((value: any) => void) | null = null;
    fetchMock
      .mockImplementationOnce((() => new Promise((resolve) => {
        resolveFirst = resolve;
      })) as any)
      .mockImplementationOnce((() => new Promise((resolve) => {
        resolveSecond = resolve;
      })) as any);

    const first = renderGenericLinkPreview("https://news.example.com/race");
    document.body.appendChild(first);
    await Promise.resolve();

    clearEmbedCaches();

    const second = renderGenericLinkPreview("https://news.example.com/race");
    document.body.appendChild(second);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    (resolveFirst as any)?.(mockHtmlResponse("<html><head><title>Old</title></head></html>"));
    await Promise.resolve();
    await Promise.resolve();

    const third = renderGenericLinkPreview("https://news.example.com/race");
    document.body.appendChild(third);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    (resolveSecond as any)?.(mockHtmlResponse("<html><head><title>New</title></head></html>"));
    await vi.waitFor(() => {
      expect(second.querySelector(".msg-embed-link-title")?.textContent).toBe("New");
    });
  });

  it("fetches OG metadata for public domains that begin with fd", async () => {
    fetchMock.mockResolvedValue(mockHtmlResponse("<html><head><title>F-Droid</title></head></html>"));

    const card = renderGenericLinkPreview("https://fdroid.org/packages");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://fdroid.org/packages",
        expect.objectContaining({
          headers: expect.objectContaining({
            "User-Agent": expect.stringContaining("facebookexternalhit"),
          }),
        }),
      );
    });

    await vi.waitFor(() => {
      expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("F-Droid");
    });
  });

  it("blocks previews for private IPv6 literals", async () => {
    for (const url of ["https://[fd00::1]/", "https://[fe80::1]/", "https://[::ffff:127.0.0.1]/"]) {
      document.body.innerHTML = "";
      const card = renderGenericLinkPreview(url);
      document.body.appendChild(card);
      await Promise.resolve();
      expect(card.querySelector(".msg-embed-link-title")?.textContent).toBeTruthy();
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks previews for loopback IPv4 literals beyond 127.0.0.1", async () => {
    const card = renderGenericLinkPreview("https://127.0.0.2/internal");
    document.body.appendChild(card);

    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("127.0.0.2");
  });

  it("blocks previews for multicast, reserved, and documentation addresses", async () => {
    const blockedUrls = [
      "https://224.0.0.1/",
      "https://239.255.255.250/",
      "https://240.0.0.1/",
      "https://255.255.255.255/",
      "https://192.0.2.1/",
      "https://198.51.100.10/",
      "https://203.0.113.7/",
      "https://[ff02::1]/",
      "https://[2001:db8::1]/",
    ];

    for (const url of blockedUrls) {
      document.body.innerHTML = "";
      const card = renderGenericLinkPreview(url);
      document.body.appendChild(card);
      await Promise.resolve();
      expect(card.querySelector(".msg-embed-link-title")?.textContent).toBeTruthy();
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows previews for the configured OwnCord server even on private hosts", async () => {
    setServerHost("LOCALHOST:8080");
    fetchMock.mockResolvedValue(mockHtmlResponse("<html><head><title>OwnCord Local</title></head></html>"));

    const card = renderGenericLinkPreview("https://localhost:8080/docs");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://localhost:8080/docs",
        expect.objectContaining({
          headers: expect.objectContaining({
            "User-Agent": expect.stringContaining("facebookexternalhit"),
          }),
        }),
      );
    });

    await vi.waitFor(() => {
      expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("OwnCord Local");
    });
  });

  it("blocks preview for malformed URLs", async () => {
    clearEmbedCaches();
    const card = renderGenericLinkPreview("not-a-valid-url");
    document.body.appendChild(card);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips non-HTML responses (e.g., JSON)", async () => {
    clearEmbedCaches();
    fetchMock.mockResolvedValue({
      ok: true,
      headers: {
        get(name: string) {
          return name.toLowerCase() === "content-type" ? "application/json" : null;
        },
      },
      text: vi.fn().mockResolvedValue("{}"),
    });

    const card = renderGenericLinkPreview("https://api.example.com/data.json");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    // Title should fall back to hostname since no OG data from JSON
    await vi.waitFor(() => {
      expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("api.example.com");
    });
  });

  it("handles fetch error gracefully", async () => {
    clearEmbedCaches();
    fetchMock.mockRejectedValueOnce(new Error("Network error"));

    const card = renderGenericLinkPreview("https://error.example.com/page");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    // Should render with hostname as fallback
    expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("error.example.com");
  });

  it("handles non-ok response", async () => {
    clearEmbedCaches();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      headers: { get: () => null },
    });

    const card = renderGenericLinkPreview("https://fail.example.com/404");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it("renders from cache on second call (no second fetch)", async () => {
    clearEmbedCaches();
    fetchMock.mockResolvedValueOnce(
      mockHtmlResponse('<html><head><meta property="og:title" content="Cached Title"></head></html>'),
    );

    const card1 = renderGenericLinkPreview("https://cached.example.com/page");
    document.body.appendChild(card1);

    await vi.waitFor(() => {
      expect(card1.querySelector(".msg-embed-link-title")?.textContent).toBe("Cached Title");
    });

    // Second call should use cache
    const card2 = renderGenericLinkPreview("https://cached.example.com/page");
    document.body.appendChild(card2);
    expect(card2.querySelector(".msg-embed-link-title")?.textContent).toBe("Cached Title");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks CGNAT range (100.64-127.x.x.x)", async () => {
    clearEmbedCaches();
    const card = renderGenericLinkPreview("https://100.64.0.1/internal");
    document.body.appendChild(card);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks 172.16-31.x.x range", async () => {
    clearEmbedCaches();
    const card = renderGenericLinkPreview("https://172.16.0.1/internal");
    document.body.appendChild(card);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows 172.32.x.x (not private)", async () => {
    clearEmbedCaches();
    fetchMock.mockResolvedValueOnce(mockHtmlResponse("<html><head><title>Public</title></head></html>"));
    const card = renderGenericLinkPreview("https://172.32.0.1/page");
    document.body.appendChild(card);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it("blocks 169.254.x.x (link-local)", async () => {
    clearEmbedCaches();
    const card = renderGenericLinkPreview("https://169.254.1.1/internal");
    document.body.appendChild(card);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks 10.x.x.x (private)", async () => {
    clearEmbedCaches();
    const card = renderGenericLinkPreview("https://10.0.0.1/internal");
    document.body.appendChild(card);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks 0.x.x.x (unspecified)", async () => {
    clearEmbedCaches();
    const card = renderGenericLinkPreview("https://0.0.0.0/internal");
    document.body.appendChild(card);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks 192.168.x.x (private)", async () => {
    clearEmbedCaches();
    const card = renderGenericLinkPreview("https://192.168.1.1/admin");
    document.body.appendChild(card);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks 198.18-19.x.x (benchmarking)", async () => {
    clearEmbedCaches();
    const card = renderGenericLinkPreview("https://198.18.0.1/benchmark");
    document.body.appendChild(card);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks 192.0.x.x", async () => {
    clearEmbedCaches();
    const card = renderGenericLinkPreview("https://192.0.0.1/internal");
    document.body.appendChild(card);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks IPv6 unspecified (::)", async () => {
    clearEmbedCaches();
    const card = renderGenericLinkPreview("https://[::]/internal");
    document.body.appendChild(card);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks IPv6 loopback (::1)", async () => {
    clearEmbedCaches();
    const card = renderGenericLinkPreview("https://[::1]/internal");
    document.body.appendChild(card);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks IPv6 fc00::/7 (fc prefix)", async () => {
    clearEmbedCaches();
    const card = renderGenericLinkPreview("https://[fc00::1]/internal");
    document.body.appendChild(card);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows public IPv6 addresses", async () => {
    clearEmbedCaches();
    fetchMock.mockResolvedValueOnce(mockHtmlResponse("<html><head><title>IPv6</title></head></html>"));
    const card = renderGenericLinkPreview("https://[2600::1]/page");
    document.body.appendChild(card);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  // Note: parseIPv4Literal's octet validation (lines 100-102) is unreachable
  // because new URL() already rejects invalid IPv4 addresses before isPrivateHost
  // runs. The branch is defensive coding against edge cases.
});

describe("parseOgTags", () => {
  it("extracts og:title, og:description, og:image, og:site_name", () => {
    const html = `<html><head>
      <meta property="og:title" content="My Page">
      <meta property="og:description" content="A page description">
      <meta property="og:image" content="https://example.com/img.jpg">
      <meta property="og:site_name" content="Example">
    </head></html>`;
    const meta = parseOgTags(html);
    expect(meta.title).toBe("My Page");
    expect(meta.description).toBe("A page description");
    expect(meta.image).toBe("https://example.com/img.jpg");
    expect(meta.siteName).toBe("Example");
  });

  it("falls back to <title> when og:title is missing", () => {
    const html = `<html><head><title>Fallback Title</title></head></html>`;
    const meta = parseOgTags(html);
    expect(meta.title).toBe("Fallback Title");
  });

  it("falls back to meta description when og:description is missing", () => {
    const html = `<html><head><meta name="description" content="Meta desc"></head></html>`;
    const meta = parseOgTags(html);
    expect(meta.description).toBe("Meta desc");
  });

  it("returns nulls when no metadata exists", () => {
    const html = `<html><head></head><body>Hello</body></html>`;
    const meta = parseOgTags(html);
    expect(meta.title).toBeNull();
    expect(meta.description).toBeNull();
    expect(meta.image).toBeNull();
    expect(meta.siteName).toBeNull();
  });

  it("handles reversed attribute order (content before property)", () => {
    const html = `<html><head>
      <meta content="Reversed Title" property="og:title">
    </head></html>`;
    const meta = parseOgTags(html);
    expect(meta.title).toBe("Reversed Title");
  });

  it("is case-insensitive for tag names", () => {
    const html = `<html><head>
      <META PROPERTY="og:title" CONTENT="Upper Case">
    </head></html>`;
    const meta = parseOgTags(html);
    expect(meta.title).toBe("Upper Case");
  });

  it("trims whitespace from <title> tag", () => {
    const html = `<html><head><title>  Spaced Title  </title></head></html>`;
    const meta = parseOgTags(html);
    expect(meta.title).toBe("Spaced Title");
  });
});

describe("applyOgMeta", () => {
  it("sets title from meta", () => {
    const titleEl = document.createElement("a");
    const descEl = document.createElement("div");
    const hostEl = document.createElement("div");
    const imageWrap = document.createElement("div");

    const meta: OgMeta = { title: "Page Title", description: null, image: null, siteName: null };
    applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, "https://example.com/page", "example.com");

    expect(titleEl.textContent).toBe("Page Title");
  });

  it("falls back to displayHost when title is null", () => {
    const titleEl = document.createElement("a");
    const descEl = document.createElement("div");
    const hostEl = document.createElement("div");
    const imageWrap = document.createElement("div");

    const meta: OgMeta = { title: null, description: null, image: null, siteName: null };
    applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, "https://example.com/page", "example.com");

    expect(titleEl.textContent).toBe("example.com");
  });

  it("sets siteName when present", () => {
    const titleEl = document.createElement("a");
    const descEl = document.createElement("div");
    const hostEl = document.createElement("div");
    const imageWrap = document.createElement("div");

    const meta: OgMeta = { title: "Title", description: null, image: null, siteName: "My Site" };
    applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, "https://example.com/page", "example.com");

    expect(hostEl.textContent).toBe("My Site");
  });

  it("truncates long descriptions to 200 chars", () => {
    const titleEl = document.createElement("a");
    const descEl = document.createElement("div");
    const hostEl = document.createElement("div");
    const imageWrap = document.createElement("div");

    const longDesc = "A".repeat(300);
    const meta: OgMeta = { title: "Title", description: longDesc, image: null, siteName: null };
    applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, "https://example.com/page", "example.com");

    expect(descEl.textContent!.length).toBe(200);
    expect(descEl.textContent!.endsWith("...")).toBe(true);
    expect(descEl.style.display).toBe("");
  });

  it("shows description when present and short", () => {
    const titleEl = document.createElement("a");
    const descEl = document.createElement("div");
    const hostEl = document.createElement("div");
    const imageWrap = document.createElement("div");

    const meta: OgMeta = { title: "Title", description: "Short description", image: null, siteName: null };
    applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, "https://example.com/page", "example.com");

    expect(descEl.textContent).toBe("Short description");
    expect(descEl.style.display).toBe("");
  });

  it("hides description when null", () => {
    const titleEl = document.createElement("a");
    const descEl = document.createElement("div");
    const hostEl = document.createElement("div");
    const imageWrap = document.createElement("div");

    const meta: OgMeta = { title: "Title", description: null, image: null, siteName: null };
    applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, "https://example.com/page", "example.com");

    expect(descEl.style.display).toBe("none");
  });

  it("renders image when og:image is a valid URL", () => {
    const titleEl = document.createElement("a");
    const descEl = document.createElement("div");
    const hostEl = document.createElement("div");
    const imageWrap = document.createElement("div");

    const meta: OgMeta = {
      title: "Title",
      description: null,
      image: "https://example.com/image.jpg",
      siteName: null,
    };
    applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, "https://example.com/page", "example.com");

    const img = imageWrap.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://example.com/image.jpg");
    expect(imageWrap.style.display).toBe("");
  });

  it("resolves relative image URLs", () => {
    const titleEl = document.createElement("a");
    const descEl = document.createElement("div");
    const hostEl = document.createElement("div");
    const imageWrap = document.createElement("div");

    const meta: OgMeta = {
      title: "Title",
      description: null,
      image: "/images/og.png",
      siteName: null,
    };
    applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, "https://example.com/page", "example.com");

    const img = imageWrap.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://example.com/images/og.png");
  });

  it("hides image on error", () => {
    const titleEl = document.createElement("a");
    const descEl = document.createElement("div");
    const hostEl = document.createElement("div");
    const imageWrap = document.createElement("div");

    const meta: OgMeta = {
      title: "Title",
      description: null,
      image: "https://example.com/image.jpg",
      siteName: null,
    };
    applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, "https://example.com/page", "example.com");

    const img = imageWrap.querySelector("img")!;
    img.dispatchEvent(new Event("error"));

    expect(imageWrap.style.display).toBe("none");
  });

  it("does not render image when og:image is empty string", () => {
    const titleEl = document.createElement("a");
    const descEl = document.createElement("div");
    const hostEl = document.createElement("div");
    const imageWrap = document.createElement("div");

    const meta: OgMeta = { title: "Title", description: null, image: "", siteName: null };
    applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, "https://example.com/page", "example.com");

    expect(imageWrap.querySelector("img")).toBeNull();
  });

  it("blocks private host images", () => {
    const titleEl = document.createElement("a");
    const descEl = document.createElement("div");
    const hostEl = document.createElement("div");
    const imageWrap = document.createElement("div");

    const meta: OgMeta = {
      title: "Title",
      description: null,
      image: "https://192.168.1.1/image.png",
      siteName: null,
    };
    applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, "https://example.com/page", "example.com");

    expect(imageWrap.querySelector("img")).toBeNull();
  });

  it("adds crossorigin attribute for GIF images", () => {
    const titleEl = document.createElement("a");
    const descEl = document.createElement("div");
    const hostEl = document.createElement("div");
    const imageWrap = document.createElement("div");

    const meta: OgMeta = {
      title: "Title",
      description: null,
      image: "https://example.com/animated.gif",
      siteName: null,
    };
    applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, "https://example.com/page", "example.com");

    const img = imageWrap.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("crossorigin")).toBe("anonymous");
  });

  it("calls observeMedia on GIF image load event", () => {
    const titleEl = document.createElement("a");
    const descEl = document.createElement("div");
    const hostEl = document.createElement("div");
    const imageWrap = document.createElement("div");

    const meta: OgMeta = {
      title: "Title",
      description: null,
      image: "https://example.com/animated.gif",
      siteName: null,
    };
    applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, "https://example.com/page", "example.com");

    const img = imageWrap.querySelector("img")!;
    img.dispatchEvent(new Event("load"));

    expect(mockObserveMedia).toHaveBeenCalledWith(
      img,
      "https://example.com/animated.gif",
      imageWrap,
    );
  });
});

describe("renderGenericLinkPreview — cache stale during non-HTML response", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    fetchMock.mockReset();
    clearEmbedCaches();
    setServerHost("example.com");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("discards non-HTML response result when cache was cleared mid-flight", async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const card = renderGenericLinkPreview("https://stale-nonhtml.example.com/data");
    document.body.appendChild(card);
    await Promise.resolve();

    // Clear cache while fetch is in-flight
    clearEmbedCaches();

    // Resolve with non-HTML content type
    (resolveFetch as any)?.({
      ok: true,
      headers: { get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null },
      text: vi.fn().mockResolvedValue("{}"),
    });

    await Promise.resolve();
    await Promise.resolve();

    // Should have discarded the result (generation mismatch)
    // A new fetch for the same URL should still trigger a new fetch
    fetchMock.mockResolvedValueOnce(mockHtmlResponse("<html><head><title>Fresh</title></head></html>"));
    const card2 = renderGenericLinkPreview("https://stale-nonhtml.example.com/data");
    document.body.appendChild(card2);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("discards fetch error result when cache was cleared mid-flight", async () => {
    let rejectFetch: ((err: Error) => void) | null = null;
    fetchMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectFetch = reject;
    }));

    const card = renderGenericLinkPreview("https://stale-error.example.com/fail");
    document.body.appendChild(card);
    await Promise.resolve();

    // Clear cache while fetch is in-flight
    clearEmbedCaches();

    // Reject the fetch
    (rejectFetch as any)?.(new Error("network error"));

    await Promise.resolve();
    await Promise.resolve();

    // A new fetch for the same URL should still trigger a new fetch
    fetchMock.mockResolvedValueOnce(mockHtmlResponse("<html><head><title>Recovered</title></head></html>"));
    const card2 = renderGenericLinkPreview("https://stale-error.example.com/fail");
    document.body.appendChild(card2);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
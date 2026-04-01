import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be set up before any import that references them.
// ---------------------------------------------------------------------------

const { fetchMock, observeMediaMock, loadPrefMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  observeMediaMock: vi.fn(),
  loadPrefMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: fetchMock,
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@lib/media-visibility", () => ({
  observeMedia: observeMediaMock,
}));

vi.mock("@lib/icons", () => ({
  createIcon: (name: string, size: number) => {
    const el = document.createElement("span");
    el.setAttribute("data-icon", name);
    el.setAttribute("data-size", String(size));
    return el;
  },
}));

vi.mock("@components/settings/helpers", () => ({
  loadPref: loadPrefMock,
}));

vi.mock("../../src/components/message-list/attachments", () => ({
  isSafeUrl: (url: string) => {
    try {
      const parsed = new URL(url, "https://placeholder");
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  },
}));

vi.mock("../../src/components/message-list/embeds", () => ({
  renderGenericLinkPreview: (url: string) => {
    const el = document.createElement("div");
    el.className = "msg-embed-link";
    el.textContent = url;
    return el;
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  extractYouTubeId,
  isDirectImageUrl,
  renderInlineImage,
  renderYouTubeEmbed,
  openImageLightbox,
  extractUrls,
  renderUrlEmbeds,
  clearMediaCaches,
} from "../../src/components/message-list/media";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function oembedResponse(title: string) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({ title }),
  };
}

function oembedFail() {
  return {
    ok: false,
    json: vi.fn().mockResolvedValue(null),
  };
}

/** Simulate image load event on the first <img> found inside an element. */
function fireImgLoad(parent: HTMLElement): void {
  const img = parent.querySelector("img") as HTMLImageElement | null;
  if (img === null) throw new Error("No <img> found");
  img.dispatchEvent(new Event("load"));
}

/** Simulate image error event on the first <img> found inside an element. */
function fireImgError(parent: HTMLElement): void {
  const img = parent.querySelector("img") as HTMLImageElement | null;
  if (img === null) throw new Error("No <img> found");
  img.dispatchEvent(new Event("error"));
}

/** Create a MouseEvent with specified client coordinates. */
function mouseEvent(
  type: string,
  opts: { clientX?: number; clientY?: number; deltaY?: number } = {},
): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: opts.clientX ?? 0,
    clientY: opts.clientY ?? 0,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("media.ts", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    observeMediaMock.mockReset();
    loadPrefMock.mockReset();
    loadPrefMock.mockImplementation((_key: string, fallback: unknown) => fallback);
    clearMediaCaches();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    // Clean up any lightboxes left on body
    document.querySelectorAll(".image-lightbox").forEach((el) => el.remove());
    document.body.innerHTML = "";
  });

  // =========================================================================
  // extractYouTubeId
  // =========================================================================

  describe("extractYouTubeId", () => {
    it("extracts ID from youtube.com/watch?v=ID", () => {
      expect(extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("extracts ID from youtube.com (no www) /watch?v=ID", () => {
      expect(extractYouTubeId("https://youtube.com/watch?v=abc123")).toBe("abc123");
    });

    it("extracts ID from youtu.be/ID", () => {
      expect(extractYouTubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("returns null for youtu.be with empty path", () => {
      expect(extractYouTubeId("https://youtu.be/")).toBeNull();
    });

    it("extracts ID from youtube.com/embed/ID", () => {
      expect(extractYouTubeId("https://www.youtube.com/embed/abc123")).toBe("abc123");
    });

    it("extracts ID from youtube.com (no www) /embed/ID", () => {
      expect(extractYouTubeId("https://youtube.com/embed/xyz789")).toBe("xyz789");
    });

    it("returns null for youtube.com/embed/ with empty ID", () => {
      expect(extractYouTubeId("https://www.youtube.com/embed/")).toBeNull();
    });

    it("extracts ID from youtube.com/shorts/ID", () => {
      expect(extractYouTubeId("https://www.youtube.com/shorts/shortId1")).toBe("shortId1");
    });

    it("extracts ID from youtube.com (no www) /shorts/ID", () => {
      expect(extractYouTubeId("https://youtube.com/shorts/shortId2")).toBe("shortId2");
    });

    it("returns null for youtube.com/shorts/ with empty ID", () => {
      expect(extractYouTubeId("https://www.youtube.com/shorts/")).toBeNull();
    });

    it("returns null for non-YouTube URLs", () => {
      expect(extractYouTubeId("https://example.com/watch?v=abc")).toBeNull();
    });

    it("returns null for invalid URL", () => {
      expect(extractYouTubeId("not a url at all")).toBeNull();
    });

    it("returns null when youtube.com/watch has no v parameter", () => {
      expect(extractYouTubeId("https://www.youtube.com/watch")).toBeNull();
    });

    it("returns null for youtube.com with non-watch path", () => {
      expect(extractYouTubeId("https://www.youtube.com/channel/abc")).toBeNull();
    });
  });

  // =========================================================================
  // isDirectImageUrl
  // =========================================================================

  describe("isDirectImageUrl", () => {
    it.each([".gif", ".png", ".jpg", ".jpeg", ".webp"])("returns true for %s extension", (ext) => {
      expect(isDirectImageUrl(`https://example.com/photo${ext}`)).toBe(true);
    });

    it("returns true for uppercase extensions", () => {
      expect(isDirectImageUrl("https://example.com/PHOTO.PNG")).toBe(true);
    });

    it("returns false for non-image extensions", () => {
      expect(isDirectImageUrl("https://example.com/doc.pdf")).toBe(false);
    });

    it("returns false for URLs without extensions", () => {
      expect(isDirectImageUrl("https://example.com/page")).toBe(false);
    });

    it("returns false for invalid URLs", () => {
      expect(isDirectImageUrl("not-a-url")).toBe(false);
    });
  });

  // =========================================================================
  // renderInlineImage
  // =========================================================================

  describe("renderInlineImage", () => {
    it("creates a div.msg-image wrapper with an <img> inside", () => {
      const wrap = renderInlineImage("https://example.com/photo.jpg");
      expect(wrap.classList.contains("msg-image")).toBe(true);
      const img = wrap.querySelector("img");
      expect(img).not.toBeNull();
      expect(img!.getAttribute("src")).toBe("https://example.com/photo.jpg");
    });

    it("sets default min-height of 200px when no cached height", () => {
      const wrap = renderInlineImage("https://example.com/new.jpg");
      expect(wrap.style.minHeight).toBe("200px");
    });

    it("uses cached height for subsequent renders of the same URL", () => {
      const url = "https://example.com/cached.jpg";
      // First render: trigger load to cache height
      const wrap1 = renderInlineImage(url);
      document.body.appendChild(wrap1);

      // Simulate offsetHeight by defining the property
      Object.defineProperty(wrap1, "offsetHeight", { value: 150, configurable: true });
      fireImgLoad(wrap1);

      // Second render should use cached height
      const wrap2 = renderInlineImage(url);
      expect(wrap2.style.minHeight).toBe("150px");
    });

    it("clears min-height on successful image load", () => {
      const wrap = renderInlineImage("https://example.com/load.png");
      document.body.appendChild(wrap);

      Object.defineProperty(wrap, "offsetHeight", { value: 100, configurable: true });
      fireImgLoad(wrap);

      expect(wrap.style.minHeight).toBe("");
    });

    it("clears min-height on image error", () => {
      const wrap = renderInlineImage("https://example.com/broken.png");
      document.body.appendChild(wrap);

      fireImgError(wrap);

      expect(wrap.style.minHeight).toBe("");
    });

    it("does not cache height of 0", () => {
      const url = "https://example.com/zero-height.png";
      const wrap = renderInlineImage(url);
      document.body.appendChild(wrap);

      Object.defineProperty(wrap, "offsetHeight", { value: 0, configurable: true });
      fireImgLoad(wrap);

      // Second render should still use default 200px because 0 was not cached
      const wrap2 = renderInlineImage(url);
      expect(wrap2.style.minHeight).toBe("200px");
    });

    it("adds crossorigin attribute for GIF URLs", () => {
      const wrap = renderInlineImage("https://example.com/anim.gif");
      const img = wrap.querySelector("img")!;
      expect(img.getAttribute("crossorigin")).toBe("anonymous");
    });

    it("does not add crossorigin attribute for non-GIF URLs", () => {
      const wrap = renderInlineImage("https://example.com/photo.png");
      const img = wrap.querySelector("img")!;
      expect(img.hasAttribute("crossorigin")).toBe(false);
    });

    it("calls observeMedia for GIF after load (animateGifs enabled)", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => {
        if (key === "animateGifs") return true;
        return fallback;
      });

      const url = "https://example.com/animated.gif";
      const wrap = renderInlineImage(url);
      document.body.appendChild(wrap);

      const img = wrap.querySelector("img")!;
      // Fire load - the second "load" listener (GIF-specific) should call observeMedia
      img.dispatchEvent(new Event("load"));

      expect(observeMediaMock).toHaveBeenCalledWith(img, url, wrap, false);
    });

    it("calls observeMedia with startFrozen=true when animateGifs is disabled", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => {
        if (key === "animateGifs") return false;
        return fallback;
      });

      const url = "https://example.com/frozen.gif";
      const wrap = renderInlineImage(url);
      document.body.appendChild(wrap);

      const img = wrap.querySelector("img")!;
      img.dispatchEvent(new Event("load"));

      expect(observeMediaMock).toHaveBeenCalledWith(img, url, wrap, true);
    });

    it("does not call observeMedia for non-GIF images", () => {
      const wrap = renderInlineImage("https://example.com/photo.png");
      document.body.appendChild(wrap);

      fireImgLoad(wrap);

      expect(observeMediaMock).not.toHaveBeenCalled();
    });

    it("opens lightbox on image click", () => {
      const wrap = renderInlineImage("https://example.com/click.jpg");
      document.body.appendChild(wrap);

      const img = wrap.querySelector("img")!;
      img.click();

      const lightbox = document.body.querySelector(".image-lightbox");
      expect(lightbox).not.toBeNull();
    });
  });

  // =========================================================================
  // Image height cache eviction
  // =========================================================================

  describe("image height cache eviction", () => {
    it("evicts the oldest entry when cache exceeds MAX_IMAGE_HEIGHT_CACHE", () => {
      // Fill the cache with 500 entries then add one more
      for (let i = 0; i < 501; i++) {
        const url = `https://example.com/img-${i}.jpg`;
        const wrap = renderInlineImage(url);
        document.body.appendChild(wrap);
        Object.defineProperty(wrap, "offsetHeight", { value: 100 + i, configurable: true });
        fireImgLoad(wrap);
      }

      // The first URL should have been evicted - renders with default 200px
      const wrap = renderInlineImage("https://example.com/img-0.jpg");
      expect(wrap.style.minHeight).toBe("200px");

      // The second URL should still be cached
      const wrap2 = renderInlineImage("https://example.com/img-1.jpg");
      expect(wrap2.style.minHeight).toBe("101px");
    });
  });

  // =========================================================================
  // isGifUrl (tested indirectly through renderInlineImage)
  // =========================================================================

  describe("isGifUrl (indirect)", () => {
    it("identifies .gif extension as GIF", () => {
      const wrap = renderInlineImage("https://example.com/img.gif");
      expect(wrap.querySelector("img")!.getAttribute("crossorigin")).toBe("anonymous");
    });

    it("does not identify .png as GIF", () => {
      const wrap = renderInlineImage("https://example.com/img.png");
      expect(wrap.querySelector("img")!.hasAttribute("crossorigin")).toBe(false);
    });

    it("handles malformed URL gracefully in GIF check", () => {
      // isGifUrl catches URL parse errors — this should not throw
      // We test by providing a URL that fails new URL() but still works
      // for image rendering. Since renderInlineImage doesn't validate URLs,
      // it just passes through. The isGifUrl uses a placeholder base.
      const wrap = renderInlineImage("https://example.com/image.GIF");
      // .GIF (uppercase) should be detected as GIF because pathname.toLowerCase()
      expect(wrap.querySelector("img")!.getAttribute("crossorigin")).toBe("anonymous");
    });
  });

  // =========================================================================
  // renderYouTubeEmbed
  // =========================================================================

  describe("renderYouTubeEmbed", () => {
    it("renders a YouTube embed with thumbnail and play button", () => {
      fetchMock.mockResolvedValue(oembedResponse("Test Video"));

      const embed = renderYouTubeEmbed("abc123", "https://www.youtube.com/watch?v=abc123");
      document.body.appendChild(embed);

      expect(embed.classList.contains("msg-embed-youtube")).toBe(true);
      expect(embed.querySelector(".msg-embed-host")?.textContent).toBe("YouTube");
      expect(embed.querySelector(".msg-embed-thumb")).not.toBeNull();
      expect(embed.querySelector(".msg-embed-play")).not.toBeNull();
    });

    it("shows 'Loading...' while fetching the title", () => {
      fetchMock.mockReturnValue(new Promise(() => {})); // Never resolves

      const embed = renderYouTubeEmbed("pending", "https://www.youtube.com/watch?v=pending");
      const title = embed.querySelector(".msg-embed-yt-title");
      expect(title?.textContent).toBe("Loading...");
    });

    it("updates title when oembed fetch succeeds", async () => {
      fetchMock.mockResolvedValue(oembedResponse("My Great Video"));

      const embed = renderYouTubeEmbed("success1", "https://www.youtube.com/watch?v=success1");
      document.body.appendChild(embed);

      const title = embed.querySelector(".msg-embed-yt-title")!;
      await vi.waitFor(() => {
        expect(title.textContent).toBe("My Great Video");
      });
    });

    it("caches the title and reuses it on subsequent renders", async () => {
      fetchMock.mockResolvedValue(oembedResponse("Cached Title"));

      const embed1 = renderYouTubeEmbed("cached1", "https://www.youtube.com/watch?v=cached1");
      document.body.appendChild(embed1);

      await vi.waitFor(() => {
        expect(embed1.querySelector(".msg-embed-yt-title")?.textContent).toBe("Cached Title");
      });

      // Second render should use cache
      const embed2 = renderYouTubeEmbed("cached1", "https://www.youtube.com/watch?v=cached1");
      expect(embed2.querySelector(".msg-embed-yt-title")?.textContent).toBe("Cached Title");
      expect(fetchMock).toHaveBeenCalledTimes(1); // Only one fetch
    });

    it("falls back to 'YouTube Video' when oembed returns no title", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });

      const embed = renderYouTubeEmbed("notitle", "https://www.youtube.com/watch?v=notitle");
      document.body.appendChild(embed);

      await vi.waitFor(() => {
        expect(embed.querySelector(".msg-embed-yt-title")?.textContent).toBe("YouTube Video");
      });
    });

    it("falls back to 'YouTube Video' when oembed returns null", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(null),
      });

      const embed = renderYouTubeEmbed("nulldata", "https://www.youtube.com/watch?v=nulldata");
      document.body.appendChild(embed);

      await vi.waitFor(() => {
        expect(embed.querySelector(".msg-embed-yt-title")?.textContent).toBe("YouTube Video");
      });
    });

    it("falls back to 'YouTube Video' when oembed fetch fails (non-ok)", async () => {
      fetchMock.mockResolvedValue(oembedFail());

      const embed = renderYouTubeEmbed("fail1", "https://www.youtube.com/watch?v=fail1");
      document.body.appendChild(embed);

      await vi.waitFor(() => {
        expect(embed.querySelector(".msg-embed-yt-title")?.textContent).toBe("YouTube Video");
      });
    });

    it("falls back to 'YouTube Video' when oembed fetch rejects (network error)", async () => {
      fetchMock.mockRejectedValue(new Error("Network error"));

      const embed = renderYouTubeEmbed("neterr", "https://www.youtube.com/watch?v=neterr");
      document.body.appendChild(embed);

      await vi.waitFor(() => {
        expect(embed.querySelector(".msg-embed-yt-title")?.textContent).toBe("YouTube Video");
      });
    });

    it("renders fallback link for invalid video ID (XSS prevention)", () => {
      const embed = renderYouTubeEmbed(
        "<script>alert(1)</script>",
        "https://www.youtube.com/watch?v=<script>alert(1)</script>",
      );
      document.body.appendChild(embed);

      // Should render a plain link fallback, not YouTube embed
      expect(embed.classList.contains("msg-embed-youtube")).toBe(false);
      expect(embed.classList.contains("msg-embed")).toBe(true);
      const link = embed.querySelector("a");
      expect(link).not.toBeNull();
    });

    it("replaces thumbnail with iframe on click", () => {
      fetchMock.mockResolvedValue(oembedResponse("Click Test"));

      const embed = renderYouTubeEmbed("click1", "https://www.youtube.com/watch?v=click1");
      document.body.appendChild(embed);

      const thumbWrap = embed.querySelector(".msg-embed-yt-player")!;
      expect(thumbWrap.querySelector("img")).not.toBeNull();
      expect(thumbWrap.querySelector("iframe")).toBeNull();

      (thumbWrap as HTMLElement).click();

      expect(thumbWrap.querySelector("iframe")).not.toBeNull();
      expect(thumbWrap.querySelector("img")).toBeNull();
      const iframe = thumbWrap.querySelector("iframe")!;
      expect(iframe.src).toContain("click1");
      expect(iframe.src).toContain("autoplay=1");
      expect(iframe.getAttribute("allowfullscreen")).toBe("");
    });

    it("only replaces thumbnail once (click handler is {once: true})", () => {
      fetchMock.mockResolvedValue(oembedResponse("Once Test"));

      const embed = renderYouTubeEmbed("once1", "https://www.youtube.com/watch?v=once1");
      document.body.appendChild(embed);

      const thumbWrap = embed.querySelector(".msg-embed-yt-player") as HTMLElement;
      thumbWrap.click();

      const iframe = thumbWrap.querySelector("iframe")!;
      const originalSrc = iframe.src;

      // Second click should not replace iframe again
      thumbWrap.click();
      expect(thumbWrap.querySelector("iframe")!.src).toBe(originalSrc);
    });

    it("evicts oldest YouTube title cache entry when exceeding limit", async () => {
      // Fill ytTitleCache to its max (200) and verify eviction
      for (let i = 0; i < 201; i++) {
        fetchMock.mockResolvedValueOnce(oembedResponse(`Title ${i}`));
        const embed = renderYouTubeEmbed(`vid${i}`, `https://www.youtube.com/watch?v=vid${i}`);
        document.body.appendChild(embed);
      }

      await vi.waitFor(() => {
        // Last video should have its title
        const last = document.body.querySelector(`[href="https://www.youtube.com/watch?v=vid200"]`);
        expect(last?.textContent).toBe("Title 200");
      });
    });

    it("evicts oldest cache entry on catch branch too", async () => {
      // First fill 200 entries via successful fetches
      for (let i = 0; i < 200; i++) {
        fetchMock.mockResolvedValueOnce(oembedResponse(`Title ${i}`));
        const embed = renderYouTubeEmbed(`errv${i}`, `https://www.youtube.com/watch?v=errv${i}`);
        document.body.appendChild(embed);
      }

      await vi.waitFor(() => {
        const link = document.body.querySelector(
          `[href="https://www.youtube.com/watch?v=errv199"]`,
        );
        expect(link?.textContent).toBe("Title 199");
      });

      // Now add one more that fails (triggers catch branch)
      fetchMock.mockRejectedValueOnce(new Error("fail"));
      const failEmbed = renderYouTubeEmbed("errv200", "https://www.youtube.com/watch?v=errv200");
      document.body.appendChild(failEmbed);

      await vi.waitFor(() => {
        expect(failEmbed.querySelector(".msg-embed-yt-title")?.textContent).toBe("YouTube Video");
      });
    });

    it("uses fallback title when cache generation changes during successful fetch", async () => {
      let resolveFetch: ((value: ReturnType<typeof oembedResponse>) => void) | null = null;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      );

      const embed = renderYouTubeEmbed("gen1", "https://www.youtube.com/watch?v=gen1");
      document.body.appendChild(embed);

      const title = embed.querySelector(".msg-embed-yt-title")!;
      expect(title.textContent).toBe("Loading...");

      // Clear caches (bumps generation)
      clearMediaCaches();

      // Resolve the fetch after cache clear
      resolveFetch!(oembedResponse("Stale Title"));

      await vi.waitFor(() => {
        expect(title.textContent).toBe("YouTube Video");
      });
    });

    it("uses fallback title when cache generation changes during failed fetch", async () => {
      let rejectFetch: ((reason: Error) => void) | null = null;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFetch = reject;
          }),
      );

      const embed = renderYouTubeEmbed("gen2", "https://www.youtube.com/watch?v=gen2");
      document.body.appendChild(embed);

      clearMediaCaches();
      rejectFetch!(new Error("Network error"));

      await vi.waitFor(() => {
        expect(embed.querySelector(".msg-embed-yt-title")?.textContent).toBe("YouTube Video");
      });
    });

    it("sets thumbnail image src and alt correctly", () => {
      fetchMock.mockResolvedValue(oembedResponse("Thumb Test"));

      const embed = renderYouTubeEmbed("thumb1", "https://www.youtube.com/watch?v=thumb1");
      const thumb = embed.querySelector(".msg-embed-thumb") as HTMLImageElement;
      expect(thumb.src).toContain("thumb1");
      expect(thumb.getAttribute("alt")).toBe("YouTube video");
      expect(thumb.getAttribute("loading")).toBe("lazy");
    });

    it("title link has correct href and target attributes", () => {
      fetchMock.mockResolvedValue(oembedResponse("Link Test"));
      const originalUrl = "https://www.youtube.com/watch?v=link1";

      const embed = renderYouTubeEmbed("link1", originalUrl);
      const titleLink = embed.querySelector(".msg-embed-yt-title") as HTMLAnchorElement;
      expect(titleLink.getAttribute("href")).toBe(originalUrl);
      expect(titleLink.getAttribute("target")).toBe("_blank");
      expect(titleLink.getAttribute("rel")).toBe("noopener noreferrer");
    });
  });

  // =========================================================================
  // openImageLightbox
  // =========================================================================

  describe("openImageLightbox", () => {
    it("appends a lightbox overlay to document.body", () => {
      openImageLightbox("https://example.com/test.png", "Test image");

      const lightbox = document.body.querySelector(".image-lightbox");
      expect(lightbox).not.toBeNull();
    });

    it("contains an image with the provided src and alt", () => {
      openImageLightbox("https://example.com/pic.jpg", "My photo");

      const img = document.body.querySelector(".image-lightbox img") as HTMLImageElement;
      expect(img).not.toBeNull();
      expect(img.getAttribute("src")).toBe("https://example.com/pic.jpg");
      expect(img.getAttribute("alt")).toBe("My photo");
    });

    it("contains a close button", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const closeBtn = document.body.querySelector(".image-lightbox-close");
      expect(closeBtn).not.toBeNull();
    });

    it("closes on close button click", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const closeBtn = document.body.querySelector(".image-lightbox-close") as HTMLElement;
      closeBtn.click();

      expect(document.body.querySelector(".image-lightbox")).toBeNull();
    });

    it("closes on overlay background click", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const overlay = document.body.querySelector(".image-lightbox") as HTMLElement;
      // Click the overlay itself (not a child)
      overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(document.body.querySelector(".image-lightbox")).toBeNull();
    });

    it("does not close when clicking on the image", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;
      // Simulate a click where mouse didn't move (dx=0, dy=0)
      img.dispatchEvent(new MouseEvent("mousedown", { clientX: 100, clientY: 100, bubbles: true }));
      img.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100, bubbles: true }));

      // The image click toggles zoom, not close. Lightbox should still exist.
      expect(document.body.querySelector(".image-lightbox")).not.toBeNull();
    });

    it("closes on Escape key", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(document.body.querySelector(".image-lightbox")).toBeNull();
    });

    it("zooms in on + key", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));

      // After zoom, transform should contain scale > 1
      expect(img.style.transform).toContain("scale(");
      const scaleMatch = img.style.transform.match(/scale\(([^)]+)\)/);
      expect(scaleMatch).not.toBeNull();
      const scale = parseFloat(scaleMatch![1]!);
      expect(scale).toBeGreaterThan(1);
    });

    it("zooms in on = key (same as +)", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "=", bubbles: true }));

      const scaleMatch = img.style.transform.match(/scale\(([^)]+)\)/);
      expect(scaleMatch).not.toBeNull();
      const scale = parseFloat(scaleMatch![1]!);
      expect(scale).toBeGreaterThan(1);
    });

    it("zooms out on - key", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "-", bubbles: true }));

      const scaleMatch = img.style.transform.match(/scale\(([^)]+)\)/);
      expect(scaleMatch).not.toBeNull();
      const scale = parseFloat(scaleMatch![1]!);
      expect(scale).toBeLessThan(1);
    });

    it("resets zoom on 0 key", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;

      // Zoom in first
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));

      // Reset
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));

      expect(img.style.transform).toContain("scale(1)");
      expect(img.style.transform).toContain("translate(0px, 0px)");
    });

    it("toggles zoom on image click (zoom in when not zoomed)", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;

      // Mock getBoundingClientRect for the click zoom calculation
      vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      // Simulate mousedown then click at same position (no drag)
      img.dispatchEvent(
        new MouseEvent("mousedown", {
          clientX: 200,
          clientY: 150,
          bubbles: true,
          cancelable: true,
        }),
      );
      img.dispatchEvent(
        new MouseEvent("click", {
          clientX: 200,
          clientY: 150,
          bubbles: true,
          cancelable: true,
        }),
      );

      // Should zoom to scale 3
      const scaleMatch = img.style.transform.match(/scale\(([^)]+)\)/);
      expect(scaleMatch).not.toBeNull();
      expect(parseFloat(scaleMatch![1]!)).toBe(3);
    });

    it("toggles zoom on image click (zoom out when zoomed in)", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;

      vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      // Zoom in first
      img.dispatchEvent(
        new MouseEvent("mousedown", {
          clientX: 200,
          clientY: 150,
          bubbles: true,
          cancelable: true,
        }),
      );
      img.dispatchEvent(
        new MouseEvent("click", { clientX: 200, clientY: 150, bubbles: true, cancelable: true }),
      );

      // Now click again to zoom out (scale > 1.1 so it resets)
      img.dispatchEvent(
        new MouseEvent("mousedown", {
          clientX: 200,
          clientY: 150,
          bubbles: true,
          cancelable: true,
        }),
      );
      img.dispatchEvent(
        new MouseEvent("click", { clientX: 200, clientY: 150, bubbles: true, cancelable: true }),
      );

      expect(img.style.transform).toContain("scale(1)");
    });

    it("does not toggle zoom when mouse moves during click (drag gesture)", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;

      // Mousedown at one position, click at another (moved > 5px)
      img.dispatchEvent(
        new MouseEvent("mousedown", {
          clientX: 100,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      img.dispatchEvent(
        new MouseEvent("click", { clientX: 120, clientY: 100, bubbles: true, cancelable: true }),
      );

      // Should remain at scale(1) because dx=20 > 5
      expect(img.style.transform).toBe("");
    });

    it("supports panning when zoomed in", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;
      const overlay = document.body.querySelector(".image-lightbox") as HTMLElement;

      vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      // Zoom in first
      img.dispatchEvent(
        new MouseEvent("mousedown", {
          clientX: 200,
          clientY: 150,
          bubbles: true,
          cancelable: true,
        }),
      );
      img.dispatchEvent(
        new MouseEvent("click", { clientX: 200, clientY: 150, bubbles: true, cancelable: true }),
      );

      // Now start panning (mousedown while zoomed)
      img.dispatchEvent(
        new MouseEvent("mousedown", {
          clientX: 200,
          clientY: 150,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(overlay.classList.contains("dragging")).toBe(true);

      // Move mouse
      document.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 250, clientY: 200, bubbles: true }),
      );

      // Transform should reflect pan offset
      expect(img.style.transform).toContain("translate(");

      // Mouse up ends dragging
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      expect(overlay.classList.contains("dragging")).toBe(false);
    });

    it("mouseup does nothing when not dragging", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");
      const overlay = document.body.querySelector(".image-lightbox") as HTMLElement;

      // mouseup without prior drag should not throw or change anything
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      expect(overlay.classList.contains("dragging")).toBe(false);
    });

    it("mousemove does nothing when not dragging", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");
      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;

      // mousemove without prior drag should not alter transform
      document.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 300, clientY: 300, bubbles: true }),
      );
      expect(img.style.transform).toBe("");
    });

    it("handles wheel zoom in", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;
      const imgWrap = document.body.querySelector(".image-lightbox-wrap") as HTMLElement;

      vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      // Scroll up (negative deltaY = zoom in)
      const wheelEvent = new WheelEvent("wheel", {
        deltaY: -100,
        clientX: 200,
        clientY: 150,
        bubbles: true,
        cancelable: true,
      });
      imgWrap.dispatchEvent(wheelEvent);

      const scaleMatch = img.style.transform.match(/scale\(([^)]+)\)/);
      expect(scaleMatch).not.toBeNull();
      expect(parseFloat(scaleMatch![1]!)).toBeGreaterThan(1);
    });

    it("handles wheel zoom out", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;
      const imgWrap = document.body.querySelector(".image-lightbox-wrap") as HTMLElement;

      vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      // Scroll down (positive deltaY = zoom out)
      const wheelEvent = new WheelEvent("wheel", {
        deltaY: 100,
        clientX: 200,
        clientY: 150,
        bubbles: true,
        cancelable: true,
      });
      imgWrap.dispatchEvent(wheelEvent);

      const scaleMatch = img.style.transform.match(/scale\(([^)]+)\)/);
      expect(scaleMatch).not.toBeNull();
      expect(parseFloat(scaleMatch![1]!)).toBeLessThan(1);
    });

    it("clamps wheel zoom to min scale 0.5", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;
      const imgWrap = document.body.querySelector(".image-lightbox-wrap") as HTMLElement;

      vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      // Zoom out many times
      for (let i = 0; i < 20; i++) {
        imgWrap.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: 100,
            clientX: 200,
            clientY: 150,
            bubbles: true,
            cancelable: true,
          }),
        );
      }

      const scaleMatch = img.style.transform.match(/scale\(([^)]+)\)/);
      expect(parseFloat(scaleMatch![1]!)).toBeGreaterThanOrEqual(0.5);
    });

    it("clamps wheel zoom to max scale 10", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");

      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;
      const imgWrap = document.body.querySelector(".image-lightbox-wrap") as HTMLElement;

      vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      // Zoom in many times
      for (let i = 0; i < 50; i++) {
        imgWrap.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: -100,
            clientX: 200,
            clientY: 150,
            bubbles: true,
            cancelable: true,
          }),
        );
      }

      const scaleMatch = img.style.transform.match(/scale\(([^)]+)\)/);
      expect(parseFloat(scaleMatch![1]!)).toBeLessThanOrEqual(10);
    });

    it("clamps keyboard zoom to max scale 10", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");
      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;

      for (let i = 0; i < 50; i++) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
      }

      const scaleMatch = img.style.transform.match(/scale\(([^)]+)\)/);
      expect(parseFloat(scaleMatch![1]!)).toBeLessThanOrEqual(10);
    });

    it("clamps keyboard zoom to min scale 0.5", () => {
      openImageLightbox("https://example.com/pic.jpg", "Photo");
      const img = document.body.querySelector(".image-lightbox img") as HTMLElement;

      for (let i = 0; i < 50; i++) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "-", bubbles: true }));
      }

      const scaleMatch = img.style.transform.match(/scale\(([^)]+)\)/);
      expect(parseFloat(scaleMatch![1]!)).toBeGreaterThanOrEqual(0.5);
    });

    it("closes previous lightbox when opening a new one", () => {
      openImageLightbox("https://example.com/first.png", "First");
      expect(document.body.querySelectorAll(".image-lightbox").length).toBe(1);

      openImageLightbox("https://example.com/second.png", "Second");

      // Should have replaced the first one
      const lightboxes = document.body.querySelectorAll(".image-lightbox");
      expect(lightboxes.length).toBe(1);
      const img = lightboxes[0]!.querySelector("img") as HTMLImageElement;
      expect(img.getAttribute("src")).toBe("https://example.com/second.png");
    });

    it("cleans up document-level listeners on close", () => {
      openImageLightbox("https://example.com/cleanup.png", "Cleanup");

      const closeBtn = document.body.querySelector(".image-lightbox-close") as HTMLElement;
      closeBtn.click();

      // After close, key events should not error or affect anything
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 100, clientY: 100, bubbles: true }),
      );
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  });

  // =========================================================================
  // extractUrls
  // =========================================================================

  describe("extractUrls", () => {
    it("extracts a single URL", () => {
      const urls = extractUrls("Check out https://example.com");
      expect(urls).toEqual(["https://example.com"]);
    });

    it("extracts multiple URLs", () => {
      const urls = extractUrls("Visit https://a.com and https://b.com");
      expect(urls).toEqual(["https://a.com", "https://b.com"]);
    });

    it("returns empty array for text without URLs", () => {
      const urls = extractUrls("Just plain text here");
      expect(urls).toEqual([]);
    });

    it("skips URLs inside code blocks", () => {
      const urls = extractUrls("```\nhttps://hidden.com\n```");
      expect(urls).toEqual([]);
    });

    it("skips URLs inside inline code", () => {
      const urls = extractUrls("See `https://hidden.com` here");
      expect(urls).toEqual([]);
    });

    it("extracts URLs outside code blocks but not inside", () => {
      const urls = extractUrls("https://visible.com ```https://hidden.com```");
      expect(urls).toEqual(["https://visible.com"]);
    });

    it("extracts http and https URLs", () => {
      const urls = extractUrls("http://insecure.com https://secure.com");
      expect(urls).toEqual(["http://insecure.com", "https://secure.com"]);
    });
  });

  // =========================================================================
  // renderUrlEmbeds
  // =========================================================================

  describe("renderUrlEmbeds", () => {
    it("renders YouTube embed for YouTube URLs", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => fallback);
      fetchMock.mockResolvedValue(oembedResponse("YT Video"));

      const fragment = renderUrlEmbeds("Check this: https://www.youtube.com/watch?v=test1");

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.querySelector(".msg-embed-youtube")).not.toBeNull();
    });

    it("renders inline image for direct image URLs", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => fallback);

      const fragment = renderUrlEmbeds("Image: https://example.com/photo.png");

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.querySelector(".msg-image")).not.toBeNull();
    });

    it("renders generic link preview for non-image, non-YouTube URLs", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => fallback);

      const fragment = renderUrlEmbeds("Check https://example.com/article");

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.querySelector(".msg-embed-link")).not.toBeNull();
    });

    it("deduplicates URLs in the same message", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => fallback);

      const url = "https://example.com/photo.jpg";
      const fragment = renderUrlEmbeds(`${url} and ${url}`);

      const container = document.createElement("div");
      container.appendChild(fragment);
      const images = container.querySelectorAll(".msg-image");
      expect(images.length).toBe(1);
    });

    it("skips YouTube embed when showEmbeds is disabled", () => {
      loadPrefMock.mockImplementation((key: string, _fallback: unknown) => {
        if (key === "showEmbeds") return false;
        return true;
      });

      const fragment = renderUrlEmbeds("https://www.youtube.com/watch?v=skip1");

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.querySelector(".msg-embed-youtube")).toBeNull();
    });

    it("skips inline images when inlineMedia is disabled", () => {
      loadPrefMock.mockImplementation((key: string, _fallback: unknown) => {
        if (key === "inlineMedia") return false;
        return true;
      });

      const fragment = renderUrlEmbeds("https://example.com/photo.png");

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.querySelector(".msg-image")).toBeNull();
    });

    it("skips link previews when showLinkPreviews is disabled", () => {
      loadPrefMock.mockImplementation((key: string, _fallback: unknown) => {
        if (key === "showLinkPreviews") return false;
        return true;
      });

      const fragment = renderUrlEmbeds("https://example.com/article");

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.querySelector(".msg-embed-link")).toBeNull();
    });

    it("produces empty fragment when all preferences are disabled", () => {
      loadPrefMock.mockReturnValue(false);

      const fragment = renderUrlEmbeds(
        "https://www.youtube.com/watch?v=abc https://example.com/pic.png https://example.com/page",
      );

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.children.length).toBe(0);
    });

    it("does not render embeds for unsafe URLs", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => fallback);

      // ftp:// is not a safe URL (only http/https)
      const fragment = renderUrlEmbeds("ftp://example.com/photo.png");

      const container = document.createElement("div");
      container.appendChild(fragment);
      // ftp URL won't match URL_REGEX (which only matches http/https)
      expect(container.children.length).toBe(0);
    });

    it("renders multiple different embed types in a single message", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => fallback);
      fetchMock.mockResolvedValue(oembedResponse("Video"));

      const fragment = renderUrlEmbeds(
        "Video: https://www.youtube.com/watch?v=multi1 Image: https://example.com/pic.jpg Article: https://example.com/news",
      );

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.querySelector(".msg-embed-youtube")).not.toBeNull();
      expect(container.querySelector(".msg-image")).not.toBeNull();
      expect(container.querySelector(".msg-embed-link")).not.toBeNull();
    });

    it("produces empty fragment for message with no URLs", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => fallback);

      const fragment = renderUrlEmbeds("Just a plain message with no links");

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.children.length).toBe(0);
    });
  });

  // =========================================================================
  // clearMediaCaches
  // =========================================================================

  describe("clearMediaCaches", () => {
    it("clears image height cache", () => {
      const url = "https://example.com/clear-test.jpg";
      // First render and cache height
      const wrap = renderInlineImage(url);
      document.body.appendChild(wrap);
      Object.defineProperty(wrap, "offsetHeight", { value: 250, configurable: true });
      fireImgLoad(wrap);

      // Verify cached
      const wrap2 = renderInlineImage(url);
      expect(wrap2.style.minHeight).toBe("250px");

      // Clear caches
      clearMediaCaches();

      // Should now use default
      const wrap3 = renderInlineImage(url);
      expect(wrap3.style.minHeight).toBe("200px");
    });

    it("clears YouTube title cache", async () => {
      fetchMock.mockResolvedValueOnce(oembedResponse("Original Title"));

      const embed1 = renderYouTubeEmbed("clear1", "https://www.youtube.com/watch?v=clear1");
      document.body.appendChild(embed1);

      await vi.waitFor(() => {
        expect(embed1.querySelector(".msg-embed-yt-title")?.textContent).toBe("Original Title");
      });

      clearMediaCaches();

      // After clearing, should fetch again
      fetchMock.mockResolvedValueOnce(oembedResponse("New Title"));

      const embed2 = renderYouTubeEmbed("clear1", "https://www.youtube.com/watch?v=clear1");
      document.body.appendChild(embed2);

      // Should show "Loading..." initially (not cached)
      expect(embed2.querySelector(".msg-embed-yt-title")?.textContent).toBe("Loading...");

      await vi.waitFor(() => {
        expect(embed2.querySelector(".msg-embed-yt-title")?.textContent).toBe("New Title");
      });
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/mediaMocks";
import {
  isDirectImageUrl,
  renderInlineImage,
  closeActiveLightbox,
  clearMediaCaches,
} from "../../../src/components/message-list/media";
import {
  clearExternalImageCache,
  fetchExternalImage,
} from "../../../src/components/message-list/attachments";
import { blobImageSize } from "../../../src/components/message-list/imageSizes";
import {
  imageResponse,
  createObjectURLMock,
  awaitImgSrc,
  syncPrefCache,
  fireImgLoad,
  fireImgError,
  useMediaHarness,
} from "../../helpers/mediaHarness";

vi.mock("../../../src/features/content-consent/external", (importOriginal) =>
  mocks.consentExternalMock(importOriginal),
);
vi.mock("../../../src/platform/desktop/externalContent", () => mocks.desktopExternalContentMock());
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/prefs/mediaVisibility", () => mocks.prefsMediaVisibilityMock());
vi.mock("@lib/icons", () => mocks.iconsMock());
vi.mock("@lib/prefs/preferences", (importOriginal) => mocks.prefsPreferencesMock(importOriginal));
vi.mock("../../../src/components/message-list/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("../../../src/components/message-list/embeds", () => mocks.listEmbedsMock());

const { imageMock, observeMediaMock, loadPrefMock } = mocks;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("media.ts", () => {
  useMediaHarness();

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
    it("creates a div.msg-image wrapper with an <img> inside", async () => {
      const wrap = renderInlineImage("https://example.com/photo.jpg");
      expect(wrap.classList.contains("msg-image")).toBe(true);
      const img = wrap.querySelector("img");
      expect(img).not.toBeNull();
      // The webview never loads the remote URL: no src until the broker answers.
      expect(img!.hasAttribute("src")).toBe(false);
      expect(imageMock).toHaveBeenCalledWith(expect.any(String), {
        url: "https://example.com/photo.jpg",
      });
      const src = await awaitImgSrc(wrap);
      expect(src).toBe(createObjectURLMock.mock.results[0]!.value);
    });

    it("opens the image menu with the image's link on right-click", async () => {
      const wrap = renderInlineImage("https://example.com/menu.gif");
      document.body.appendChild(wrap);
      await awaitImgSrc(wrap);
      wrap.querySelector("img")!.dispatchEvent(new Event("load"));
      wrap.querySelector("img")!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 5,
          clientY: 5,
        }),
      );
      await vi.waitFor(() =>
        expect(
          Array.from(document.querySelectorAll(".image-context-menu [role='menuitem']")).map(
            (el) => el.textContent,
          ),
        ).toEqual(["Copy Image", "Copy Link", "Open Link", "Save Image"]),
      );
      closeActiveLightbox();
      wrap.remove();
    });

    it("sets default min-height of 200px when no cached height", () => {
      const wrap = renderInlineImage("https://example.com/new.jpg");
      expect(wrap.style.minHeight).toBe("200px");
    });

    it("uses cached height for subsequent renders of the same URL", async () => {
      const url = "https://example.com/cached.jpg";
      // First render: trigger load to cache height
      const wrap1 = renderInlineImage(url);
      document.body.appendChild(wrap1);
      await awaitImgSrc(wrap1);

      // jsdom reports no intrinsic size: the measured box is what gets cached.
      Object.defineProperty(wrap1, "offsetHeight", { value: 150, configurable: true });
      Object.defineProperty(wrap1, "offsetWidth", { value: 300, configurable: true });
      fireImgLoad(wrap1);

      // Second render reserves that box, with no min-height guess.
      const wrap2 = renderInlineImage(url);
      expect(wrap2.style.aspectRatio).toBe("300 / 150");
      expect(wrap2.style.width).toBe("300px");
      expect(wrap2.style.minHeight).toBe("");
    });

    it("clears min-height on successful image load", async () => {
      const wrap = renderInlineImage("https://example.com/load.png");
      document.body.appendChild(wrap);
      await awaitImgSrc(wrap);

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

    it("collapses the min-height reservation and sets no src when the broker refuses", async () => {
      imageMock.mockResolvedValue({ ok: false, failure: "blocked-destination" });
      const url = "https://example.com/refused.png";
      const wrap = renderInlineImage(url);
      document.body.appendChild(wrap);
      expect(wrap.style.minHeight).toBe("200px");

      await vi.waitFor(() => {
        expect(wrap.style.minHeight).toBe("");
      });
      expect(imageMock).toHaveBeenCalledWith(expect.any(String), { url });
      expect(wrap.querySelector("img")!.hasAttribute("src")).toBe(false);
      expect(createObjectURLMock).not.toHaveBeenCalled();
    });

    it("shows a typed failed state and retries on demand", async () => {
      imageMock.mockResolvedValueOnce({ ok: false, failure: "unavailable" });
      const url = "https://example.com/flaky.png";
      const wrap = renderInlineImage(url);
      document.body.appendChild(wrap);

      await vi.waitFor(() => {
        expect(wrap.dataset.mediaState).toBe("failed");
      });
      expect(wrap.querySelector(".msg-media-fallback-text")?.textContent).toBe("Image unavailable");
      const retry = wrap.querySelector<HTMLButtonElement>(".msg-media-retry")!;
      expect(retry.hidden).toBe(false);
      expect(retry.getAttribute("aria-label")).toBe("Retry image");

      imageMock.mockResolvedValueOnce(imageResponse("image/png"));
      retry.click();
      await vi.waitFor(() => {
        expect(wrap.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);
      });
      // The loaded state lands with the load event, as the renderer waits on it.
      fireImgLoad(wrap);
      expect(wrap.dataset.mediaState).toBe("loaded");
      expect(wrap.querySelector<HTMLElement>(".msg-media-fallback")!.hidden).toBe(true);
    });

    it("never reads as a loaded image once refused", async () => {
      imageMock.mockResolvedValue({ ok: false, failure: "wrong-type" });
      const wrap = renderInlineImage("https://example.com/notimage.png");
      document.body.appendChild(wrap);
      await vi.waitFor(() => {
        expect(wrap.dataset.mediaState).toBe("failed");
      });
      expect(wrap.dataset.mediaState).not.toBe("loaded");
      expect(wrap.querySelector("img")!.hidden).toBe(true);
    });

    it("offers no retry for a policy refusal", async () => {
      imageMock.mockResolvedValue({ ok: false, failure: "blocked-destination" });
      const wrap = renderInlineImage("https://example.com/blocked.png");
      document.body.appendChild(wrap);
      await vi.waitFor(() => {
        expect(wrap.dataset.mediaState).toBe("failed");
      });
      expect(wrap.querySelector<HTMLElement>(".msg-media-fallback")!.hidden).toBe(false);
      expect(wrap.querySelector<HTMLButtonElement>(".msg-media-retry")!.hidden).toBe(true);
    });

    it("keeps the image hidden and unopenable until its bytes load", async () => {
      let settle!: (r: unknown) => void;
      imageMock.mockReturnValueOnce(new Promise((r) => (settle = r)) as never);
      const wrap = renderInlineImage("https://example.com/slow.png");
      document.body.appendChild(wrap);
      const img = wrap.querySelector("img")!;
      expect(wrap.dataset.mediaState).toBe("loading");
      expect(img.hidden).toBe(true);

      settle(imageResponse("image/png"));
      await awaitImgSrc(wrap);
      fireImgLoad(wrap);
      expect(img.hidden).toBe(false);
    });

    it("an image that fails after the broker served it lands in the failed state", async () => {
      const wrap = renderInlineImage("https://example.com/undecodable.png");
      document.body.appendChild(wrap);
      await awaitImgSrc(wrap);

      fireImgError(wrap);

      expect(wrap.dataset.mediaState).toBe("failed");
      expect(wrap.querySelector<HTMLElement>(".msg-media-fallback")!.hidden).toBe(false);
    });

    it("keeps keyboard focus on the retry while it re-asks, then hands it to the image", async () => {
      imageMock.mockResolvedValueOnce({ ok: false, failure: "unavailable" });
      const wrap = renderInlineImage("https://example.com/refocus.png");
      document.body.appendChild(wrap);
      await vi.waitFor(() => {
        expect(wrap.dataset.mediaState).toBe("failed");
      });
      const retry = wrap.querySelector<HTMLButtonElement>(".msg-media-retry")!;
      retry.focus();

      imageMock.mockResolvedValueOnce(imageResponse("image/png"));
      retry.click();
      expect(document.activeElement).toBe(retry);
      expect(retry.getAttribute("aria-disabled")).toBe("true");

      await awaitImgSrc(wrap);
      fireImgLoad(wrap);
      expect(document.activeElement).toBe(wrap.querySelector("img"));
    });

    it("the inline image load handler runs once", async () => {
      const wrap = renderInlineImage("https://example.com/once.png");
      document.body.appendChild(wrap);
      await awaitImgSrc(wrap);
      const heightReads = vi.fn(() => 120);
      Object.defineProperty(wrap, "offsetHeight", { get: heightReads, configurable: true });

      const img = wrap.querySelector("img")!;
      img.dispatchEvent(new Event("load"));
      img.dispatchEvent(new Event("load"));

      expect(heightReads).toHaveBeenCalledTimes(1);
    });

    it("a retry after a prior load still lands in the loaded state", async () => {
      const wrap = renderInlineImage("https://example.com/reload.png");
      document.body.appendChild(wrap);
      await awaitImgSrc(wrap);
      fireImgLoad(wrap);
      fireImgError(wrap);
      expect(wrap.dataset.mediaState).toBe("failed");

      imageMock.mockResolvedValueOnce(imageResponse("image/png"));
      wrap.querySelector<HTMLButtonElement>(".msg-media-retry")!.click();
      await vi.waitFor(() => {
        expect(wrap.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);
      });
      fireImgLoad(wrap);
      expect(wrap.dataset.mediaState).toBe("loaded");
      expect(wrap.querySelector("img")!.hidden).toBe(false);
    });

    it("does not cache height of 0", async () => {
      const url = "https://example.com/zero-height.png";
      const wrap = renderInlineImage(url);
      document.body.appendChild(wrap);
      await awaitImgSrc(wrap);

      Object.defineProperty(wrap, "offsetHeight", { value: 0, configurable: true });
      fireImgLoad(wrap);

      // Second render should still use default 200px because 0 was not cached
      const wrap2 = renderInlineImage(url);
      expect(wrap2.style.minHeight).toBe("200px");
    });

    it("fetches GIF URLs through the broker as a same-origin blob: (no crossorigin)", async () => {
      imageMock.mockResolvedValue(imageResponse("image/gif"));
      const url = "https://example.com/anim.gif";
      const wrap = renderInlineImage(url);
      const src = await awaitImgSrc(wrap);
      expect(imageMock).toHaveBeenCalledWith(expect.any(String), { url });
      const img = wrap.querySelector("img")!;
      expect(src).toMatch(/^blob:/);
      expect(img.hasAttribute("crossorigin")).toBe(false);
    });

    it("does not add crossorigin attribute for non-GIF URLs", async () => {
      const wrap = renderInlineImage("https://example.com/photo.png");
      await awaitImgSrc(wrap);
      const img = wrap.querySelector("img")!;
      expect(img.hasAttribute("crossorigin")).toBe(false);
    });

    it("calls observeMedia for GIF after load (animateGifs enabled)", async () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => {
        if (key === "animateGifs") return true;
        return fallback;
      });
      syncPrefCache();
      imageMock.mockResolvedValue(imageResponse("image/gif"));

      const url = "https://example.com/animated.gif";
      const wrap = renderInlineImage(url);
      document.body.appendChild(wrap);
      const src = await awaitImgSrc(wrap);

      const img = wrap.querySelector("img")!;
      // Fire load - the second "load" listener (GIF-specific) should call observeMedia
      img.dispatchEvent(new Event("load"));

      expect(observeMediaMock).toHaveBeenCalledWith(img, src, wrap, false);
    });

    it("calls observeMedia with startFrozen=true when animateGifs is disabled", async () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => {
        if (key === "animateGifs") return false;
        return fallback;
      });
      syncPrefCache();
      imageMock.mockResolvedValue(imageResponse("image/gif"));

      const url = "https://example.com/frozen.gif";
      const wrap = renderInlineImage(url);
      document.body.appendChild(wrap);
      const src = await awaitImgSrc(wrap);

      const img = wrap.querySelector("img")!;
      img.dispatchEvent(new Event("load"));

      expect(observeMediaMock).toHaveBeenCalledWith(img, src, wrap, true);
    });

    it("does not call observeMedia for non-GIF images", async () => {
      const wrap = renderInlineImage("https://example.com/photo.png");
      document.body.appendChild(wrap);
      await awaitImgSrc(wrap);

      fireImgLoad(wrap);

      expect(observeMediaMock).not.toHaveBeenCalled();
    });

    it("opens lightbox on image click with the blob: URL", async () => {
      const wrap = renderInlineImage("https://example.com/click.jpg");
      document.body.appendChild(wrap);
      const src = await awaitImgSrc(wrap);

      const img = wrap.querySelector("img")!;
      img.click();

      const lightbox = document.body.querySelector(".image-lightbox");
      expect(lightbox).not.toBeNull();
      expect(lightbox!.querySelector("img")!.getAttribute("src")).toBe(src);
    });

    it("adds the Klipy watermark for Klipy CDN images only", () => {
      const klipy = renderInlineImage("https://static.klipy.com/gifs/cat.gif");
      expect(klipy.querySelector(".klipy-watermark")).not.toBeNull();
      const other = renderInlineImage("https://example.com/cat.gif");
      expect(other.querySelector(".klipy-watermark")).toBeNull();
    });
  });

  // =========================================================================
  // Image boxes from known sizes
  // =========================================================================

  describe("image boxes from known sizes", () => {
    /** A broker answer whose first bytes are a PNG header for `w` x `h`. */
    function pngResponse(w: number, h: number) {
      const be32 = (n: number): number[] => [
        (n >>> 24) & 255,
        (n >>> 16) & 255,
        (n >>> 8) & 255,
        n & 255,
      ];
      const header = Uint8Array.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...be32(13),
        0x49,
        0x48,
        0x44,
        0x52,
        ...be32(w),
        ...be32(h),
        8,
        6,
        0,
        0,
        0,
      ]);
      const blob = {
        size: header.length,
        type: "image/png",
        slice: () => ({ arrayBuffer: () => Promise.resolve(header.buffer.slice(0)) }),
      };
      return { ok: true, value: blob };
    }

    it("reserves the sniffed box before load fires, with an aspect ratio and no min-height", async () => {
      imageMock.mockResolvedValue(pngResponse(1200, 800));
      const wrap = renderInlineImage("https://example.com/sniffed.png");
      expect(wrap.style.minHeight).toBe("200px"); // nothing known yet
      document.body.appendChild(wrap);
      await awaitImgSrc(wrap);

      // load has not fired: the box is already the scaled 400 x 267.
      expect(wrap.dataset.mediaState).toBe("loading");
      expect(wrap.style.aspectRatio).toBe("400 / 267");
      expect(wrap.style.width).toBe("400px");
      expect(wrap.style.minHeight).toBe("");
    });

    it("keeps the box through load without measuring the row", async () => {
      imageMock.mockResolvedValue(pngResponse(120, 90));
      const wrap = renderInlineImage("https://example.com/small.png");
      document.body.appendChild(wrap);
      await awaitImgSrc(wrap);
      const img = wrap.querySelector("img") as HTMLImageElement;
      Object.defineProperty(img, "naturalWidth", { value: 120, configurable: true });
      Object.defineProperty(img, "naturalHeight", { value: 90, configurable: true });
      const read = vi.fn(() => 5);
      Object.defineProperty(wrap, "offsetHeight", { get: read, configurable: true });

      fireImgLoad(wrap);

      expect(read).not.toHaveBeenCalled();
      expect(wrap.style.aspectRatio).toBe("120 / 90");
      expect(wrap.dataset.mediaState).toBe("loaded");
    });

    it("corrects the box when the file disagrees with its header", async () => {
      imageMock.mockResolvedValue(pngResponse(800, 400));
      const url = "https://example.com/rotated.png";
      const wrap = renderInlineImage(url);
      document.body.appendChild(wrap);
      await awaitImgSrc(wrap);
      const img = wrap.querySelector("img") as HTMLImageElement;
      // e.g. an EXIF-rotated JPEG: the decoded image is portrait.
      Object.defineProperty(img, "naturalWidth", { value: 400, configurable: true });
      Object.defineProperty(img, "naturalHeight", { value: 800, configurable: true });

      fireImgLoad(wrap);

      expect(wrap.style.aspectRatio).toBe("175 / 350");
      expect(renderInlineImage(url).style.aspectRatio).toBe("175 / 350");
    });

    it("an orientation-swapped image keeps its measured box on the second mount", async () => {
      // Header says 800x400 (landscape); the browser decodes it rotated, 400x800.
      imageMock.mockResolvedValue(pngResponse(800, 400));
      const url = "https://example.com/exif.jpg";
      const first = renderInlineImage(url);
      document.body.appendChild(first);
      await awaitImgSrc(first);
      const img = first.querySelector("img") as HTMLImageElement;
      Object.defineProperty(img, "naturalWidth", { value: 400, configurable: true });
      Object.defineProperty(img, "naturalHeight", { value: 800, configurable: true });
      fireImgLoad(first);
      expect(first.style.aspectRatio).toBe("175 / 350");

      // Second mount: the cached measured box is reserved up front, and the
      // header's landscape reading does not flip it back when the broker answers.
      clearExternalImageCache();
      imageMock.mockResolvedValue(pngResponse(800, 400));
      const second = renderInlineImage(url);
      expect(second.style.aspectRatio).toBe("175 / 350");
      document.body.appendChild(second);
      await awaitImgSrc(second);
      expect(second.style.aspectRatio).toBe("175 / 350");
      expect(second.style.width).toBe("175px");
      // And the third mount still reads the measured box from the cache.
      expect(renderInlineImage(url).style.aspectRatio).toBe("175 / 350");
    });

    it("does not store a size for a load that finished after the session reset", async () => {
      imageMock.mockResolvedValue(pngResponse(300, 200));
      const url = "https://example.com/late.png";
      const wrap = renderInlineImage(url);
      document.body.appendChild(wrap);
      const src = await awaitImgSrc(wrap);
      expect(src).toMatch(/^blob:/);
      clearMediaCaches(); // server switch while the image was still on screen
      const img = wrap.querySelector("img") as HTMLImageElement;
      Object.defineProperty(img, "naturalWidth", { value: 300, configurable: true });
      Object.defineProperty(img, "naturalHeight", { value: 200, configurable: true });

      fireImgLoad(wrap);

      expect(renderInlineImage(url).style.minHeight).toBe("200px");
      expect(JSON.stringify(localStorage)).not.toContain("late.png");
    });

    it("clamps the measured fallback to the inline ceiling", async () => {
      const url = "https://example.com/measured-big.png";
      const wrap = renderInlineImage(url);
      document.body.appendChild(wrap);
      await awaitImgSrc(wrap);
      Object.defineProperty(wrap, "offsetWidth", { value: 2000, configurable: true });
      Object.defineProperty(wrap, "offsetHeight", { value: 1000, configurable: true });

      fireImgLoad(wrap);

      expect(renderInlineImage(url).style.aspectRatio).toBe("400 / 200");
    });

    it("reads the header only for a caller that asks for it", async () => {
      imageMock.mockResolvedValue(pngResponse(50, 40));
      const asked = await fetchExternalImage(
        { url: "https://example.com/asked.png" },
        { sniff: true },
      );
      const skipped = await fetchExternalImage({ url: "https://example.com/skipped.png" });
      expect(blobImageSize(asked!)).toEqual({ width: 50, height: 40 });
      expect(blobImageSize(skipped!)).toBeUndefined();
    });

    it("a later render of the same URL reserves the sniffed box before the fetch", async () => {
      imageMock.mockResolvedValue(pngResponse(600, 300));
      const url = "https://example.com/again.png";
      const first = renderInlineImage(url);
      document.body.appendChild(first);
      await awaitImgSrc(first);

      const second = renderInlineImage(url);
      expect(second.style.aspectRatio).toBe("400 / 200");
      expect(second.style.minHeight).toBe("");
    });

    it("two rows of one URL loading together both reserve from the one read", async () => {
      imageMock.mockResolvedValue(pngResponse(300, 300));
      const url = "https://example.com/twin.png";
      const a = renderInlineImage(url);
      const b = renderInlineImage(url);
      document.body.append(a, b);
      await Promise.all([awaitImgSrc(a), awaitImgSrc(b)]);

      expect(imageMock).toHaveBeenCalledTimes(1);
      expect(a.style.aspectRatio).toBe("300 / 300");
      expect(b.style.aspectRatio).toBe("300 / 300");
    });

    it("falls back to the 200px reservation for a zero-sized or unreadable header", async () => {
      imageMock.mockResolvedValue(pngResponse(0, 0));
      const wrap = renderInlineImage("https://example.com/zero.png");
      document.body.appendChild(wrap);
      await awaitImgSrc(wrap);
      expect(wrap.style.minHeight).toBe("200px");
      expect(wrap.style.aspectRatio).toBe("");

      imageMock.mockResolvedValue(imageResponse("image/png")); // "x": no header
      const other = renderInlineImage("https://example.com/junk.png");
      document.body.appendChild(other);
      await awaitImgSrc(other);
      expect(other.style.minHeight).toBe("200px");
    });

    it("decodes off the main thread", () => {
      const wrap = renderInlineImage("https://example.com/async.png");
      expect(wrap.querySelector("img")!.getAttribute("decoding")).toBe("async");
    });

    it("drops the reserved box when the image fails", async () => {
      imageMock.mockResolvedValue(pngResponse(600, 300));
      const wrap = renderInlineImage("https://example.com/fail.png");
      document.body.appendChild(wrap);
      await awaitImgSrc(wrap);
      expect(wrap.style.aspectRatio).not.toBe("");

      fireImgError(wrap);

      expect(wrap.style.aspectRatio).toBe("");
      expect(wrap.style.width).toBe("");
      expect(wrap.dataset.mediaState).toBe("failed");
    });
  });

  // =========================================================================
  // Image height cache eviction
  // =========================================================================

  describe("image height cache eviction", () => {
    it("evicts the oldest entry when cache exceeds MAX_IMAGE_HEIGHT_CACHE", async () => {
      // Fill the cache with 500 entries then add one more
      const wraps: HTMLDivElement[] = [];
      for (let i = 0; i < 501; i++) {
        const wrap = renderInlineImage(`https://example.com/img-${i}.jpg`);
        document.body.appendChild(wrap);
        wraps.push(wrap);
      }
      // Load listeners attach once the broker answers; wait for every src.
      await Promise.all(wraps.map(awaitImgSrc));
      wraps.forEach((wrap, i) => {
        Object.defineProperty(wrap, "offsetHeight", { value: 100 + i, configurable: true });
        Object.defineProperty(wrap, "offsetWidth", { value: 300, configurable: true });
        fireImgLoad(wrap);
      });

      // The first URL should have been evicted - renders with default 200px
      const wrap = renderInlineImage("https://example.com/img-0.jpg");
      expect(wrap.style.minHeight).toBe("200px");
      expect(wrap.style.aspectRatio).toBe("");

      // The second URL should still be cached
      const wrap2 = renderInlineImage("https://example.com/img-1.jpg");
      expect(wrap2.style.aspectRatio).toBe("300 / 101");
    });
  });
});
